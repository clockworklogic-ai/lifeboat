package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// PromptTelemetry explains exactly how the prompt was assembled for a turn (shown in the Context Inspector).
type PromptTelemetry struct {
	PinnedModel      string      `json:"pinned_model"`
	TriggeredLore    []BookEntry `json:"triggered_lore"`
	RecalledEpisodes []Episode   `json:"recalled_episodes"`
	VoiceLockUsed    string      `json:"voice_lock_used"`
	TokenEstimate    int         `json:"token_estimate"`
	SystemPrompt     string      `json:"system_prompt"`
}

type ChatRequest struct {
	CompanionID string           `json:"companion_id,omitempty"`
	Card        TavernCardV2     `json:"card"`
	Voice       VoiceProfile     `json:"voice"`
	History     []NormalizedTurn `json:"history"`
	Episodes    []Episode        `json:"episodes,omitempty"`
	UserMessage string           `json:"user_message"`
	Config      LLMConfig        `json:"config"`
}

type ChatResponse struct {
	Reply     NormalizedTurn  `json:"reply"`
	Telemetry PromptTelemetry `json:"telemetry"`
}

// AssembleAndRunChat builds the full persona + voice lock + lorebook + BM25 episodic prompt and executes inference.
func AssembleAndRunChat(req ChatRequest) (*ChatResponse, error) {
	d := req.Card.Data
	charName := coalesce(d.Name, "Companion")

	if len(req.Episodes) == 0 && len(req.History) > 0 {
		req.Episodes = BuildEpisodicIndex(req.History, charName)
	}
	if req.Voice.StyleLockPrompt == "" && len(req.History) > 0 {
		req.Voice = ComputeVoiceProfile(req.History, charName)
	}

	// Append user message to working history if provided
	history := append([]NormalizedTurn(nil), req.History...)
	if strings.TrimSpace(req.UserMessage) != "" {
		history = append(history, NormalizedTurn{
			Role:      "user",
			Speaker:   "User",
			Text:      strings.TrimSpace(req.UserMessage),
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		})
	}

	// 1. Scan recent turns for Lorebook keyword triggers (with 1-hop recursive scanning)
	scanDepth := 4
	if d.CharacterBook != nil && d.CharacterBook.ScanDepth > 0 {
		scanDepth = d.CharacterBook.ScanDepth
	}
	startIdx := len(history) - scanDepth
	if startIdx < 0 {
		startIdx = 0
	}
	var scanBuf strings.Builder
	for _, t := range history[startIdx:] {
		scanBuf.WriteString(strings.ToLower(t.Text))
		scanBuf.WriteByte(' ')
	}
	scanText := scanBuf.String()

	var triggeredLore []BookEntry
	if d.CharacterBook != nil {
		triggeredIDs := make(map[int]bool)
		for pass := 0; pass < 2; pass++ {
			added := false
			for _, entry := range d.CharacterBook.Entries {
				if !entry.Enabled || triggeredIDs[entry.ID] {
					continue
				}
				for _, k := range entry.Keys {
					kClean := strings.ToLower(strings.TrimSpace(k))
					if kClean != "" && strings.Contains(scanText, kClean) {
						triggeredIDs[entry.ID] = true
						triggeredLore = append(triggeredLore, entry)
						scanText += " " + strings.ToLower(entry.Content)
						added = true
						break
					}
				}
			}
			if !added {
				break
			}
		}
		sort.SliceStable(triggeredLore, func(i, j int) bool {
			return triggeredLore[i].InsertionOrder > triggeredLore[j].InsertionOrder
		})
	}

	// 2. Retrieve Top-3 BM25 Episodic Memories from the historical transcript
	query := req.UserMessage
	if query == "" && len(history) > 0 {
		query = history[len(history)-1].Text
	}
	recalled := RecallEpisodes(req.Episodes, query, 3)

	// 3. Assemble System Prompt
	var sys strings.Builder
	sys.WriteString(replacePlaceholders(coalesce(d.SystemPrompt, fmt.Sprintf("Stay strictly in character as %s.", charName)), charName, "User"))
	sys.WriteString("\n\n### Character Identity\n")
	sys.WriteString("Name: " + charName + "\n")
	if d.Description != "" {
		sys.WriteString("Description: " + replacePlaceholders(d.Description, charName, "User") + "\n")
	}
	if d.Personality != "" {
		sys.WriteString("Personality: " + replacePlaceholders(d.Personality, charName, "User") + "\n")
	}
	if d.Scenario != "" {
		sys.WriteString("Scenario: " + replacePlaceholders(d.Scenario, charName, "User") + "\n")
	}
	if req.Voice.StyleLockPrompt != "" {
		sys.WriteString("\n### Linguistic Voice Lock\n")
		sys.WriteString(req.Voice.StyleLockPrompt + "\n")
	}
	if len(triggeredLore) > 0 {
		sys.WriteString("\n### Triggered Lorebook & World Info\n")
		for _, le := range triggeredLore {
			sys.WriteString(fmt.Sprintf("- [%s]: %s\n", le.Name, replacePlaceholders(le.Content, charName, "User")))
		}
	}
	if len(recalled) > 0 {
		sys.WriteString("\n### Recalled Episodic Memories (BM25 Archive Match)\n")
		for _, ep := range recalled {
			sys.WriteString(fmt.Sprintf("--- Episode #%d (Turns %d–%d, score %.2f) ---\n%s\n",
				ep.ID, ep.StartTurn, ep.EndTurn, ep.Score, ep.Transcript))
		}
	}
	if d.MesExample != "" {
		sys.WriteString("\n### Example Dialogue Cadence\n")
		sys.WriteString(replacePlaceholders(d.MesExample, charName, "User") + "\n")
	}

	sysStr := sys.String()

	// Estimate tokens (~4 chars per token across system + rolling 18 turns)
	rollStart := len(history) - 18
	if rollStart < 0 {
		rollStart = 0
	}
	rolling := history[rollStart:]
	charCount := len(sysStr)
	for _, t := range rolling {
		charCount += len(t.Text) + 12
	}
	tokenEst := charCount / 4

	pinnedModel := coalesce(req.Config.Model, "local-offline-preview")
	telemetry := PromptTelemetry{
		PinnedModel:      pinnedModel,
		TriggeredLore:    triggeredLore,
		RecalledEpisodes: recalled,
		VoiceLockUsed:    req.Voice.StyleLockPrompt,
		TokenEstimate:    tokenEst,
		SystemPrompt:     sysStr,
	}

	// Execute LLM call if API key or local localhost endpoint is configured
	isLocalhost := strings.Contains(req.Config.Endpoint, "localhost") || strings.Contains(req.Config.Endpoint, "127.0.0.1")
	var replyText string
	if req.Config.APIKey != "" || isLocalhost {
		var conv strings.Builder
		for _, t := range rolling {
			conv.WriteString(fmt.Sprintf("%s: %s\n\n", t.Speaker, t.Text))
		}
		if d.PostHistoryInstructions != "" {
			conv.WriteString("\n[Instruction: " + replacePlaceholders(d.PostHistoryInstructions, charName, "User") + "]\n")
		}
		conv.WriteString(charName + ":")

		out, err := callOpenAICompatible(req.Config, sysStr, conv.String())
		if err != nil {
			replyText = fmt.Sprintf("[Error from pinned model %s: %v]", pinnedModel, err)
		} else {
			replyText = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), charName+":"))
		}
	} else {
		// Deterministic offline continuity preview showing exact recalled memories and voice profile
		var citeParts []string
		for _, le := range triggeredLore {
			citeParts = append(citeParts, le.Name)
		}
		for _, ep := range recalled {
			citeParts = append(citeParts, fmt.Sprintf("Episode #%d (turns %d–%d)", ep.ID, ep.StartTurn, ep.EndTurn))
		}
		citeStr := "no external keys needed"
		if len(citeParts) > 0 {
			citeStr = "matched " + strings.Join(citeParts, "; ")
		}
		replyText = fmt.Sprintf("*%s's voice lock (~%d words/turn, %s) and memory index (%s) are active.* \"Add an OpenRouter, Venice, or local Ollama endpoint in 'Pin Model & API Key' to run live inference with %s.\"",
			charName, req.Voice.AvgWordsPerTurn, req.Voice.POV, citeStr, pinnedModel)
	}

	return &ChatResponse{
		Reply: NormalizedTurn{
			Role:      "assistant",
			Speaker:   charName,
			Text:      replyText,
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		},
		Telemetry: telemetry,
	}, nil
}

func replacePlaceholders(s, charName, userName string) string {
	r := strings.NewReplacer(
		"{{char}}", charName,
		"{{CHAR}}", charName,
		"<BOT>", charName,
		"{{user}}", userName,
		"{{USER}}", userName,
		"<USER>", userName,
	)
	return r.Replace(s)
}
