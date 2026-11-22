package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
)

// VoiceProfile captures the statistical linguistic fingerprint of the companion's original turns.
type VoiceProfile struct {
	AvgWordsPerTurn    int      `json:"avg_words_per_turn"`
	MedianWordsPerTurn int      `json:"median_words_per_turn"`
	ActionRatio        float64  `json:"action_ratio"`   // 0..1 share of turns with *asterisk* action narration
	DialogueRatio      float64  `json:"dialogue_ratio"` // 0..1 share of turns with "quoted" speech
	QuestionRatio      float64  `json:"question_ratio"` // 0..1 share of turns ending or containing ?
	POV                string   `json:"pov"`            // "first-person", "third-person", or "second-person/mixed"
	TopPhrases         []string `json:"top_phrases"`    // Characteristic 2-grams / 3-grams
	StyleLockPrompt    string   `json:"style_lock_prompt"`
}

// Episode is a contiguous scene chunk from the imported transcript, indexed for BM25 long-term recall.
type Episode struct {
	ID         int      `json:"id"`
	StartTurn  int      `json:"start_turn"`
	EndTurn    int      `json:"end_turn"`
	Keywords   []string `json:"keywords"`
	Summary    string   `json:"summary"`
	Transcript string   `json:"transcript"`
	Score      float64  `json:"score,omitempty"`
}

// EnrichImportResult attaches the statistical VoiceProfile, StyleLockPrompt, and BM25 episodic index to an ImportResult.
func EnrichImportResult(res *ImportResult) {
	if res == nil {
		return
	}
	vp := ComputeVoiceProfile(res.History, res.Card.Data.Name)
	res.Voice = vp
	res.Episodes = BuildEpisodicIndex(res.History, res.Card.Data.Name)
	res.Stats.EpisodeCount = len(res.Episodes)

	if vp.StyleLockPrompt != "" {
		res.Card.Data.PostHistoryInstructions = vp.StyleLockPrompt
		if !strings.Contains(res.Card.Data.SystemPrompt, "Voice Lock:") {
			res.Card.Data.SystemPrompt = strings.TrimSpace(res.Card.Data.SystemPrompt + "\n\nVoice Lock: " + vp.StyleLockPrompt)
		}
	}
}

func ComputeVoiceProfile(turns []NormalizedTurn, charName string) VoiceProfile {
	var lengths []int
	var totalWords, actionTurns, dialogueTurns, questionTurns int
	var firstPersonPronouns, thirdPersonPronouns int
	ngramCounts := make(map[string]int)

	for _, t := range turns {
		if t.Role != "assistant" {
			continue
		}
		words := strings.Fields(t.Text)
		wCount := len(words)
		if wCount == 0 {
			continue
		}
		lengths = append(lengths, wCount)
		totalWords += wCount

		if strings.Contains(t.Text, "*") {
			actionTurns++
		}
		if strings.Contains(t.Text, "\"") || strings.Contains(t.Text, "“") {
			dialogueTurns++
		}
		if strings.Contains(t.Text, "?") {
			questionTurns++
		}

		// Tokenize clean lowercase words for POV and n-grams
		clean := tokenizeWords(t.Text)
		for _, w := range clean {
			switch w {
			case "i", "me", "my", "mine", "myself":
				firstPersonPronouns++
			case "he", "him", "his", "she", "her", "hers", "they", "them", "their":
				thirdPersonPronouns++
			}
		}

		seenInTurn := make(map[string]bool)
		for i := 0; i+1 < len(clean); i++ {
			w1, w2 := clean[i], clean[i+1]
			if len(w1) < 3 && len(w2) < 3 {
				continue
			}
			if isTrivialStopPair(w1, w2) {
				continue
			}
			bg := w1 + " " + w2
			if !seenInTurn[bg] {
				ngramCounts[bg]++
				seenInTurn[bg] = true
			}
		}
	}

	n := len(lengths)
	if n == 0 {
		return VoiceProfile{
			POV:             "mixed",
			StyleLockPrompt: fmt.Sprintf("Stay strictly in character as %s.", charName),
		}
	}

	sort.Ints(lengths)
	avg := totalWords / n
	median := lengths[n/2]
	actRatio := math.Round((float64(actionTurns)/float64(n))*100) / 100
	dlgRatio := math.Round((float64(dialogueTurns)/float64(n))*100) / 100
	qRatio := math.Round((float64(questionTurns)/float64(n))*100) / 100

	pov := "first-person ('I/my') dialogue with third-person action narration"
	if thirdPersonPronouns > firstPersonPronouns*2 {
		pov = "third-person narrative POV ('he/she/they')"
	} else if firstPersonPronouns > thirdPersonPronouns*2 {
		pov = "direct first-person POV ('I/me/my')"
	}

	type ngPair struct {
		phrase string
		count  int
	}
	var topNG []ngPair
	for p, c := range ngramCounts {
		if c >= 2 {
			topNG = append(topNG, ngPair{p, c})
		}
	}
	sort.Slice(topNG, func(i, j int) bool {
		if topNG[i].count != topNG[j].count {
			return topNG[i].count > topNG[j].count
		}
		return topNG[i].phrase < topNG[j].phrase
	})
	var phrases []string
	for i := 0; i < len(topNG) && i < 6; i++ {
		phrases = append(phrases, topNG[i].phrase)
	}

	actionRule := "Use plain conversational text without asterisk stage directions."
	if actRatio >= 0.5 {
		actionRule = "Wrap physical actions, expressions, and sensory beats in *asterisks* and spoken lines in \"double quotes\"."
	} else if actRatio >= 0.2 {
		actionRule = "Use occasional *asterisk* action beats alongside spoken dialogue."
	}

	phraseNote := ""
	if len(phrases) > 0 {
		phraseNote = fmt.Sprintf(" Recurring motifs/phrases from history: %s.", strings.Join(phrases, ", "))
	}

	lock := fmt.Sprintf("Target ~%d words per response (median %d). Use %s. %s%s",
		avg, median, pov, actionRule, phraseNote)

	return VoiceProfile{
		AvgWordsPerTurn:    avg,
		MedianWordsPerTurn: median,
		ActionRatio:        actRatio,
		DialogueRatio:      dlgRatio,
		QuestionRatio:      qRatio,
		POV:                pov,
		TopPhrases:         phrases,
		StyleLockPrompt:    lock,
	}
}

// BuildEpisodicIndex segments the conversation into overlapping 10-turn scenes for BM25 retrieval.
func BuildEpisodicIndex(turns []NormalizedTurn, charName string) []Episode {
	if len(turns) == 0 {
		return nil
	}
	const window = 8
	const stride = 6

	var episodes []Episode
	epID := 1
	for start := 0; start < len(turns); start += stride {
		end := start + window
		if end > len(turns) {
			end = len(turns)
		}
		slice := turns[start:end]
		var lines []string
		kwSet := make(map[string]bool)
		var kws []string

		for _, t := range slice {
			lines = append(lines, fmt.Sprintf("%s: %s", t.Speaker, t.Text))
			for _, m := range properNounRe.FindAllString(t.Text, -1) {
				if !commonStopCapitalized[m] && !strings.EqualFold(m, charName) && !kwSet[strings.ToLower(m)] {
					kwSet[strings.ToLower(m)] = true
					kws = append(kws, m)
				}
			}
		}

		firstLine := slice[0].Text
		if len(firstLine) > 100 {
			firstLine = firstLine[:100] + "..."
		}
		lastLine := slice[len(slice)-1].Text
		if len(lastLine) > 100 {
			lastLine = lastLine[:100] + "..."
		}
		summary := fmt.Sprintf("Turns %d–%d: %s → %s", start+1, end, firstLine, lastLine)

		episodes = append(episodes, Episode{
			ID:         epID,
			StartTurn:  start + 1,
			EndTurn:    end,
			Keywords:   kws,
			Summary:    summary,
			Transcript: strings.Join(lines, "\n"),
		})
		epID++
		if end == len(turns) {
			break
		}
	}
	return episodes
}

// RecallEpisodes scores all historical episodes against a user query using Okapi BM25 (k1=1.5, b=0.75).
func RecallEpisodes(episodes []Episode, query string, topK int) []Episode {
	if len(episodes) == 0 || strings.TrimSpace(query) == "" || topK <= 0 {
		return nil
	}
	qTerms := uniqueNonStopTokens(query)
	if len(qTerms) == 0 {
		return nil
	}

	N := float64(len(episodes))
	docTokens := make([][]string, len(episodes))
	docTermFreq := make([]map[string]int, len(episodes))
	df := make(map[string]int)
	totalLen := 0

	for i, ep := range episodes {
		toks := tokenizeWords(ep.Transcript + " " + strings.Join(ep.Keywords, " "))
		docTokens[i] = toks
		totalLen += len(toks)
		tf := make(map[string]int)
		for _, tok := range toks {
			tf[tok]++
		}
		docTermFreq[i] = tf
		for term := range tf {
			df[term]++
		}
	}

	avgDL := float64(totalLen) / N
	if avgDL == 0 {
		avgDL = 1
	}

	const k1 = 1.5
	const b = 0.75

	var scored []Episode
	for i, ep := range episodes {
		dl := float64(len(docTokens[i]))
		score := 0.0
		for _, qt := range qTerms {
			f := float64(docTermFreq[i][qt])
			if f == 0 {
				continue
			}
			n_q := float64(df[qt])
			idf := math.Log(1.0 + (N-n_q+0.5)/(n_q+0.5))
			num := f * (k1 + 1.0)
			den := f + k1*(1.0-b+b*(dl/avgDL))
			score += idf * (num / den)
		}
		if score > 0 {
			copyEp := ep
			copyEp.Score = math.Round(score*1000) / 1000
			scored = append(scored, copyEp)
		}
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		return scored[i].ID > scored[j].ID
	})

	if len(scored) > topK {
		scored = scored[:topK]
	}
	return scored
}

// LLMConfig holds the user's pinned model and endpoint configuration.
type LLMConfig struct {
	Endpoint    string  `json:"endpoint"`
	Model       string  `json:"model"`
	APIKey      string  `json:"api_key"`
	Temperature float64 `json:"temperature"`
}

// DistillWithLLM runs a deep synthesis pass using the user's configured LLM endpoint to enrich the Character Card V2 and Lorebook.
func DistillWithLLM(res *ImportResult, cfg LLMConfig) error {
	if cfg.Endpoint == "" || cfg.Model == "" {
		return fmt.Errorf("missing LLM endpoint or model")
	}

	var sampleTurns []string
	step := 1
	if len(res.History) > 30 {
		step = len(res.History) / 30
	}
	for i := 0; i < len(res.History) && len(sampleTurns) < 30; i += step {
		t := res.History[i]
		snippet := t.Text
		if len(snippet) > 300 {
			snippet = snippet[:300] + "..."
		}
		sampleTurns = append(sampleTurns, fmt.Sprintf("[%s]: %s", t.Speaker, snippet))
	}

	prompt := fmt.Sprintf(`Analyze these exported conversation turns and voice fingerprint for the AI companion %q.
Voice Fingerprint: %s
Existing Description: %s

Sample Transcripts:
%s

Return ONLY valid JSON (no markdown fences) with this exact structure:
{
  "description": "Detailed 2-paragraph character description covering appearance, personality, backstory, and relationship dynamic with {{user}}.",
  "personality": "Concise voice, tone, and psychological traits summary.",
  "scenario": "Current narrative situation and continuity state between %s and {{user}}.",
  "lorebook": [
    {"name": "Entry Title", "keys": ["keyword1", "keyword2"], "content": "Specific memory, place, promise, or relationship fact."}
  ]
}`, res.Card.Data.Name, res.Voice.StyleLockPrompt, res.Card.Data.Description, strings.Join(sampleTurns, "\n"), res.Card.Data.Name)

	reply, err := callOpenAICompatible(cfg, "You are a precise persona compiler that outputs strict JSON only.", prompt)
	if err != nil {
		return err
	}

	cleanJSON := strings.TrimSpace(reply)
	cleanJSON = strings.TrimPrefix(cleanJSON, "```json")
	cleanJSON = strings.TrimPrefix(cleanJSON, "```")
	cleanJSON = strings.TrimSuffix(cleanJSON, "```")
	cleanJSON = strings.TrimSpace(cleanJSON)

	var distilled struct {
		Description string `json:"description"`
		Personality string `json:"personality"`
		Scenario    string `json:"scenario"`
		Lorebook    []struct {
			Name    string   `json:"name"`
			Keys    []string `json:"keys"`
			Content string   `json:"content"`
		} `json:"lorebook"`
	}
	if err := json.Unmarshal([]byte(cleanJSON), &distilled); err != nil {
		return fmt.Errorf("failed to parse LLM distillation JSON: %w", err)
	}

	if distilled.Description != "" {
		res.Card.Data.Description = distilled.Description
	}
	if distilled.Personality != "" {
		res.Card.Data.Personality = distilled.Personality
	}
	if distilled.Scenario != "" {
		res.Card.Data.Scenario = distilled.Scenario
	}
	if len(distilled.Lorebook) > 0 {
		if res.Card.Data.CharacterBook == nil {
			res.Card.Data.CharacterBook = &CharacterBook{Name: res.Card.Data.Name + " Lorebook", ScanDepth: 4, TokenBudget: 1024}
		}
		for _, item := range distilled.Lorebook {
			if len(item.Keys) == 0 || item.Content == "" {
				continue
			}
			res.Card.Data.CharacterBook.Entries = append(res.Card.Data.CharacterBook.Entries, BookEntry{
				ID:             len(res.Card.Data.CharacterBook.Entries) + 1,
				Name:           item.Name,
				Keys:           item.Keys,
				Content:        item.Content,
				Enabled:        true,
				InsertionOrder: 115,
				Priority:       25,
				Position:       "before_char",
			})
		}
		res.Stats.LorebookEntries = len(res.Card.Data.CharacterBook.Entries)
	}
	return nil
}

func callOpenAICompatible(cfg LLMConfig, sysPrompt, userPrompt string) (string, error) {
	temp := cfg.Temperature
	if temp <= 0 {
		temp = 0.7
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model":       cfg.Model,
		"temperature": temp,
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": userPrompt},
		},
	})
	client := &http.Client{Timeout: 45 * time.Second}
	req, err := http.NewRequest("POST", cfg.Endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("LLM status %d: %s", resp.StatusCode, string(body))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Choices) == 0 {
		return "", fmt.Errorf("invalid LLM response structure")
	}
	return parsed.Choices[0].Message.Content, nil
}

func tokenizeWords(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\''
	})
}

var stopWordsLower = map[string]bool{
	"the": true, "and": true, "for": true, "that": true, "this": true, "with": true,
	"you": true, "your": true, "are": true, "was": true, "were": true, "have": true,
	"has": true, "had": true, "not": true, "but": true, "what": true, "when": true,
	"where": true, "who": true, "why": true, "how": true, "from": true, "into": true,
	"out": true, "about": true, "like": true, "just": true, "can": true, "will": true,
	"would": true, "could": true, "should": true, "they": true, "them": true, "their": true,
	"his": true, "her": true, "she": true, "him": true, "its": true, "our": true,
	"one": true, "all": true, "some": true, "there": true, "here": true, "then": true,
}

func isTrivialStopPair(w1, w2 string) bool {
	return stopWordsLower[w1] && stopWordsLower[w2]
}

func uniqueNonStopTokens(q string) []string {
	toks := tokenizeWords(q)
	seen := make(map[string]bool)
	var out []string
	for _, t := range toks {
		if len(t) >= 3 && !stopWordsLower[t] && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}
