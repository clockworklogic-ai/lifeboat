package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// TavernCardV2 follows the de-facto Character Card V2 specification (chara_card_v2).
type TavernCardV2 struct {
	Spec        string       `json:"spec"`
	SpecVersion string       `json:"spec_version"`
	Data        TavernDataV2 `json:"data"`
}

type TavernDataV2 struct {
	Name                    string         `json:"name"`
	Description             string         `json:"description"`
	Personality             string         `json:"personality"`
	Scenario                string         `json:"scenario"`
	FirstMes                string         `json:"first_mes"`
	MesExample              string         `json:"mes_example"`
	CreatorNotes            string         `json:"creator_notes"`
	SystemPrompt            string         `json:"system_prompt"`
	PostHistoryInstructions string         `json:"post_history_instructions"`
	AlternateGreetings      []string       `json:"alternate_greetings"`
	Tags                    []string       `json:"tags"`
	Creator                 string         `json:"creator"`
	CharacterVersion        string         `json:"character_version"`
	CharacterBook           *CharacterBook `json:"character_book,omitempty"`
	Extensions              map[string]any `json:"extensions,omitempty"`
}

type CharacterBook struct {
	Name              string      `json:"name"`
	Description       string      `json:"description"`
	ScanDepth         int         `json:"scan_depth"`
	TokenBudget       int         `json:"token_budget"`
	RecursiveScanning bool        `json:"recursive_scanning"`
	Entries           []BookEntry `json:"entries"`
}

type BookEntry struct {
	ID             int      `json:"id"`
	Keys           []string `json:"keys"`
	Content        string   `json:"content"`
	Enabled        bool     `json:"enabled"`
	InsertionOrder int      `json:"insertion_order"`
	CaseSensitive  bool     `json:"case_sensitive"`
	Name           string   `json:"name"`
	Priority       int      `json:"priority"`
	Position       string   `json:"position"`
}

type NormalizedTurn struct {
	Role      string `json:"role"` // "user" or "assistant"
	Speaker   string `json:"speaker"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp,omitempty"`
}

type ImportResult struct {
	SourceFormat string           `json:"source_format"`
	Card         TavernCardV2     `json:"card"`
	Voice        VoiceProfile     `json:"voice"`
	History      []NormalizedTurn `json:"history"`
	Episodes     []Episode        `json:"episodes,omitempty"`
	Stats        ImportStats      `json:"stats"`
	AvatarPNG    []byte           `json:"-"`
}

type ImportStats struct {
	TotalTurns       int `json:"total_turns"`
	CharacterTurns   int `json:"character_turns"`
	UserTurns        int `json:"user_turns"`
	TotalWords       int `json:"total_words"`
	LorebookEntries  int `json:"lorebook_entries"`
	ExampleDialogues int `json:"example_dialogues"`
	EpisodeCount     int `json:"episode_count"`
}

// ParseExport auto-detects Character.AI (GDPR export or CAI Tools), Replika, Tavern V2 JSON, or JSONL chat logs.
func ParseExport(raw []byte, fallbackName string) (*ImportResult, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("empty export input")
	}

	// Check if JSONL (multiple lines of JSON objects)
	if trimmed[0] == '{' && bytes.Contains(trimmed, []byte("\n{")) {
		return parseJSONL(trimmed, fallbackName)
	}

	var probe map[string]any
	if err := json.Unmarshal(trimmed, &probe); err == nil {
		// 1. Existing Tavern V2 card
		if spec, _ := probe["spec"].(string); spec == "chara_card_v2" {
			return parseTavernV2(trimmed)
		}
		// 2. Character.AI CAI Tools / official export with "histories" or "info"/"character"
		if _, ok := probe["histories"]; ok {
			return parseCAIHistories(probe, fallbackName)
		}
		// 3. Replika export ("chat_history" or "messages" with "sender"/"author")
		if _, ok := probe["chat_history"]; ok {
			return parseReplika(probe, fallbackName)
		}
		// 4. Generic / Character.AI single-chat export ("messages" or "turns")
		if _, ok := probe["turns"]; ok {
			return parseCAITurns(probe, fallbackName)
		}
		if _, ok := probe["messages"]; ok {
			return parseGenericMessages(probe, fallbackName)
		}
		// 5. Tavern V1 card (name, description, first_mes at top level)
		if name, ok := probe["name"].(string); ok && name != "" {
			if _, hasFirst := probe["first_mes"]; hasFirst {
				return parseTavernV1(probe)
			}
		}
	}

	// Check if top-level JSON array of turns/messages
	if trimmed[0] == '[' {
		var arr []map[string]any
		if err := json.Unmarshal(trimmed, &arr); err == nil {
			return parseMessageArray("json_array", arr, fallbackName, "User", "", "")
		}
	}

	return nil, fmt.Errorf("unrecognized companion export format")
}

func parseTavernV2(raw []byte) (*ImportResult, error) {
	var card TavernCardV2
	if err := json.Unmarshal(raw, &card); err != nil {
		return nil, err
	}
	if card.Data.CharacterBook == nil {
		card.Data.CharacterBook = &CharacterBook{
			Name:        card.Data.Name + " Lorebook",
			ScanDepth:   4,
			TokenBudget: 1024,
			Entries:     []BookEntry{},
		}
	}
	turns := []NormalizedTurn{}
	if card.Data.FirstMes != "" {
		turns = append(turns, NormalizedTurn{
			Role:    "assistant",
			Speaker: card.Data.Name,
			Text:    card.Data.FirstMes,
		})
	}
	return &ImportResult{
		SourceFormat: "tavern_v2",
		Card:         card,
		History:      turns,
		Stats: ImportStats{
			TotalTurns:      len(turns),
			CharacterTurns:  len(turns),
			LorebookEntries: len(card.Data.CharacterBook.Entries),
		},
	}, nil
}

func parseTavernV1(probe map[string]any) (*ImportResult, error) {
	name := strField(probe, "name", "Companion")
	desc := strField(probe, "description", "")
	pers := strField(probe, "personality", "")
	scen := strField(probe, "scenario", "")
	first := strField(probe, "first_mes", "")
	mesEx := strField(probe, "mes_example", "")

	card := buildCardFromParts(name, desc, pers, scen, first, mesEx, nil, "tavern_v1")
	turns := []NormalizedTurn{}
	if first != "" {
		turns = append(turns, NormalizedTurn{Role: "assistant", Speaker: name, Text: first})
	}
	return &ImportResult{
		SourceFormat: "tavern_v1",
		Card:         card,
		History:      turns,
		Stats: ImportStats{
			TotalTurns:      len(turns),
			CharacterTurns:  len(turns),
			LorebookEntries: len(card.Data.CharacterBook.Entries),
		},
	}, nil
}

func parseCAIHistories(probe map[string]any, fallbackName string) (*ImportResult, error) {
	charName := fallbackName
	desc := ""
	greeting := ""
	definition := ""

	if charObj, ok := probe["character"].(map[string]any); ok {
		charName = strField(charObj, "name", charName)
		desc = strField(charObj, "description", strField(charObj, "title", ""))
		greeting = strField(charObj, "greeting", "")
		definition = strField(charObj, "definition", "")
	} else if infoObj, ok := probe["info"].(map[string]any); ok {
		charName = strField(infoObj, "name", charName)
		desc = strField(infoObj, "description", "")
		greeting = strField(infoObj, "greeting", "")
	}
	if charName == "" {
		charName = strField(probe, "character_name", "Character")
	}

	var rawMsgs []map[string]any
	if hists, ok := probe["histories"].(map[string]any); ok {
		if inner, ok := hists["histories"].([]any); ok {
			for _, h := range inner {
				if hm, ok := h.(map[string]any); ok {
					if msgs, ok := hm["msgs"].([]any); ok {
						for _, m := range msgs {
							if mm, ok := m.(map[string]any); ok {
								rawMsgs = append(rawMsgs, mm)
							}
						}
					}
				}
			}
		}
	} else if histsArr, ok := probe["histories"].([]any); ok {
		for _, h := range histsArr {
			if hm, ok := h.(map[string]any); ok {
				if msgs, ok := hm["msgs"].([]any); ok {
					for _, m := range msgs {
						if mm, ok := m.(map[string]any); ok {
							rawMsgs = append(rawMsgs, mm)
						}
					}
				} else if turns, ok := hm["turns"].([]any); ok {
					for _, t := range turns {
						if tm, ok := t.(map[string]any); ok {
							rawMsgs = append(rawMsgs, tm)
						}
					}
				}
			}
		}
	}

	return parseMessageArray("character_ai", rawMsgs, charName, "User", desc, coalesce(greeting, definition))
}

func parseCAITurns(probe map[string]any, fallbackName string) (*ImportResult, error) {
	charName := strField(probe, "character_name", fallbackName)
	if charName == "" {
		charName = "Character"
	}
	desc := strField(probe, "description", "")
	var rawMsgs []map[string]any
	if turns, ok := probe["turns"].([]any); ok {
		for _, t := range turns {
			if tm, ok := t.(map[string]any); ok {
				rawMsgs = append(rawMsgs, tm)
			}
		}
	}
	return parseMessageArray("character_ai_turns", rawMsgs, charName, "User", desc, "")
}

func parseReplika(probe map[string]any, fallbackName string) (*ImportResult, error) {
	charName := strField(probe, "bot_name", strField(probe, "replika_name", fallbackName))
	if charName == "" {
		charName = "Replika"
	}
	var rawMsgs []map[string]any
	if ch, ok := probe["chat_history"].([]any); ok {
		for _, m := range ch {
			if mm, ok := m.(map[string]any); ok {
				rawMsgs = append(rawMsgs, mm)
			}
		}
	}
	return parseMessageArray("replika", rawMsgs, charName, "User", strField(probe, "bio", ""), "")
}

func parseGenericMessages(probe map[string]any, fallbackName string) (*ImportResult, error) {
	charName := strField(probe, "character_name", strField(probe, "name", fallbackName))
	if charName == "" {
		charName = "Companion"
	}
	desc := strField(probe, "description", strField(probe, "persona", ""))
	var rawMsgs []map[string]any
	if msgs, ok := probe["messages"].([]any); ok {
		for _, m := range msgs {
			if mm, ok := m.(map[string]any); ok {
				rawMsgs = append(rawMsgs, mm)
			}
		}
	}
	return parseMessageArray("messages_json", rawMsgs, charName, "User", desc, "")
}

func parseJSONL(raw []byte, fallbackName string) (*ImportResult, error) {
	lines := bytes.Split(raw, []byte("\n"))
	var rawMsgs []map[string]any
	charName := fallbackName
	for _, line := range lines {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			continue
		}
		// SillyTavern JSONL first line is metadata {"user_name":..., "character_name":...}
		if cn, ok := m["character_name"].(string); ok && cn != "" && m["mes"] == nil && m["text"] == nil {
			charName = cn
			continue
		}
		rawMsgs = append(rawMsgs, m)
	}
	if charName == "" {
		charName = "Companion"
	}
	return parseMessageArray("sillytavern_jsonl", rawMsgs, charName, "User", "", "")
}

func parseMessageArray(sourceFormat string, rawMsgs []map[string]any, charName, userName, explicitDesc, explicitGreeting string) (*ImportResult, error) {
	var turns []NormalizedTurn
	detectedCharName := charName

	for _, m := range rawMsgs {
		text := extractText(m)
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		role, speaker := extractRoleAndSpeaker(m, detectedCharName, userName)
		if role == "assistant" && speaker != "" && speaker != "Character" && speaker != "Companion" && speaker != "assistant" {
			detectedCharName = speaker
		}
		ts := extractTimestamp(m)
		turns = append(turns, NormalizedTurn{
			Role:      role,
			Speaker:   speaker,
			Text:      text,
			Timestamp: ts,
		})
	}

	if len(turns) == 0 && explicitDesc == "" && explicitGreeting == "" {
		return nil, fmt.Errorf("no valid conversation turns or character metadata found")
	}

	if detectedCharName == "" {
		detectedCharName = "Companion"
	}
	for i := range turns {
		if turns[i].Role == "assistant" && (turns[i].Speaker == "" || turns[i].Speaker == "Character" || turns[i].Speaker == "Companion") {
			turns[i].Speaker = detectedCharName
		}
	}

	firstMes := explicitGreeting
	if firstMes == "" {
		for _, t := range turns {
			if t.Role == "assistant" {
				firstMes = t.Text
				break
			}
		}
	}

	mesExample, exCount := buildExampleDialogue(turns, detectedCharName)
	distilledDesc, distilledPers, distilledScen := distillPersonaFromTurns(turns, detectedCharName, explicitDesc)
	book := extractLorebook(turns, detectedCharName)

	card := buildCardFromParts(detectedCharName, distilledDesc, distilledPers, distilledScen, firstMes, mesExample, book, sourceFormat)

	charTurns, userTurns, totalWords := 0, 0, 0
	for _, t := range turns {
		if t.Role == "assistant" {
			charTurns++
		} else {
			userTurns++
		}
		totalWords += len(strings.Fields(t.Text))
	}

	return &ImportResult{
		SourceFormat: sourceFormat,
		Card:         card,
		History:      turns,
		Stats: ImportStats{
			TotalTurns:       len(turns),
			CharacterTurns:   charTurns,
			UserTurns:        userTurns,
			TotalWords:       totalWords,
			LorebookEntries:  len(book.Entries),
			ExampleDialogues: exCount,
		},
	}, nil
}

func extractTimestamp(m map[string]any) string {
	keys := []string{
		"create_time", "created", "created_at", "createdAt", "created_time", "createTime",
		"send_date", "sent_at", "send_time", "timestamp", "date_unixtime", "date", "time",
		"ts", "datetime", "last_update_time", "update_time", "updated_at",
	}
	pick := func(obj map[string]any) string {
		if obj == nil {
			return ""
		}
		for _, k := range keys {
			v, ok := obj[k]
			if !ok || v == nil {
				continue
			}
			switch tv := v.(type) {
			case string:
				if s := strings.TrimSpace(tv); s != "" {
					return normalizeGoTimestamp(s)
				}
			case float64:
				if tv > 0 {
					return normalizeGoTimestamp(fmt.Sprintf("%.0f", tv))
				}
			}
		}
		return ""
	}
	if s := pick(m); s != "" {
		return s
	}
	if cand, ok := m["candidate"].(map[string]any); ok {
		if s := pick(cand); s != "" {
			return s
		}
	}
	if cands, ok := m["candidates"].([]any); ok && len(cands) > 0 {
		if c0, ok := cands[0].(map[string]any); ok {
			if s := pick(c0); s != "" {
				return s
			}
		}
	}
	return ""
}

func normalizeGoTimestamp(s string) string {
	s = strings.TrimSpace(s)
	// Normalize space-separated Postgres/Python ISO ("2024-05-29 10:20:48.049888+00:00")
	if len(s) >= 19 && s[4] == '-' && s[7] == '-' && s[10] == ' ' {
		s = s[:10] + "T" + s[11:]
	}
	return s
}

func extractText(m map[string]any) string {
	for _, k := range []string{"raw_content", "text", "mes", "content", "message", "body", "msg", "utterance"} {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	if cand, ok := m["candidate"].(map[string]any); ok {
		if s, ok := cand["raw_content"].(string); ok && s != "" {
			return s
		}
	}
	// Character.AI new turns format: candidates[0].raw_content
	if cands, ok := m["candidates"].([]any); ok && len(cands) > 0 {
		if c0, ok := cands[0].(map[string]any); ok {
			if s, ok := c0["raw_content"].(string); ok {
				return s
			}
		}
	}
	return ""
}

func extractRoleAndSpeaker(m map[string]any, charName, userName string) (string, string) {
	// SillyTavern JSONL: is_user bool, name string
	if isUser, ok := m["is_user"].(bool); ok {
		name := strField(m, "name", "")
		if isUser {
			return "user", coalesce(name, userName)
		}
		return "assistant", coalesce(name, charName)
	}
	// Flat is_human or legacy 2023 src__is_human flag
	for _, flagKey := range []string{"is_human", "src__is_human", "isHuman", "isUser", "from_user"} {
		if isHuman, ok := m[flagKey].(bool); ok {
			name := strField(m, "name", strField(m, "src__name", strField(m, "author_name", "")))
			if isHuman {
				return "user", coalesce(name, userName)
			}
			return "assistant", coalesce(name, charName)
		}
	}
	// Character.AI src.is_human / src.name
	if src, ok := m["src"].(map[string]any); ok {
		name := strField(src, "name", "")
		if isHuman, ok := src["is_human"].(bool); ok {
			if isHuman {
				return "user", coalesce(name, userName)
			}
			return "assistant", coalesce(name, charName)
		}
	}
	// Character.AI turns author.is_human / author.name
	if auth, ok := m["author"].(map[string]any); ok {
		name := strField(auth, "name", "")
		if isHuman, ok := auth["is_human"].(bool); ok {
			if isHuman {
				return "user", coalesce(name, userName)
			}
			return "assistant", coalesce(name, charName)
		}
	}
	// Replika / OpenAI style role or sender
	role := strings.ToLower(strField(m, "role", strField(m, "sender", strField(m, "author", ""))))
	speaker := strField(m, "name", strField(m, "speaker", ""))
	switch role {
	case "user", "human", "me", "you":
		return "user", coalesce(speaker, userName)
	case "assistant", "bot", "character", "ai", "replika":
		return "assistant", coalesce(speaker, charName)
	}
	if speaker != "" && !strings.EqualFold(speaker, userName) && !strings.EqualFold(speaker, "user") {
		return "assistant", speaker
	}
	return "user", userName
}

// buildExampleDialogue selects the highest-signal user->assistant exchanges for Tavern V2 mes_example.
func buildExampleDialogue(turns []NormalizedTurn, charName string) (string, int) {
	type pair struct {
		user  string
		char  string
		score int
	}
	var pairs []pair
	for i := 0; i+1 < len(turns); i++ {
		if turns[i].Role == "user" && turns[i+1].Role == "assistant" {
			u := turns[i].Text
			c := turns[i+1].Text
			if len(c) < 40 || len(c) > 900 {
				continue
			}
			score := len(c)
			// Prefer turns with roleplay actions (*...*) or dialogue ("...")
			if strings.Contains(c, "*") {
				score += 120
			}
			if strings.Contains(c, "\"") || strings.Contains(c, "“") {
				score += 80
			}
			pairs = append(pairs, pair{user: u, char: c, score: score})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		return pairs[i].score > pairs[j].score
	})
	limit := 4
	if len(pairs) < limit {
		limit = len(pairs)
	}
	var b strings.Builder
	for i := 0; i < limit; i++ {
		b.WriteString("<START>\n")
		b.WriteString("{{user}}: ")
		b.WriteString(pairs[i].user)
		b.WriteString("\n{{char}}: ")
		b.WriteString(pairs[i].char)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String()), limit
}

// distillPersonaFromTurns synthesizes a clean description, voice/personality profile, and scenario from the transcript.
func distillPersonaFromTurns(turns []NormalizedTurn, charName, explicitDesc string) (desc, pers, scen string) {
	var charTexts []string
	var actionCount, dialogueCount, totalWords int
	for _, t := range turns {
		if t.Role == "assistant" {
			charTexts = append(charTexts, t.Text)
			if strings.Contains(t.Text, "*") {
				actionCount++
			}
			if strings.Contains(t.Text, "\"") || strings.Contains(t.Text, "“") {
				dialogueCount++
			}
			totalWords += len(strings.Fields(t.Text))
		}
	}

	avgWords := 0
	if len(charTexts) > 0 {
		avgWords = totalWords / len(charTexts)
	}

	styleTraits := []string{}
	if len(charTexts) > 0 {
		if actionCount*2 >= len(charTexts) {
			styleTraits = append(styleTraits, "narrative roleplay with asterisk action beats")
		} else {
			styleTraits = append(styleTraits, "direct conversational cadence")
		}
		if avgWords > 90 {
			styleTraits = append(styleTraits, fmt.Sprintf("detailed multi-paragraph responses (~%d words/turn)", avgWords))
		} else if avgWords > 30 {
			styleTraits = append(styleTraits, fmt.Sprintf("balanced pacing (~%d words/turn)", avgWords))
		} else {
			styleTraits = append(styleTraits, fmt.Sprintf("concise, punchy replies (~%d words/turn)", avgWords))
		}
	}

	pers = strings.Join(styleTraits, "; ")
	if pers == "" {
		pers = "Consistent character voice preserved from exported history."
	}

	if explicitDesc != "" {
		desc = explicitDesc
	} else {
		desc = fmt.Sprintf("%s — reconstructed from %d exported conversation turns (%d total words). Voice profile: %s.",
			charName, len(turns), totalWords, pers)
	}

	if len(turns) >= 2 {
		lastIdx := len(turns) - 1
		lastTurn := turns[lastIdx]
		snippet := lastTurn.Text
		if len(snippet) > 220 {
			snippet = snippet[:220] + "..."
		}
		scen = fmt.Sprintf("Continuing an established history of %d turns with {{user}}. Most recent context (%s): %s",
			len(turns), lastTurn.Speaker, snippet)
	} else {
		scen = fmt.Sprintf("Ongoing conversation between %s and {{user}}.", charName)
	}

	return desc, pers, scen
}

var properNounRe = regexp.MustCompile(`\b[A-Z][a-z]{3,18}\b`)

var commonStopCapitalized = map[string]bool{
	"The": true, "This": true, "That": true, "There": true, "Their": true,
	"Then": true, "They": true, "What": true, "When": true, "Where": true,
	"Which": true, "While": true, "With": true, "Would": true, "Could": true,
	"Should": true, "Have": true, "Here": true, "From": true, "Into": true,
	"Just": true, "Like": true, "Look": true, "Looks": true, "Well": true,
	"Yeah": true, "Your": true, "User": true, "Character": true, "Companion": true,
	"Some": true, "Something": true, "Nothing": true, "Everything": true,
	"After": true, "Before": true, "About": true, "Around": true, "Because": true,
	"Still": true, "Never": true, "Always": true, "Maybe": true, "Really": true,
}

// extractLorebook scans the transcript for recurring proper nouns and memory anchors, turning them into Tavern V2 CharacterBook entries.
func extractLorebook(turns []NormalizedTurn, charName string) *CharacterBook {
	counts := make(map[string]int)
	samples := make(map[string][]string)

	for _, t := range turns {
		matches := properNounRe.FindAllString(t.Text, -1)
		seenInTurn := make(map[string]bool)
		for _, m := range matches {
			if commonStopCapitalized[m] || strings.EqualFold(m, charName) {
				continue
			}
			// Ignore if first word of sentence only once; recurring across turns is what matters
			if !seenInTurn[m] {
				counts[m]++
				seenInTurn[m] = true
				if len(samples[m]) < 2 {
					samples[m] = append(samples[m], BestSentenceContaining(t.Text, m))
				}
			}
		}
	}

	type candidate struct {
		word  string
		count int
	}
	var cands []candidate
	for w, c := range counts {
		if c >= 2 {
			cands = append(cands, candidate{word: w, count: c})
		}
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].count != cands[j].count {
			return cands[i].count > cands[j].count
		}
		return cands[i].word < cands[j].word
	})

	if len(cands) > 12 {
		cands = cands[:12]
	}

	entries := make([]BookEntry, 0, len(cands)+1)
	for i, c := range cands {
		entries = append(entries, BookEntry{
			ID:             i + 1,
			Name:           "Memory: " + c.word,
			Keys:           []string{strings.ToLower(c.word), c.word},
			Content:        fmt.Sprintf("Recurring reference (%dx in prior history) to %s: %s", c.count, c.word, strings.Join(samples[c.word], " / ")),
			Enabled:        true,
			InsertionOrder: 100 - i,
			Priority:       10,
			Position:       "before_char",
		})
	}

	// Always add a summary memory anchor of the latest turns if history has >= 4 turns
	if len(turns) >= 4 {
		start := len(turns) - 4
		var recent []string
		for _, t := range turns[start:] {
			snippet := t.Text
			if len(snippet) > 160 {
				snippet = snippet[:160] + "..."
			}
			recent = append(recent, fmt.Sprintf("%s: %s", t.Speaker, snippet))
		}
		entries = append(entries, BookEntry{
			ID:             len(entries) + 1,
			Name:           "Recent Continuity Anchor",
			Keys:           []string{"remember", "last time", "before", "earlier", strings.ToLower(charName)},
			Content:        "Recent turns before migration:\n" + strings.Join(recent, "\n"),
			Enabled:        true,
			InsertionOrder: 110,
			Priority:       20,
			Position:       "after_char",
		})
	}

	return &CharacterBook{
		Name:              charName + " Extracted Lorebook",
		Description:       "Automatically distilled from exported companion history by Lifeboat.",
		ScanDepth:         4,
		TokenBudget:       1024,
		RecursiveScanning: false,
		Entries:           entries,
	}
}

func BestSentenceContaining(text, word string) string {
	sentences := strings.FieldsFunc(text, func(r rune) bool {
		return r == '.' || r == '!' || r == '?' || r == '\n'
	})
	for _, s := range sentences {
		if strings.Contains(s, word) {
			s = strings.TrimSpace(s)
			if len(s) > 180 {
				return s[:180] + "..."
			}
			return s
		}
	}
	if len(text) > 180 {
		return strings.TrimSpace(text[:180]) + "..."
	}
	return strings.TrimSpace(text)
}

func buildCardFromParts(name, desc, pers, scen, firstMes, mesEx string, book *CharacterBook, source string) TavernCardV2 {
	if book == nil {
		book = &CharacterBook{
			Name:        name + " Lorebook",
			ScanDepth:   4,
			TokenBudget: 1024,
			Entries:     []BookEntry{},
		}
	}
	sysPrompt := fmt.Sprintf("Stay strictly in character as %s. Preserve the established tone, pacing, and shared history with {{user}}. Never break character or insert meta-commentary.", name)
	return TavernCardV2{
		Spec:        "chara_card_v2",
		SpecVersion: "2.0",
		Data: TavernDataV2{
			Name:                    name,
			Description:             desc,
			Personality:             pers,
			Scenario:                scen,
			FirstMes:                firstMes,
			MesExample:              mesEx,
			CreatorNotes:            "Migrated via Lifeboat (" + source + ")",
			SystemPrompt:            sysPrompt,
			PostHistoryInstructions: "Maintain continuity with the CharacterBook memory entries and prior tone.",
			AlternateGreetings:      []string{},
			Tags:                    []string{"lifeboat", source},
			Creator:                 "Lifeboat",
			CharacterVersion:        "1.0",
			CharacterBook:           book,
		},
	}
}

func strField(m map[string]any, key, def string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			// Clean control chars except newline/tab
			return strings.Map(func(r rune) rune {
				if r == '\n' || r == '\t' || !unicode.IsControl(r) {
					return r
				}
				return -1
			}, s)
		}
	}
	return def
}

func coalesce(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
