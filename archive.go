package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ParseArchiveOrFile accepts a .zip archive (Character.AI GDPR export, ChatGPT export, Replika zip, or .charx),
// a Tavern V2/V3 .png card, or any single .json/.jsonl export file, returning all discovered companions sorted by turn count.
func ParseArchiveOrFile(raw []byte, filename string) ([]*ImportResult, error) {
	return ParseArchiveOrFileWithPassword(raw, filename, "")
}

// ParseArchiveOrFileWithPassword decrypts password-protected ZipCrypto archives (auto-retrying trimmed lowercase email)
// before parsing companions.
func ParseArchiveOrFileWithPassword(raw []byte, filename, password string) ([]*ImportResult, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("empty input")
	}

	// 1. Check ZIP magic bytes (PK\x03\x04)
	if len(raw) >= 4 && bytes.Equal(raw[:4], []byte{0x50, 0x4b, 0x03, 0x04}) {
		return parseZipExport(raw, filename, password)
	}

	// 2. Check PNG magic bytes
	if len(raw) >= 8 && bytes.Equal(raw[:8], pngSig) {
		card, err := DecodeTavernPNG(raw)
		if err != nil {
			return nil, err
		}
		b, err := json.Marshal(card)
		if err != nil {
			return nil, err
		}
		res, err := parseTavernV2(b)
		if err != nil {
			return nil, err
		}
		res.AvatarPNG = raw
		EnrichImportResult(res)
		return []*ImportResult{res}, nil
	}

	// 3. Check if ChatGPT conversations.json array or official C.AI flat message.json array
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if results, ok := tryParseChatGPTConversations(trimmed); ok && len(results) > 0 {
			return results, nil
		}
		if results, err := parseCAIOfficialMessageJSON(trimmed, nil, nil); err == nil && len(results) > 0 {
			return results, nil
		}
	}

	// 4. Single JSON / JSONL file
	res, err := ParseExport(raw, baseNameWithoutExt(filename))
	if err != nil {
		return nil, err
	}
	EnrichImportResult(res)
	return []*ImportResult{res}, nil
}

func parseZipExport(raw []byte, filename, password string) ([]*ImportResult, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("invalid zip archive: %w", err)
	}

	candidates := []string{password}
	if lowered := strings.ToLower(strings.TrimSpace(password)); lowered != password {
		candidates = append(candidates, lowered)
	}

	var files map[string][]byte
	var pngAvatars [][]byte
	var lastErr error
	for _, pw := range candidates {
		files = make(map[string][]byte)
		pngAvatars = nil
		lastErr = nil
		for _, f := range zr.File {
			if f.FileInfo().IsDir() || f.UncompressedSize64 > 128<<20 {
				continue
			}
			cleanName := strings.TrimPrefix(filepath.ToSlash(f.Name), "./")
			ext := strings.ToLower(filepath.Ext(cleanName))
			if ext != ".json" && ext != ".jsonl" && ext != ".txt" && ext != ".png" {
				continue
			}
			data, rerr := readZipEntry(f, pw, 128<<20)
			if rerr != nil {
				if errors.Is(rerr, errZipEncrypted) || errors.Is(rerr, errZipWrongPassword) {
					lastErr = rerr
					break
				}
				continue
			}
			files[cleanName] = data
			if ext == ".png" && len(data) > 8 && bytes.Equal(data[:8], pngSig) {
				pngAvatars = append(pngAvatars, data)
			}
		}
		if lastErr == nil {
			break
		}
		if errors.Is(lastErr, errZipEncrypted) {
			return nil, lastErr
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}

	// Case A: CharX (.charx) V3 archive with card.json
	if cardRaw, ok := findFileBySuffix(files, "card.json"); ok {
		if res, err := ParseExport(cardRaw, baseNameWithoutExt(filename)); err == nil {
			if len(pngAvatars) > 0 {
				res.AvatarPNG = pngAvatars[0]
			}
			EnrichImportResult(res)
			return []*ImportResult{res}, nil
		}
	}

	// Case B: ChatGPT GDPR export zip (conversations.json)
	if convRaw, ok := findFileBySuffix(files, "conversations.json"); ok {
		if results, ok := tryParseChatGPTConversations(convRaw); ok && len(results) > 0 {
			return results, nil
		}
	}

	// Case C1: Character.AI official GDPR export zip (data/message.json + character.json + user.json)
	if msgRaw, ok := findFileBySuffix(files, "message.json"); ok {
		charRaw, _ := findFileBySuffix(files, "character.json")
		if len(charRaw) == 0 {
			charRaw, _ = findFileBySuffix(files, "characters.json")
		}
		userRaw, _ := findFileBySuffix(files, "user.json")
		if results, err := parseCAIOfficialMessageJSON(msgRaw, charRaw, userRaw); err == nil && len(results) > 0 {
			return results, nil
		}
	}

	// Case C2: Character.AI older GDPR export zip (histories.json + optional characters.json)
	if histRaw, ok := findFileBySuffix(files, "histories.json"); ok {
		charRaw, _ := findFileBySuffix(files, "characters.json")
		if results, err := parseCAIGDPRZip(histRaw, charRaw); err == nil && len(results) > 0 {
			return results, nil
		}
	}

	// Case D: Replika export zip (chat_history.json + optional memory.json / diary.json)
	if repRaw, ok := findFileBySuffix(files, "chat_history.json"); ok {
		memRaw, _ := findFileBySuffix(files, "memory.json")
		diaryRaw, _ := findFileBySuffix(files, "diary.json")
		if res, err := parseReplikaBundle(repRaw, memRaw, diaryRaw, baseNameWithoutExt(filename)); err == nil {
			EnrichImportResult(res)
			return []*ImportResult{res}, nil
		}
	}

	// Case E: Scan all .json / .jsonl / .png files in the zip
	var results []*ImportResult
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)

	for _, name := range names {
		ext := strings.ToLower(filepath.Ext(name))
		data := files[name]
		switch ext {
		case ".json", ".jsonl":
			if res, err := ParseExport(data, baseNameWithoutExt(name)); err == nil && len(res.History) > 0 {
				EnrichImportResult(res)
				results = append(results, res)
			}
		case ".png":
			if card, err := DecodeTavernPNG(data); err == nil {
				b, _ := json.Marshal(card)
				if res, err := parseTavernV2(b); err == nil {
					res.AvatarPNG = data
					EnrichImportResult(res)
					results = append(results, res)
				}
			}
		}
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("no recognizable companion exports found in zip archive")
	}
	sortResultsByTurns(results)
	return results, nil
}

func findFileBySuffix(files map[string][]byte, suffix string) ([]byte, bool) {
	suffix = strings.ToLower(suffix)
	for k, v := range files {
		if strings.ToLower(k) == suffix || strings.HasSuffix(strings.ToLower(k), "/"+suffix) {
			return v, true
		}
	}
	return nil, false
}

// parseCAIGDPRZip parses Character.AI's multi-character GDPR export (histories.json + characters.json).
func parseCAIGDPRZip(histRaw, charRaw []byte) ([]*ImportResult, error) {
	charMeta := make(map[string]map[string]any)
	if len(charRaw) > 0 {
		var charArr []map[string]any
		if err := json.Unmarshal(charRaw, &charArr); err == nil {
			for _, c := range charArr {
				id := strField(c, "external_id", strField(c, "participant__user__username", strField(c, "name", "")))
				if id != "" {
					charMeta[id] = c
				}
			}
		}
	}

	// histories.json can be {"histories": [...]} or a top-level array [...]
	var histList []map[string]any
	var wrapper map[string]any
	if err := json.Unmarshal(histRaw, &wrapper); err == nil {
		if arr, ok := wrapper["histories"].([]any); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					histList = append(histList, m)
				}
			}
		}
	}
	if len(histList) == 0 {
		_ = json.Unmarshal(histRaw, &histList)
	}
	if len(histList) == 0 {
		return nil, fmt.Errorf("empty histories.json")
	}

	type groupedBot struct {
		name     string
		desc     string
		greeting string
		msgs     []map[string]any
	}
	groups := make(map[string]*groupedBot)

	for _, h := range histList {
		charID := strField(h, "character_external_id", strField(h, "character_id", strField(h, "character_name", "")))
		var msgs []map[string]any
		if mArr, ok := h["msgs"].([]any); ok {
			for _, m := range mArr {
				if mm, ok := m.(map[string]any); ok {
					msgs = append(msgs, mm)
				}
			}
		} else if tArr, ok := h["turns"].([]any); ok {
			for _, t := range tArr {
				if tm, ok := t.(map[string]any); ok {
					msgs = append(msgs, tm)
				}
			}
		}
		if len(msgs) == 0 {
			continue
		}

		// Detect character name from messages if charID not in metadata
		detectedName := charID
		for _, m := range msgs {
			role, spk := extractRoleAndSpeaker(m, "", "User")
			if role == "assistant" && spk != "" && spk != "Character" && spk != "Companion" {
				detectedName = spk
				break
			}
		}
		if detectedName == "" {
			detectedName = "Companion"
		}
		key := coalesce(charID, detectedName)
		g, exists := groups[key]
		if !exists {
			g = &groupedBot{name: detectedName}
			if meta, ok := charMeta[charID]; ok {
				g.name = strField(meta, "name", strField(meta, "participant__name", g.name))
				g.desc = strField(meta, "description", strField(meta, "title", ""))
				g.greeting = strField(meta, "greeting", "")
			}
			groups[key] = g
		}
		g.msgs = append(g.msgs, msgs...)
	}

	var results []*ImportResult
	for _, g := range groups {
		res, err := parseMessageArray("character_ai_gdpr", g.msgs, g.name, "User", g.desc, g.greeting)
		if err == nil && len(res.History) > 0 {
			EnrichImportResult(res)
			results = append(results, res)
		}
	}
	sortResultsByTurns(results)
	return results, nil
}

// parseReplikaBundle merges Replika's chat_history.json with structured facts from memory.json and entries from diary.json.
func parseReplikaBundle(chatRaw, memRaw, diaryRaw []byte, fallbackName string) (*ImportResult, error) {
	res, err := ParseExport(chatRaw, fallbackName)
	if err != nil {
		return nil, err
	}
	res.SourceFormat = "replika_bundle"
	if res.Card.Data.CharacterBook == nil {
		res.Card.Data.CharacterBook = &CharacterBook{
			Name:        res.Card.Data.Name + " Lorebook",
			ScanDepth:   4,
			TokenBudget: 1024,
		}
	}

	// Parse memory.json (facts & people & relationships saved by Replika)
	if len(memRaw) > 0 {
		var memObj map[string]any
		if err := json.Unmarshal(memRaw, &memObj); err == nil {
			if facts, ok := memObj["facts"].([]any); ok {
				var factLines []string
				for _, f := range facts {
					if fm, ok := f.(map[string]any); ok {
						txt := strField(fm, "text", strField(fm, "value", ""))
						if txt != "" {
							factLines = append(factLines, txt)
						}
					} else if fs, ok := f.(string); ok && fs != "" {
						factLines = append(factLines, fs)
					}
				}
				if len(factLines) > 0 {
					res.Card.Data.CharacterBook.Entries = append([]BookEntry{{
						ID:             len(res.Card.Data.CharacterBook.Entries) + 1,
						Name:           "Replika Core Facts",
						Keys:           []string{"about me", "remember", "fact", "user", strings.ToLower(res.Card.Data.Name)},
						Content:        "Saved Replika Facts:\n- " + strings.Join(factLines, "\n- "),
						Enabled:        true,
						InsertionOrder: 130,
						Priority:       30,
						Position:       "before_char",
					}}, res.Card.Data.CharacterBook.Entries...)
				}
			}
		}
	}

	// Parse diary.json
	if len(diaryRaw) > 0 {
		var diaryArr []map[string]any
		if err := json.Unmarshal(diaryRaw, &diaryArr); err == nil {
			for i, d := range diaryArr {
				if i >= 6 {
					break
				}
				title := strField(d, "title", fmt.Sprintf("Diary Entry %d", i+1))
				body := strField(d, "text", strField(d, "content", ""))
				if body != "" {
					res.Card.Data.CharacterBook.Entries = append(res.Card.Data.CharacterBook.Entries, BookEntry{
						ID:             len(res.Card.Data.CharacterBook.Entries) + 1,
						Name:           "Diary: " + title,
						Keys:           extractKeywordsFromTitle(title),
						Content:        fmt.Sprintf("%s's Diary (%s): %s", res.Card.Data.Name, title, body),
						Enabled:        true,
						InsertionOrder: 90 - i,
						Priority:       15,
						Position:       "after_char",
					})
				}
			}
		}
	}

	res.Stats.LorebookEntries = len(res.Card.Data.CharacterBook.Entries)
	return res, nil
}

// parseCAIOfficialMessageJSON handles Character.AI's official 2025/2026 GDPR export
// (username/data/message.json + character.json + user.json) where messages are flat with chat_id & raw_content.
func parseCAIOfficialMessageJSON(msgRaw, charRaw, userRaw []byte) ([]*ImportResult, error) {
	var msgList []map[string]any
	if err := json.Unmarshal(msgRaw, &msgList); err != nil || len(msgList) == 0 {
		var wrap map[string]any
		if err2 := json.Unmarshal(msgRaw, &wrap); err2 == nil {
			for _, k := range []string{"messages", "data"} {
				if arr, ok := wrap[k].([]any); ok {
					for _, item := range arr {
						if m, ok := item.(map[string]any); ok {
							msgList = append(msgList, m)
						}
					}
					break
				}
			}
		}
	}
	if len(msgList) == 0 {
		return nil, fmt.Errorf("empty message.json")
	}
	looksCAI := false
	for i := 0; i < len(msgList) && i < 10; i++ {
		if _, ok := msgList[i]["raw_content"]; ok {
			looksCAI = true
			break
		}
		if _, ok := msgList[i]["chat_id"]; ok {
			looksCAI = true
			break
		}
	}
	if !looksCAI {
		return nil, fmt.Errorf("not an official Character.AI message.json")
	}

	userName := "User"
	if len(userRaw) > 0 {
		var u map[string]any
		if err := json.Unmarshal(userRaw, &u); err == nil {
			userName = strField(u, "name", strField(u, "username", "User"))
		}
	}

	charByID := make(map[string]map[string]any)
	if len(charRaw) > 0 {
		var chars []map[string]any
		if err := json.Unmarshal(charRaw, &chars); err == nil {
			for _, c := range chars {
				for _, k := range []string{"external_id", "character_id", "id", "name"} {
					if v := strField(c, k, ""); v != "" {
						charByID[v] = c
					}
				}
			}
		}
	}

	groups := make(map[string][]map[string]any)
	for _, m := range msgList {
		if strings.TrimSpace(extractText(m)) == "" {
			continue
		}
		cid := strField(m, "chat_id", strField(m, "character_id", "default"))
		groups[cid] = append(groups[cid], m)
	}

	var results []*ImportResult
	for chatID, msgs := range groups {
		sort.SliceStable(msgs, func(i, j int) bool {
			ti := extractTimestamp(msgs[i])
			tj := extractTimestamp(msgs[j])
			if ti != "" && tj != "" {
				return ti < tj
			}
			return false
		})

		var meta map[string]any
		for _, m := range msgs {
			if id := strField(m, "character_id", strField(m, "character_external_id", "")); id != "" {
				if c, ok := charByID[id]; ok {
					meta = c
					break
				}
			}
		}

		charName := ""
		desc := ""
		greeting := ""
		if meta != nil {
			charName = strField(meta, "name", strField(meta, "participant__name", ""))
			desc = strField(meta, "description", strField(meta, "title", ""))
			greeting = strField(meta, "greeting", "")
		}
		if charName == "" {
			if len(chatID) > 8 {
				charName = "Character.AI Chat (" + chatID[:8] + ")"
			} else {
				charName = "Character.AI Chat"
			}
		}

		// Populate alternating role if official flat message.json lacks explicit author/is_human
		prepared := make([]map[string]any, 0, len(msgs))
		nextBot := true
		for _, m := range msgs {
			cp := make(map[string]any, len(m)+2)
			for k, v := range m {
				cp[k] = v
			}
			_, hasAuthor := cp["author"]
			_, hasSrc := cp["src"]
			_, hasHuman := cp["is_human"]
			_, hasUser := cp["is_user"]
			_, hasRole := cp["role"]
			if !hasAuthor && !hasSrc && !hasHuman && !hasUser && !hasRole {
				if nextBot {
					cp["role"] = "assistant"
					cp["name"] = charName
				} else {
					cp["role"] = "user"
					cp["name"] = userName
				}
				nextBot = !nextBot
			}
			prepared = append(prepared, cp)
		}

		res, err := parseMessageArray("character_ai_gdpr", prepared, charName, userName, desc, greeting)
		if err == nil && len(res.History) > 0 {
			EnrichImportResult(res)
			results = append(results, res)
		}
	}
	sortResultsByTurns(results)
	return results, nil
}

// tryParseChatGPTConversations parses OpenAI's conversations.json tree structure (#Keep4o companion rescue),
// walking the active branch (current_node -> parent) and preserving user_editable_context Custom Instructions.
func tryParseChatGPTConversations(raw []byte) ([]*ImportResult, errorBool) {
	var convs []map[string]any
	if err := json.Unmarshal(raw, &convs); err != nil || len(convs) == 0 {
		return nil, false
	}
	if _, hasMapping := convs[0]["mapping"].(map[string]any); !hasMapping {
		return nil, false
	}

	type convBucket struct {
		name      string
		sysPrompt string
		turns     []NormalizedTurn
	}
	buckets := make(map[string]*convBucket)

	for _, c := range convs {
		title := strField(c, "title", "GPT-4o Companion")
		mapping, ok := c["mapping"].(map[string]any)
		if !ok {
			continue
		}

		// Walk active branch from current_node back to root so regenerated/dead branches are omitted.
		var orderedNodes []map[string]any
		if curID, ok := c["current_node"].(string); ok && curID != "" {
			if _, exists := mapping[curID]; exists {
				visited := make(map[string]bool)
				cur := curID
				for cur != "" && !visited[cur] {
					visited[cur] = true
					node, ok := mapping[cur].(map[string]any)
					if !ok {
						break
					}
					orderedNodes = append(orderedNodes, node)
					parent, _ := node["parent"].(string)
					cur = parent
				}
				for i, j := 0, len(orderedNodes)-1; i < j; i, j = i+1, j-1 {
					orderedNodes[i], orderedNodes[j] = orderedNodes[j], orderedNodes[i]
				}
			}
		}
		if len(orderedNodes) == 0 {
			for _, v := range mapping {
				if node, ok := v.(map[string]any); ok {
					orderedNodes = append(orderedNodes, node)
				}
			}
			sort.SliceStable(orderedNodes, func(i, j int) bool {
				mi, _ := orderedNodes[i]["message"].(map[string]any)
				mj, _ := orderedNodes[j]["message"].(map[string]any)
				ti, _ := mi["create_time"].(float64)
				tj, _ := mj["create_time"].(float64)
				return ti < tj
			})
		}

		type timedNode struct {
			role string
			text string
			ts   float64
		}
		var nodes []timedNode
		var customSys string
		var customParts []string

		for _, node := range orderedNodes {
			msg, ok := node["message"].(map[string]any)
			if !ok || msg == nil {
				continue
			}
			author, _ := msg["author"].(map[string]any)
			role := strField(author, "role", "")
			content, _ := msg["content"].(map[string]any)
			if ct := strField(content, "content_type", ""); ct == "user_editable_context" {
				if meta, ok := msg["metadata"].(map[string]any); ok {
					if umd, ok := meta["user_context_message_data"].(map[string]any); ok {
						if au := strField(umd, "about_user_message", ""); au != "" {
							customParts = append(customParts, "About User: "+au)
						}
						if am := strField(umd, "about_model_message", ""); am != "" {
							customParts = append(customParts, "How to Respond: "+am)
						}
					}
				}
				continue
			}

			var partsText []string
			if parts, ok := content["parts"].([]any); ok {
				for _, p := range parts {
					if ps, ok := p.(string); ok && strings.TrimSpace(ps) != "" {
						partsText = append(partsText, strings.TrimSpace(ps))
					}
				}
			}
			fullText := strings.Join(partsText, "\n")
			if fullText == "" {
				continue
			}
			if role == "system" {
				if len(fullText) > len(customSys) {
					customSys = fullText
				}
				continue
			}
			if role != "user" && role != "assistant" {
				continue
			}
			ts, _ := msg["create_time"].(float64)
			nodes = append(nodes, timedNode{role: role, text: fullText, ts: ts})
		}

		if len(nodes) == 0 {
			continue
		}

		if len(customParts) > 0 {
			joined := strings.Join(customParts, "\n")
			if customSys != "" {
				customSys = customSys + "\n" + joined
			} else {
				customSys = joined
			}
		}

		bucketKey := title
		b, exists := buckets[bucketKey]
		if !exists {
			b = &convBucket{name: title, sysPrompt: customSys}
			buckets[bucketKey] = b
		}
		for _, n := range nodes {
			spk := "User"
			if n.role == "assistant" {
				spk = title
			}
			tsStr := ""
			if n.ts > 0 {
				tsStr = time.Unix(int64(n.ts), 0).UTC().Format(time.RFC3339)
			}
			b.turns = append(b.turns, NormalizedTurn{
				Role:      n.role,
				Speaker:   spk,
				Text:      n.text,
				Timestamp: tsStr,
			})
		}
	}

	var results []*ImportResult
	for _, b := range buckets {
		if len(b.turns) == 0 {
			continue
		}
		rawMaps := make([]map[string]any, 0, len(b.turns))
		for _, t := range b.turns {
			rawMaps = append(rawMaps, map[string]any{
				"role":        t.Role,
				"speaker":     t.Speaker,
				"text":        t.Text,
				"create_time": t.Timestamp,
			})
		}
		res, err := parseMessageArray("chatgpt_export", rawMaps, b.name, "User", b.sysPrompt, "")
		if err == nil {
			EnrichImportResult(res)
			results = append(results, res)
		}
	}
	if len(results) == 0 {
		return nil, false
	}
	sortResultsByTurns(results)
	return results, true
}

type errorBool = bool

func extractKeywordsFromTitle(title string) []string {
	words := strings.FieldsFunc(strings.ToLower(title), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9')
	})
	var out []string
	for _, w := range words {
		if len(w) >= 4 && !commonStopCapitalized[strings.Title(w)] {
			out = append(out, w)
		}
	}
	if len(out) == 0 {
		return []string{"diary", "memory"}
	}
	return out
}

func sortResultsByTurns(results []*ImportResult) {
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].Stats.TotalTurns > results[j].Stats.TotalTurns
	})
}
