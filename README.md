# Lifeboat

**Live app (100% offline in-browser):** https://lifeboat-22u.pages.dev

**100% offline, in-browser rescue and migration tool for AI companions.**

Drop your password-protected **Character.AI** GDPR `.zip`, **ChatGPT (`#Keep4o`)** export, **Replika** bundle, or **SillyTavern** archive. Everything unlocks, parses, and exports strictly inside your browser — zero servers, zero tracking, zero uploads.

> **Verify it yourself:** load the page, turn on **Airplane Mode / disconnect Wi-Fi**, then drop your `.zip`.

## What It Rescues

- **Character.AI official encrypted GDPR `.zip`** — unlocks ZipCrypto & WinZip AES-256 archives directly in the browser (auto-retrying trimmed lowercase account email), even when Windows Explorer or macOS Archive Utility throws errors. Parses `<username>/data/{message.json, character.json, user.json}`, older `histories.json`, `amavie.character-ai-export`, and CAI Tools exports.
- **ChatGPT (`#Keep4o`) `conversations.json`** — walks the active `current_node -> parent` branch (excluding dead regenerations), filters by `gpt-4o`, extracts embedded Custom Instructions (`user_editable_context`), lets you paste ChatGPT Memories, and **merges multiple threads into one unified companion**.
- **Replika archives** — merges `chat_history.json` with `memory.json` facts and `diary.json` entries.
- **SillyTavern / Tavern V1/V2/V3 `.png`, `.charx`, `.jsonl`** — full UTF-8/emoji-safe round-trip.

## Rescue Outputs

1. **Offline Keepsake Scrapbook (`.html` + `.md`)** — self-contained, searchable, dark/light chat-bubble book (print-to-PDF ready, zero external assets).
2. **Claude Project Pack (`.zip`)** — `01_project_instructions.txt`, `02_memory_bible.md`, `03_voice_samples.md`, `04_recent_continuity.md`, and step-by-step import instructions.
3. **Auto-Fitted Destination Prompts** — copy-paste prompts fitted to exact character budgets for **Kindroid**, **Grok / Mistral**, and **ChatGPT Custom Instructions**.
4. **SillyTavern / Janitor / Chub / Backyard Pack** — dual-chunk Tavern V2 (`chara`) + V3 (`ccv3`) `.png` card + World Info Lorebook `.json` + full importable `.jsonl` chat history.
5. **Anonymized "Rescued" Proof Card (`.png`)** — shareable archive stats with zero private chat text.

## Local Build & Tests

```sh
npm install
npm run build        # bundles src/ -> site/app.js via esbuild
npm test             # Node built-in unit tests (encrypted zips, parsers, PNG V2/V3, exporters)
```

### Optional Go CLI (Offline Terminal / Local Vault)

```sh
go test -count=1 ./...
go build -o lifeboat .
./lifeboat convert -password your@email.com -o card.png export.zip
./lifeboat recall -password your@email.com export.zip "lighthouse"
./lifeboat serve -addr 127.0.0.1:8090
```

## License

MIT
