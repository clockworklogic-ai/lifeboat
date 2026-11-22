import test from "node:test";
import assert from "node:assert/strict";

import { buildZipBundle, extractZipArchive } from "../src/zip.js";
import { parseFileMap, parseSingleFile } from "../src/parsers.js";
import {
  mergeCompanions,
  recallEpisodes,
  swapCompanionSpeakers,
} from "../src/compiler.js";
import { decodeTavernPNG, encodeTavernPNG } from "../src/pngcard.js";
import {
  exportClaudeProjectPack,
  exportLorebookWorldInfoJSON,
  exportPlatformPrompts,
  exportReadableHTML,
  exportReadableMarkdown,
  exportSillyTavernJSONL,
} from "../src/exporters.js";
import { loadSampleArchive } from "../src/sample.js";

test("encrypted Character.AI GDPR zip: password prompt, wrong pw, auto-lowercase email unlock, and data/message.json parse", async () => {
  const characterJson = JSON.stringify([
    {
      external_id: "bot-42",
      name: "Vesper",
      title: "Keeper of the Harbor Lantern",
      description: "Quiet lighthouse keeper with dry wit.",
      greeting: '*Vesper trims the lantern wick.* "Storm is coming in fast."',
    },
  ]);
  const messageJson = JSON.stringify([
    {
      chat_id: "c-100",
      character_id: "bot-42",
      create_time: "2026-01-10T10:02:00Z",
      raw_content: "Did the supply boat reach New Harbour before the fog?",
    },
    {
      chat_id: "c-100",
      character_id: "bot-42",
      create_time: "2026-01-10T10:00:00Z",
      raw_content: '*Vesper trims the lantern wick.* "Storm is coming in fast."',
    },
    {
      chat_id: "c-100",
      character_id: "bot-42",
      create_time: "2026-01-10T10:03:00Z",
      raw_content: '*He glances toward New Harbour pier.* "Barely. They dropped the kerosene crate and left."',
    },
  ]);
  const userJson = JSON.stringify({ username: "alice_w", name: "Alice" });

  // Encrypt with ZipCrypto (matching classic Character.AI export) using lowercase email
  const encryptedZip = await buildZipBundle(
    [
      { name: "alice_w/data/character.json", content: characterJson },
      { name: "alice_w/data/message.json", content: messageJson },
      { name: "alice_w/data/user.json", content: userJson },
    ],
    { password: "alice.smith@example.com", entryOptions: { zipCrypto: true } }
  );

  // 1. Without password -> needs_password
  const needPw = await extractZipArchive(encryptedZip, "");
  assert.equal(needPw.status, "needs_password");
  assert.equal(needPw.encryptedCount, 3);

  // 2. Wrong password -> wrong_password
  const wrongPw = await extractZipArchive(encryptedZip, "wrong@example.com");
  assert.equal(wrongPw.status, "wrong_password");

  // 3. Mixed-case email with whitespace -> auto-retries trimmed lowercase!
  const unlocked = await extractZipArchive(encryptedZip, "  Alice.Smith@Example.COM  ");
  assert.equal(unlocked.status, "ok");
  assert.equal(unlocked.unlockedWithLowercase, true);

  // 4. Parse official data/message.json + character.json layout
  const comps = parseFileMap(unlocked.files, "characterai-export.zip");
  assert.equal(comps.length, 1);
  assert.equal(comps[0].card.data.name, "Vesper");
  assert.equal(comps[0].stats.total_turns, 3);
  assert.equal(comps[0].speakersInferred, true);
  // Sorted chronologically by create_time (10:00 greeting first, then 10:02 user, then 10:03 bot)
  assert.match(comps[0].history[0].text, /lantern wick/);
  assert.equal(comps[0].history[0].role, "assistant");
  assert.equal(comps[0].history[1].role, "user");
  assert.equal(comps[0].history[2].role, "assistant");

  // 5. Swap User <-> Bot works cleanly
  const swapped = swapCompanionSpeakers(comps[0], "Alice");
  assert.equal(swapped.speakersInferred, false);
  assert.equal(swapped.history[0].role, "user");
  assert.equal(swapped.history[1].role, "assistant");
});

test("AES-256 encrypted zip also unlocks cleanly", async () => {
  const zipBytes = await buildZipBundle(
    [{ name: "chat.jsonl", content: '{"user_name":"Jo","character_name":"Lumen"}\n{"name":"Lumen","is_user":false,"mes":"Hello from AES."}\n' }],
    { password: "jo@example.com" }
  );
  const res = await extractZipArchive(zipBytes, "JO@EXAMPLE.COM");
  assert.equal(res.status, "ok");
  const comps = parseFileMap(res.files, "aes.zip");
  assert.equal(comps[0].card.data.name, "Lumen");
});

test("ChatGPT #Keep4o: active branch walk excludes dead regenerations, detects gpt-4o, extracts Custom Instructions, and merges threads", () => {
  const sample = loadSampleArchive();
  const gpt4oThreads = sample.filter((c) => c.hasGpt4o);
  assert.equal(gpt4oThreads.length, 2);

  // Dead regenerated branch must NOT appear in active timeline
  for (const c of gpt4oThreads) {
    for (const t of c.history) {
      assert.doesNotMatch(t.text, /DEAD REGENERATED BRANCH/);
    }
  }

  // Custom instructions from user_editable_context preserved
  const lateNight = gpt4oThreads.find((c) => c.card.data.name.includes("Late Night"));
  assert.ok(lateNight);
  assert.match(lateNight.customInstructions, /tabby cat named Miso/);
  assert.match(lateNight.customInstructions, /Call yourself Solstice/);

  // Non-4o thread excluded from hasGpt4o filter
  const sqlThread = sample.find((c) => c.card.data.name.includes("SQL"));
  assert.ok(sqlThread);
  assert.equal(sqlThread.hasGpt4o, false);
  assert.equal(sqlThread.dominantModel, "gpt-5");

  // Merge the two GPT-4o threads into one unified companion
  const merged = mergeCompanions(gpt4oThreads, "Solstice");
  assert.equal(merged.card.data.name, "Solstice");
  assert.equal(merged.stats.total_turns, gpt4oThreads[0].stats.total_turns + gpt4oThreads[1].stats.total_turns);
  assert.equal(merged.hasGpt4o, true);
  // BM25 recall finds Kyoto train detail across merged archive
  const hits = recallEpisodes(merged.episodes, "cracked watch Kyoto train Elena", 3);
  assert.ok(hits.length > 0);
  assert.match(hits[0].transcript, /cracked watch/i);
});

test("Tavern V2/V3 PNG codec handles UTF-8 emojis & curly quotes round-trip", async () => {
  const sample = loadSampleArchive();
  const comp = sample[0];
  comp.card.data.description = "Café Noir ☕ — “Never forget New Harbour ✨” (日本語テスト)";
  const pngBytes = await encodeTavernPNG(comp.card, null, "Character.AI");
  const decoded = decodeTavernPNG(pngBytes);
  assert.equal(decoded.spec, "chara_card_v2");
  assert.equal(decoded.data.name, comp.card.data.name);
  assert.equal(decoded.data.description, comp.card.data.description);
  assert.equal(decoded.data.character_book.entries.length, comp.card.data.character_book.entries.length);
});

test("Exporters: Claude Pack, Kindroid/Grok/ChatGPT char limits, safe offline HTML scrapbook, and SillyTavern JSONL round-trip", () => {
  const sample = loadSampleArchive();
  const comp = sample[0];
  const extraMem = "User prefers quiet rainy scenes and drinks decaf oat lattes.";

  // Claude Project Pack
  const claude = exportClaudeProjectPack(comp, extraMem);
  assert.ok(claude["01_project_instructions.txt"].includes("Kaelen Vance"));
  assert.ok(claude["02_memory_bible.md"].includes("decaf oat lattes"));
  assert.ok(claude["03_voice_samples.md"].includes("Kaelen Vance"));
  assert.ok(claude["04_recent_continuity.md"].includes("brass compass"));
  assert.ok(claude["README_HOW_TO_IMPORT.txt"].includes("Projects"));

  // Platform prompt character budgets
  const prompts = exportPlatformPrompts(comp, extraMem);
  assert.ok(prompts.kindroid.backstory.length <= 2500);
  assert.ok(prompts.kindroid.keyMemories.length <= 1000);
  assert.ok(prompts.kindroid.responseDirective.length <= 150);
  assert.ok(prompts.kindroid.exampleMessage.length <= 750);
  assert.ok(prompts.grokMistral.systemPrompt.length <= 4000);
  assert.ok(prompts.chatgpt.aboutUser.length <= 1500);
  assert.ok(prompts.chatgpt.howToRespond.length <= 1500);

  // Offline HTML Scrapbook — zero external links/scripts & XSS escaped
  comp.history.push({ role: "user", speaker: "Alex", text: '<script>alert("xss")</script>', timestamp: "" });
  const html = exportReadableHTML(comp, extraMem);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);

  // Markdown & Lorebook World Info
  const md = exportReadableMarkdown(comp, extraMem);
  assert.match(md, /# Kaelen Vance/);
  const lore = JSON.parse(exportLorebookWorldInfoJSON(comp));
  assert.ok(Object.keys(lore.entries).length > 0);

  // SillyTavern JSONL round-trip
  const jsonl = exportSillyTavernJSONL(comp, "Alex");
  const reimported = parseSingleFile(new TextEncoder().encode(jsonl), "kaelen.jsonl");
  assert.equal(reimported.length, 1);
  assert.equal(reimported[0].card.data.name, "Kaelen Vance");
  assert.equal(reimported[0].stats.total_turns, comp.history.length);
});

test("Replika bundle & amavie.character-ai-export parse cleanly", () => {
  const enc = new TextEncoder();
  const repMap = new Map([
    [
      "chat_history.json",
      enc.encode(
        JSON.stringify({
          bot_name: "Clara",
          bio: "Stargazer",
          chat_history: [
            { sender: "bot", text: "Did you see Orion tonight?" },
            { sender: "user", text: "Yes, crystal clear over Ottawa." },
          ],
        })
      ),
    ],
    ["memory.json", enc.encode(JSON.stringify({ facts: [{ text: "User fosters rescue cats" }] }))],
    ["diary.json", enc.encode(JSON.stringify([{ title: "Clear Sky", text: "We watched Orion together." }]))],
  ]);
  const rep = parseFileMap(repMap, "replika.zip");
  assert.equal(rep.length, 1);
  assert.equal(rep[0].card.data.name, "Clara");
  assert.ok(rep[0].card.data.character_book.entries.some((e) => e.content.includes("fosters rescue cats")));

  const amavie = {
    format: "amavie.character-ai-export",
    version: 1,
    characters: [{ external_id: "c1", name: "Sora", description: "Sky pilot", greeting: "Ready for takeoff?" }],
    chats: [
      {
        chat_id: "ch1",
        character_id: "c1",
        character_name: "Sora",
        messages: [
          { create_time: "2026-10-01T12:00:00Z", raw_content: "Ready for takeoff?", author: { name: "Sora", is_human: false } },
          { create_time: "2026-10-01T12:01:00Z", raw_content: "Always.", author: { name: "Pilot", is_human: true } },
        ],
      },
    ],
  };
  const parsedAmavie = parseSingleFile(enc.encode(JSON.stringify(amavie)), "amavie.json");
  assert.equal(parsedAmavie[0].card.data.name, "Sora");
  assert.equal(parsedAmavie[0].stats.total_turns, 2);
});
