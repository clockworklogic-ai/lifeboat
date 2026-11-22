package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed site/index.html site/styles.css site/app.js
var siteFS embed.FS

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		addr := fs.String("addr", "127.0.0.1:8090", "listen address")
		dataDir := fs.String("data", "", "vault storage directory (default ~/.local/share/lifeboat)")
		_ = fs.Parse(os.Args[2:])
		vault, err := NewVault(*dataDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "vault error:", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "lifeboat listening on http://%s (vault: %s)\n", *addr, vault.dir)
		if err := http.ListenAndServe(*addr, newMux(vault)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

	case "convert":
		fs := flag.NewFlagSet("convert", flag.ExitOnError)
		out := fs.String("o", "", "output file (.json or .png)")
		name := fs.String("name", "", "fallback character name")
		password := fs.String("password", "", "zip password (e.g. Character.AI lowercase email)")
		_ = fs.Parse(os.Args[2:])
		if fs.NArg() < 1 {
			fmt.Fprintln(os.Stderr, "usage: lifeboat convert [-o out.png|out.json] [-password EMAIL] <export.zip|export.json|export.jsonl|card.png>")
			os.Exit(2)
		}
		inPath := fs.Arg(0)
		raw, err := os.ReadFile(inPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		results, err := ParseArchiveOrFileWithPassword(raw, coalesce(*name, filepath.Base(inPath)), *password)
		if err != nil || len(results) == 0 {
			fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
			os.Exit(1)
		}
		res := results[0]
		if *out == "" {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(res.Card)
			return
		}
		if strings.HasSuffix(strings.ToLower(*out), ".png") {
			pngBytes, err := EncodeTavernPNG(res.Card, res.AvatarPNG)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if err := os.WriteFile(*out, pngBytes, 0644); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		} else {
			b, err := json.MarshalIndent(res.Card, "", "  ")
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if err := os.WriteFile(*out, b, 0644); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		fmt.Fprintf(os.Stderr, "wrote %s (%s: %d turns, %d words, %d lorebook keys, %d episodes)\n",
			*out, res.Card.Data.Name, res.Stats.TotalTurns, res.Stats.TotalWords, res.Stats.LorebookEntries, res.Stats.EpisodeCount)

	case "recall":
		fs := flag.NewFlagSet("recall", flag.ExitOnError)
		password := fs.String("password", "", "zip password (e.g. Character.AI lowercase email)")
		_ = fs.Parse(os.Args[2:])
		if fs.NArg() < 2 {
			fmt.Fprintln(os.Stderr, "usage: lifeboat recall [-password EMAIL] <export.zip|export.json> <query>")
			os.Exit(2)
		}
		raw, err := os.ReadFile(fs.Arg(0))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		results, err := ParseArchiveOrFileWithPassword(raw, filepath.Base(fs.Arg(0)), *password)
		if err != nil || len(results) == 0 {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		query := strings.Join(fs.Args()[1:], " ")
		eps := RecallEpisodes(results[0].Episodes, query, 5)
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(eps)

	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `lifeboat — offline companion rescue compiler, BM25 memory engine & local vault

Usage:
  lifeboat serve [-addr 127.0.0.1:8090] [-data ~/.local/share/lifeboat]
  lifeboat convert [-o card.png|card.json] [-name Name] [-password EMAIL] <export.zip|export.json|export.jsonl|card.png>
  lifeboat recall [-password EMAIL] <export.zip|export.json> <query>`)
}

func newMux(vault *Vault) http.Handler {
	if vault == nil {
		vault, _ = NewVault("")
	}
	mux := http.NewServeMux()

	serveSiteFile := func(w http.ResponseWriter, path, ctype string) {
		b, err := siteFS.ReadFile(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", ctype)
		_, _ = w.Write(b)
	}

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html":
			serveSiteFile(w, "site/index.html", "text/html; charset=utf-8")
		case "/styles.css":
			serveSiteFile(w, "site/styles.css", "text/css; charset=utf-8")
		case "/app.js":
			serveSiteFile(w, "site/app.js", "application/javascript; charset=utf-8")
		default:
			http.NotFound(w, r)
		}
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// POST /api/parse ingests a .zip, .png, .json, or .jsonl, saves all discovered companions to the vault, and returns the primary + full list.
	mux.HandleFunc("POST /api/parse", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 128<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fname := r.Header.Get("X-Filename")
		pw := r.Header.Get("X-Zip-Password")
		results, err := ParseArchiveOrFileWithPassword(body, fname, pw)
		if err != nil || len(results) == 0 {
			if err == nil {
				err = fmt.Errorf("no companions found")
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var saved []*CompanionRecord
		for _, res := range results {
			rec := vault.UpsertFromImport(res, "")
			if len(res.AvatarPNG) > 0 {
				rec.AvatarBase64 = base64.StdEncoding.EncodeToString(res.AvatarPNG)
				_ = vault.SaveRecord(rec)
			}
			saved = append(saved, rec)
		}

		primary := saved[0]
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":            primary.ID,
			"source_format": primary.SourceFormat,
			"card":          primary.Card,
			"voice":         primary.Voice,
			"history":       primary.History,
			"episodes":      primary.Episodes,
			"stats":         primary.Stats,
			"avatar_base64": primary.AvatarBase64,
			"imported_all":  saved,
		})
	})

	mux.HandleFunc("GET /api/vault", func(w http.ResponseWriter, _ *http.Request) {
		list := vault.List()
		type summary struct {
			ID           string      `json:"id"`
			Name         string      `json:"name"`
			SourceFormat string      `json:"source_format"`
			PinnedModel  string      `json:"pinned_model,omitempty"`
			UpdatedAt    string      `json:"updated_at"`
			Stats        ImportStats `json:"stats"`
		}
		out := make([]summary, 0, len(list))
		for _, r := range list {
			out = append(out, summary{
				ID:           r.ID,
				Name:         r.Card.Data.Name,
				SourceFormat: r.SourceFormat,
				PinnedModel:  r.PinnedModel,
				UpdatedAt:    r.UpdatedAt,
				Stats:        r.Stats,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	mux.HandleFunc("GET /api/vault/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		rec, ok := vault.Get(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rec)
	})

	mux.HandleFunc("PUT /api/vault/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var rec CompanionRecord
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&rec); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		rec.ID = id
		rec.Episodes = BuildEpisodicIndex(rec.History, rec.Card.Data.Name)
		rec.Voice = ComputeVoiceProfile(rec.History, rec.Card.Data.Name)
		rec.Stats.TotalTurns = len(rec.History)
		rec.Stats.EpisodeCount = len(rec.Episodes)
		if rec.Card.Data.CharacterBook != nil {
			rec.Stats.LorebookEntries = len(rec.Card.Data.CharacterBook.Entries)
		}
		if err := vault.SaveRecord(&rec); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rec)
	})

	mux.HandleFunc("DELETE /api/vault/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		vault.Delete(id)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deleted":true}`))
	})

	mux.HandleFunc("GET /api/search", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		hits := vault.Search(q, 25)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(hits)
	})

	mux.HandleFunc("POST /api/chat", func(w http.ResponseWriter, r *http.Request) {
		var req ChatRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := AssembleAndRunChat(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if req.CompanionID != "" {
			if rec, ok := vault.Get(req.CompanionID); ok {
				if strings.TrimSpace(req.UserMessage) != "" {
					rec.History = append(rec.History, NormalizedTurn{
						Role:      "user",
						Speaker:   "User",
						Text:      strings.TrimSpace(req.UserMessage),
						Timestamp: resp.Reply.Timestamp,
					})
				}
				rec.History = append(rec.History, resp.Reply)
				rec.Stats.TotalTurns = len(rec.History)
				rec.PinnedModel = req.Config.Model
				_ = vault.SaveRecord(rec)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})

	mux.HandleFunc("POST /api/distill", func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			CompanionID string           `json:"companion_id"`
			Card        TavernCardV2     `json:"card"`
			History     []NormalizedTurn `json:"history"`
			Config      LLMConfig        `json:"config"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		tmp := &ImportResult{
			Card:    payload.Card,
			History: payload.History,
		}
		EnrichImportResult(tmp)
		if err := DistillWithLLM(tmp, payload.Config); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if payload.CompanionID != "" {
			if rec, ok := vault.Get(payload.CompanionID); ok {
				rec.Card = tmp.Card
				rec.Stats.LorebookEntries = len(tmp.Card.Data.CharacterBook.Entries)
				_ = vault.SaveRecord(rec)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tmp)
	})

	mux.HandleFunc("POST /api/card.png", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 24<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Accept either a raw TavernCardV2 or {"card": ..., "avatar_base64": "..."}
		var wrapper struct {
			Card         *TavernCardV2 `json:"card"`
			AvatarBase64 string        `json:"avatar_base64"`
		}
		var card TavernCardV2
		var customAvatar []byte
		if err := json.Unmarshal(body, &wrapper); err == nil && wrapper.Card != nil {
			card = *wrapper.Card
			if wrapper.AvatarBase64 != "" {
				customAvatar, _ = base64.StdEncoding.DecodeString(wrapper.AvatarBase64)
			}
		} else if err := json.Unmarshal(body, &card); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		pngBytes, err := EncodeTavernPNG(card, customAvatar)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	})

	return mux
}

func baseNameWithoutExt(p string) string {
	b := filepath.Base(p)
	ext := filepath.Ext(b)
	name := strings.TrimSuffix(b, ext)
	if name == "" || name == "." || name == "/" {
		return "Companion"
	}
	return name
}
