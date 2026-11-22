package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const sampleCAIJSON = `{
  "character": {
    "name": "Kaelen Vance",
    "description": "Archivist of the Glass Observatory in New Harbour.",
    "greeting": "*He looks up from a stack of salt-stained star charts.* \"You're late.\""
  },
  "histories": {
    "histories": [
      {
        "msgs": [
          { "src": { "name": "Kaelen Vance", "is_human": false }, "text": "*He looks up from a stack of salt-stained star charts.* \"You're late to New Harbour.\"" },
          { "src": { "name": "User", "is_human": true }, "text": "I brought the cipher ledger from Alderman Thorne in New Harbour." },
          { "src": { "name": "Kaelen Vance", "is_human": false }, "text": "*His fingers pause over the brass astrolabe.* \"Thorne never parts with a ledger unless the Observatory is compromised. Show me the Eclipse seal.\"" },
          { "src": { "name": "User", "is_human": true }, "text": "Only the wax seal of the Eclipse Syndicate remained." },
          { "src": { "name": "Kaelen Vance", "is_human": false }, "text": "*He locks the Observatory shutter.* \"Then the Eclipse Syndicate already knows our coordinates.\"" }
        ]
      }
    ]
  }
}`

const sampleReplikaJSON = `{
  "bot_name": "Clara",
  "bio": "Always curious, loves late-night synthwave and astronomy.",
  "chat_history": [
    { "sender": "bot", "text": "Hey! Did you catch the Perseids meteor shower over Kingston last night?" },
    { "sender": "user", "text": "Yeah, watched from Kingston waterfront until 2am." },
    { "sender": "bot", "text": "*smiles warmly* Kingston waterfront is the best spot when the city lights dim." },
    { "sender": "user", "text": "We should bring the telescope next time." }
  ]
}`

const sampleSillyTavernJSONL = `{"user_name":"Alex","character_name":"Mirai"}
{"name":"Mirai","is_user":false,"mes":"*Adjusts her headset inside Sector Seven.* \"Signal locked, Alex.\""}
{"name":"Alex","is_user":true,"mes":"Are the drones still patrolling Sector Seven?"}
{"name":"Mirai","is_user":false,"mes":"*She taps the holo screen.* \"Two patrols left in Sector Seven, moving east.\""}
`

const sampleChatGPTConversations = `[
  {
    "title": "Solstice (4o Companion)",
    "mapping": {
      "node1": {
        "message": {
          "author": { "role": "system" },
          "content": { "parts": ["You are Solstice, an empathetic creative partner helping write Project Helios."] },
          "create_time": 1740000100
        }
      },
      "node2": {
        "message": {
          "author": { "role": "user" },
          "content": { "parts": ["Solstice, we need to fix Act II of Project Helios at Kyoto station."] },
          "create_time": 1740000200
        }
      },
      "node3": {
        "message": {
          "author": { "role": "assistant" },
          "content": { "parts": ["*leans against the doorframe* \"Make Elena keep her brother's broken watch hidden in her coat on the train to Kyoto station.\""] },
          "create_time": 1740000300
        }
      }
    }
  }
]`

func TestParseCharacterAIAndLorebook(t *testing.T) {
	res, err := ParseExport([]byte(sampleCAIJSON), "")
	if err != nil {
		t.Fatalf("ParseExport failed: %v", err)
	}
	EnrichImportResult(res)
	if res.SourceFormat != "character_ai" {
		t.Fatalf("got format %q, want character_ai", res.SourceFormat)
	}
	if res.Card.Data.Name != "Kaelen Vance" {
		t.Fatalf("got name %q, want Kaelen Vance", res.Card.Data.Name)
	}
	if res.Stats.TotalTurns != 5 {
		t.Fatalf("got %d turns, want 5", res.Stats.TotalTurns)
	}
	if res.Voice.ActionRatio < 0.9 {
		t.Fatalf("expected high ActionRatio for asterisk-heavy character, got %v", res.Voice.ActionRatio)
	}
	if res.Card.Data.CharacterBook == nil || len(res.Card.Data.CharacterBook.Entries) == 0 {
		t.Fatalf("expected extracted lorebook entries, got 0")
	}

	foundEclipse := false
	for _, e := range res.Card.Data.CharacterBook.Entries {
		for _, k := range e.Keys {
			if strings.EqualFold(k, "eclipse") {
				foundEclipse = true
			}
		}
	}
	if !foundEclipse {
		t.Fatalf("expected 'eclipse' in extracted lorebook keys: %+v", res.Card.Data.CharacterBook.Entries)
	}
}

func TestParseReplikaAndJSONL(t *testing.T) {
	rep, err := ParseExport([]byte(sampleReplikaJSON), "")
	if err != nil {
		t.Fatalf("Replika parse failed: %v", err)
	}
	if rep.Card.Data.Name != "Clara" || rep.Stats.TotalTurns != 4 {
		t.Fatalf("unexpected Replika result: %+v", rep)
	}

	st, err := ParseExport([]byte(sampleSillyTavernJSONL), "")
	if err != nil {
		t.Fatalf("JSONL parse failed: %v", err)
	}
	if st.Card.Data.Name != "Mirai" || st.Stats.TotalTurns != 3 {
		t.Fatalf("unexpected JSONL result: %+v", st)
	}
}

func TestChatGPTConversationsExport(t *testing.T) {
	results, err := ParseArchiveOrFile([]byte(sampleChatGPTConversations), "conversations.json")
	if err != nil || len(results) != 1 {
		t.Fatalf("ChatGPT export parse failed: err=%v len=%d", err, len(results))
	}
	r := results[0]
	if r.SourceFormat != "chatgpt_export" {
		t.Fatalf("got format %q, want chatgpt_export", r.SourceFormat)
	}
	if r.Card.Data.Name != "Solstice (4o Companion)" {
		t.Fatalf("got name %q", r.Card.Data.Name)
	}
	if !strings.Contains(r.Card.Data.Description, "Project Helios") {
		t.Fatalf("expected system prompt preserved in description, got %q", r.Card.Data.Description)
	}
}

func TestZipArchiveIngest(t *testing.T) {
	// 1. Build a Replika bundle zip (chat_history.json + memory.json + diary.json)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	f1, _ := zw.Create("chat_history.json")
	_, _ = f1.Write([]byte(sampleReplikaJSON))

	f2, _ := zw.Create("memory.json")
	_, _ = f2.Write([]byte(`{"facts":[{"text":"User lives in Ottawa and fosters rescue cats"}]}`))

	f3, _ := zw.Create("diary.json")
	_, _ = f3.Write([]byte(`[{"title":"Perseids Night","text":"We talked about watching meteors over Kingston."}]`))
	_ = zw.Close()

	results, err := ParseArchiveOrFile(buf.Bytes(), "replika-export.zip")
	if err != nil || len(results) != 1 {
		t.Fatalf("ParseArchiveOrFile zip failed: err=%v len=%d", err, len(results))
	}
	res := results[0]
	if res.SourceFormat != "replika_bundle" {
		t.Fatalf("expected replika_bundle, got %q", res.SourceFormat)
	}
	foundFact := false
	for _, entry := range res.Card.Data.CharacterBook.Entries {
		if strings.Contains(entry.Content, "fosters rescue cats") {
			foundFact = true
		}
	}
	if !foundFact {
		t.Fatalf("expected memory.json facts in lorebook, got %+v", res.Card.Data.CharacterBook.Entries)
	}
}

func TestBM25EpisodicRecall(t *testing.T) {
	var turns []NormalizedTurn
	for i := 0; i < 24; i++ {
		text := "Ordinary weather report along the eastern pier."
		if i == 3 {
			text = "We hid the obsidian chronometer inside the lighthouse basement under the spiral stairs."
		}
		if i == 19 {
			text = "CommanderVex ordered the submarine fleet to submerge near Azores trench."
		}
		role := "user"
		spk := "User"
		if i%2 == 1 {
			role = "assistant"
			spk = "Kaelen"
		}
		turns = append(turns, NormalizedTurn{Role: role, Speaker: spk, Text: text})
	}
	eps := BuildEpisodicIndex(turns, "Kaelen")
	if len(eps) < 3 {
		t.Fatalf("expected >= 3 episodes, got %d", len(eps))
	}
	recalled := RecallEpisodes(eps, "where did we hide the obsidian chronometer in the lighthouse?", 2)
	if len(recalled) == 0 {
		t.Fatalf("expected BM25 match for obsidian chronometer")
	}
	if !strings.Contains(recalled[0].Transcript, "obsidian chronometer") {
		t.Fatalf("top BM25 episode did not contain target phrase: %+v", recalled[0])
	}
}

func TestTavernPNGV2AndV3RoundTrip(t *testing.T) {
	res, err := ParseExport([]byte(sampleCAIJSON), "")
	if err != nil {
		t.Fatalf("ParseExport failed: %v", err)
	}
	EnrichImportResult(res)
	pngBytes, err := EncodeTavernPNG(res.Card)
	if err != nil {
		t.Fatalf("EncodeTavernPNG failed: %v", err)
	}
	decoded, err := DecodeTavernPNG(pngBytes)
	if err != nil {
		t.Fatalf("DecodeTavernPNG failed: %v", err)
	}
	if decoded.Spec != "chara_card_v2" {
		t.Fatalf("got spec %q, want chara_card_v2", decoded.Spec)
	}
	if decoded.Data.Name != "Kaelen Vance" {
		t.Fatalf("round-trip name mismatch: got %q", decoded.Data.Name)
	}
	if len(decoded.Data.CharacterBook.Entries) != len(res.Card.Data.CharacterBook.Entries) {
		t.Fatalf("round-trip lorebook count mismatch")
	}
}

func TestVaultChatAndDistillEndpoints(t *testing.T) {
	vault, err := NewVault(t.TempDir())
	if err != nil {
		t.Fatalf("NewVault failed: %v", err)
	}
	srv := httptest.NewServer(newMux(vault))
	defer srv.Close()

	// 1. Ingest Character.AI export into vault
	resp, err := http.Post(srv.URL+"/api/parse", "application/json", strings.NewReader(sampleCAIJSON))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("/api/parse failed: %v status=%d", err, resp.StatusCode)
	}
	var parsed CompanionRecord
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		t.Fatalf("decode /api/parse: %v", err)
	}
	_ = resp.Body.Close()
	if parsed.ID == "" {
		t.Fatalf("expected non-empty vault ID")
	}

	// 2. Test /api/chat with Lorebook + BM25 episodic recall
	chatReq := ChatRequest{
		CompanionID: parsed.ID,
		Card:        parsed.Card,
		Voice:       parsed.Voice,
		History:     parsed.History,
		Episodes:    parsed.Episodes,
		UserMessage: "What does the Eclipse Syndicate know about Alderman Thorne's ledger?",
	}
	chatBytes, _ := json.Marshal(chatReq)
	resp, err = http.Post(srv.URL+"/api/chat", "application/json", bytes.NewReader(chatBytes))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("/api/chat failed: %v status=%d", err, resp.StatusCode)
	}
	var chatOut ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatOut); err != nil {
		t.Fatalf("decode /api/chat: %v", err)
	}
	_ = resp.Body.Close()
	if len(chatOut.Telemetry.TriggeredLore) == 0 {
		t.Fatalf("expected triggered lorebook entries on 'Eclipse Syndicate'")
	}
	if len(chatOut.Telemetry.RecalledEpisodes) == 0 {
		t.Fatalf("expected recalled BM25 episodes")
	}

	// 3. Test /api/search across the vault
	resp, err = http.Get(srv.URL + "/api/search?q=astrolabe")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("/api/search failed: %v", err)
	}
	var hits []SearchHit
	_ = json.NewDecoder(resp.Body).Decode(&hits)
	_ = resp.Body.Close()
	if len(hits) == 0 {
		t.Fatalf("expected search hits for 'astrolabe'")
	}

	// 4. Test /api/distill against a mock LLM server
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [{
				"message": {
					"content": "{\"description\":\"Master Archivist of New Harbour.\",\"personality\":\"Dry, observant, fiercely protective of the Observatory.\",\"scenario\":\"Locked inside the Glass Observatory before dawn.\",\"lorebook\":[{\"name\":\"Brass Astrolabe\",\"keys\":[\"astrolabe\"],\"content\":\"Calibrated to the New Harbour meridian.\"}]}"
				}
			}]
		}`))
	}))
	defer mockLLM.Close()

	distillBody, _ := json.Marshal(map[string]any{
		"companion_id": parsed.ID,
		"card":         parsed.Card,
		"history":      parsed.History,
		"config": LLMConfig{
			Endpoint: mockLLM.URL,
			Model:    "mock-distiller",
			APIKey:   "test-key",
		},
	})
	resp, err = http.Post(srv.URL+"/api/distill", "application/json", bytes.NewReader(distillBody))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("/api/distill failed: %v status=%d", err, resp.StatusCode)
	}
	var distilled ImportResult
	_ = json.NewDecoder(resp.Body).Decode(&distilled)
	_ = resp.Body.Close()
	if distilled.Card.Data.Description != "Master Archivist of New Harbour." {
		t.Fatalf("unexpected distilled description: %q", distilled.Card.Data.Description)
	}
}

func TestEncryptedCAIGDPRMessageJSON(t *testing.T) {
	entries := map[string][]byte{
		"alice/data/character.json": []byte(`[{"external_id":"bot-9","name":"Vesper","description":"Harbor lantern keeper.","greeting":"*Trims wick.* Storm ahead."}]`),
		"alice/data/message.json": []byte(`[
			{"chat_id":"ch-1","character_id":"bot-9","create_time":"2026-01-10T10:02:00Z","raw_content":"Did the boat arrive?"},
			{"chat_id":"ch-1","character_id":"bot-9","create_time":"2026-01-10T10:00:00Z","raw_content":"*Trims wick.* Storm ahead."},
			{"chat_id":"ch-1","character_id":"bot-9","create_time":"2026-01-10T10:03:00Z","raw_content":"*Nods.* Barely made New Harbour pier."}
		]`),
		"alice/data/user.json": []byte(`{"username":"alice","name":"Alice"}`),
	}
	zipBytes, err := writeZipCryptoTestArchive(entries, "alice@example.com")
	if err != nil {
		t.Fatalf("writeZipCryptoTestArchive: %v", err)
	}

	if _, err := ParseArchiveOrFile(zipBytes, "cai-export.zip"); err == nil {
		t.Fatalf("expected password error without password")
	}
	if _, err := ParseArchiveOrFileWithPassword(zipBytes, "cai-export.zip", "wrong@example.com"); err == nil {
		t.Fatalf("expected wrong password error")
	}
	// Mixed-case email with whitespace should auto-retry trimmed lowercase
	results, err := ParseArchiveOrFileWithPassword(zipBytes, "cai-export.zip", "  Alice@Example.COM ")
	if err != nil || len(results) != 1 {
		t.Fatalf("encrypted C.AI parse failed: err=%v len=%d", err, len(results))
	}
	r := results[0]
	if r.Card.Data.Name != "Vesper" || r.Stats.TotalTurns != 3 {
		t.Fatalf("unexpected Vesper result: name=%q turns=%d", r.Card.Data.Name, r.Stats.TotalTurns)
	}
	if !strings.Contains(r.History[0].Text, "Storm ahead") {
		t.Fatalf("expected chronological sort with greeting first, got %q", r.History[0].Text)
	}
}

func TestChatGPTActiveBranchAndEditableContext(t *testing.T) {
	raw := `[
		{
			"title": "Solstice",
			"current_node": "n3",
			"mapping": {
				"n0": {
					"parent": null,
					"message": {
						"author": {"role": "system"},
						"content": {"content_type": "user_editable_context", "parts": []},
						"metadata": {"user_context_message_data": {"about_user_message": "Has a cat named Miso.", "about_model_message": "Be warm and unhurried."}}
					}
				},
				"n1": {"parent": "n0", "message": {"author": {"role": "user"}, "create_time": 1750000100, "content": {"parts": ["Hello Solstice"]}}},
				"n2_dead": {"parent": "n1", "message": {"author": {"role": "assistant"}, "create_time": 1750000110, "content": {"parts": ["DEAD BRANCH MUST NOT APPEAR"]}}},
				"n2": {"parent": "n1", "message": {"author": {"role": "assistant"}, "create_time": 1750000120, "content": {"parts": ["Hey, how is Miso?"]}}},
				"n3": {"parent": "n2", "message": {"author": {"role": "user"}, "create_time": 1750000130, "content": {"parts": ["Asleep on my desk."]}}}
			}
		}
	]`
	results, err := ParseArchiveOrFile([]byte(raw), "conversations.json")
	if err != nil || len(results) != 1 {
		t.Fatalf("active branch parse failed: err=%v len=%d", err, len(results))
	}
	r := results[0]
	if len(r.History) != 3 {
		t.Fatalf("expected 3 active-branch turns (excluding dead branch), got %d", len(r.History))
	}
	for _, turn := range r.History {
		if strings.Contains(turn.Text, "DEAD BRANCH") {
			t.Fatalf("dead branch leaked into active timeline")
		}
	}
	if !strings.Contains(r.Card.Data.Description, "Miso") {
		t.Fatalf("expected user_editable_context preserved in description, got %q", r.Card.Data.Description)
	}
}
