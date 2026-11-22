package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// CompanionRecord is a persisted companion inside the local Lifeboat vault.
type CompanionRecord struct {
	ID           string           `json:"id"`
	CreatedAt    string           `json:"created_at"`
	UpdatedAt    string           `json:"updated_at"`
	SourceFormat string           `json:"source_format"`
	PinnedModel  string           `json:"pinned_model,omitempty"`
	Card         TavernCardV2     `json:"card"`
	Voice        VoiceProfile     `json:"voice"`
	Stats        ImportStats      `json:"stats"`
	History      []NormalizedTurn `json:"history"`
	Episodes     []Episode        `json:"episodes"`
	AvatarBase64 string           `json:"avatar_base64,omitempty"`
}

// Vault manages persistent storage of rescued companions on disk.
type Vault struct {
	mu      sync.RWMutex
	dir     string
	records map[string]*CompanionRecord
}

func NewVault(dir string) (*Vault, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			dir = ".lifeboat-data"
		} else {
			dir = filepath.Join(home, ".local", "share", "lifeboat")
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	v := &Vault{
		dir:     dir,
		records: make(map[string]*CompanionRecord),
	}
	_ = v.load()
	return v, nil
}

func (v *Vault) filePath() string {
	return filepath.Join(v.dir, "vault.json")
}

func (v *Vault) load() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	b, err := os.ReadFile(v.filePath())
	if err != nil {
		return err
	}
	var list []*CompanionRecord
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}
	for _, r := range list {
		if r != nil && r.ID != "" {
			v.records[r.ID] = r
		}
	}
	return nil
}

func (v *Vault) saveLocked() error {
	list := make([]*CompanionRecord, 0, len(v.records))
	for _, r := range v.records {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].UpdatedAt > list[j].UpdatedAt
	})
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := v.filePath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, v.filePath())
}

func (v *Vault) UpsertFromImport(res *ImportResult, pinnedModel string) *CompanionRecord {
	v.mu.Lock()
	defer v.mu.Unlock()

	EnrichImportResult(res)
	now := time.Now().UTC().Format(time.RFC3339)
	id := companionID(res.Card.Data.Name, res.SourceFormat)

	existing, exists := v.records[id]
	createdAt := now
	if exists {
		createdAt = existing.CreatedAt
		if pinnedModel == "" {
			pinnedModel = existing.PinnedModel
		}
	}

	rec := &CompanionRecord{
		ID:           id,
		CreatedAt:    createdAt,
		UpdatedAt:    now,
		SourceFormat: res.SourceFormat,
		PinnedModel:  pinnedModel,
		Card:         res.Card,
		Voice:        res.Voice,
		Stats:        res.Stats,
		History:      res.History,
		Episodes:     res.Episodes,
	}
	v.records[id] = rec
	_ = v.saveLocked()
	return rec
}

func (v *Vault) SaveRecord(rec *CompanionRecord) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if rec.ID == "" {
		rec.ID = companionID(rec.Card.Data.Name, rec.SourceFormat)
	}
	rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	v.records[rec.ID] = rec
	return v.saveLocked()
}

func (v *Vault) List() []*CompanionRecord {
	v.mu.RLock()
	defer v.mu.RUnlock()
	list := make([]*CompanionRecord, 0, len(v.records))
	for _, r := range v.records {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].UpdatedAt != list[j].UpdatedAt {
			return list[i].UpdatedAt > list[j].UpdatedAt
		}
		return list[i].ID < list[j].ID
	})
	return list
}

func (v *Vault) Get(id string) (*CompanionRecord, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	r, ok := v.records[id]
	return r, ok
}

func (v *Vault) Delete(id string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return false
	}
	delete(v.records, id)
	_ = v.saveLocked()
	return true
}

// SearchHit represents a turn or episode matching a vault-wide search query.
type SearchHit struct {
	CompanionID   string  `json:"companion_id"`
	CompanionName string  `json:"companion_name"`
	Kind          string  `json:"kind"` // "episode" or "turn"
	TurnIndex     int     `json:"turn_index"`
	Snippet       string  `json:"snippet"`
	Score         float64 `json:"score"`
}

func (v *Vault) Search(query string, limit int) []SearchHit {
	v.mu.RLock()
	defer v.mu.RUnlock()
	qLower := strings.ToLower(strings.TrimSpace(query))
	if qLower == "" {
		return nil
	}
	if limit <= 0 {
		limit = 20
	}

	var hits []SearchHit
	for _, r := range v.records {
		// 1. BM25 Episode matches
		eps := RecallEpisodes(r.Episodes, query, 5)
		for _, ep := range eps {
			hits = append(hits, SearchHit{
				CompanionID:   r.ID,
				CompanionName: r.Card.Data.Name,
				Kind:          "episode",
				TurnIndex:     ep.StartTurn,
				Snippet:       ep.Summary,
				Score:         ep.Score + 2.0,
			})
		}
		// 2. Exact substring turn matches
		for idx, t := range r.History {
			if strings.Contains(strings.ToLower(t.Text), qLower) {
				snip := t.Text
				if len(snip) > 200 {
					snip = snip[:200] + "..."
				}
				hits = append(hits, SearchHit{
					CompanionID:   r.ID,
					CompanionName: r.Card.Data.Name,
					Kind:          "turn",
					TurnIndex:     idx + 1,
					Snippet:       fmt.Sprintf("%s: %s", t.Speaker, snip),
					Score:         1.0,
				})
			}
		}
	}

	sort.Slice(hits, func(i, j int) bool {
		return hits[i].Score > hits[j].Score
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

func companionID(name, source string) string {
	clean := strings.ToLower(strings.TrimSpace(name))
	h := sha256.Sum256([]byte(clean + ":" + source))
	return hex.EncodeToString(h[:6])
}
