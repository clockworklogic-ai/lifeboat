// Multi-platform companion archive parsers (100% client-side).
// Handles:
//   - Character.AI official GDPR zip (data/message.json + data/character.json + data/user.json)
//   - Character.AI older histories.json + characters.json, CAI Tools, amavie.character-ai-export
//   - ChatGPT GDPR export (conversations.json active-branch walk, model_slug, user_editable_context)
//   - Replika export zip (chat_history.json + memory.json + diary.json)
//   - SillyTavern .jsonl, Tavern V1/V2/V3 .json & .png, .charx archives

import {
  buildCardFromParts,
  buildExampleDialogue,
  computeVoiceProfile,
  enrichCompanion,
  extractLorebook,
} from "./compiler.js";
import { decodeTavernPNG, isPNG } from "./pngcard.js";

const td = new TextDecoder("utf-8", { fatal: false });

function decodeText(bytes) {
  return typeof bytes === "string" ? bytes : td.decode(bytes);
}

function baseNameWithoutExt(p = "") {
  const seg = String(p).replace(/\\/g, "/").split("/").pop() || "";
  const dot = seg.lastIndexOf(".");
  const base = dot > 0 ? seg.slice(0, dot) : seg;
  return base || "Companion";
}

function cleanStr(v, fallback = "") {
  if (typeof v !== "string") return fallback;
  return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

function strField(obj, ...keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k].trim()) return cleanStr(obj[k]);
  }
  return "";
}

function normalizeTimestamp(val) {
  if (val == null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    // Seconds vs milliseconds vs microseconds
    const ms = val > 1e14 ? val / 1000 : val > 1e11 ? val : val * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return "";
    if (/^\d+(\.\d+)?$/.test(s)) return normalizeTimestamp(Number(s));
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return s;
  }
  return "";
}

function findEntry(filesMap, exactSuffixes) {
  const targets = exactSuffixes.map((s) => s.toLowerCase());
  for (const [k, v] of filesMap.entries()) {
    const lower = k.toLowerCase();
    for (const suf of targets) {
      if (lower === suf || lower.endsWith("/" + suf)) {
        return { name: k, bytes: v };
      }
    }
  }
  return null;
}

function makeID(prefix, idx, name) {
  const slug = String(name || "companion")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "companion";
  return `${prefix}-${idx}-${slug}`;
}

export function parseFileMap(filesMap, archiveName = "archive", avatars = []) {
  const results = [];

  // 1. CharX (.charx) V3 archive with card.json
  const charxCard = findEntry(filesMap, ["card.json"]);
  if (charxCard) {
    const parsed = parseSingleFile(charxCard.bytes, baseNameWithoutExt(archiveName));
    if (parsed.length > 0) {
      if (avatars.length > 0) parsed[0].avatarPNG = avatars[0];
      return parsed;
    }
  }

  // 2. ChatGPT GDPR export (conversations.json + optional user.json)
  const chatgptConv = findEntry(filesMap, ["conversations.json"]);
  if (chatgptConv) {
    const userEntry = findEntry(filesMap, ["user.json"]);
    const userName = extractUserName(userEntry?.bytes);
    const parsed = tryParseChatGPTConversations(decodeText(chatgptConv.bytes), userName);
    if (parsed.length > 0) return parsed;
  }

  // 3. Character.AI Official GDPR export (data/message.json + data/character.json + data/user.json)
  const caiMessage = findEntry(filesMap, ["message.json", "messages.json"]);
  const caiCharacter = findEntry(filesMap, ["character.json", "characters.json"]);
  const caiUser = findEntry(filesMap, ["user.json"]);
  if (caiMessage) {
    const parsed = parseCAIOfficialGDPR(
      decodeText(caiMessage.bytes),
      caiCharacter ? decodeText(caiCharacter.bytes) : "",
      caiUser ? decodeText(caiUser.bytes) : ""
    );
    if (parsed.length > 0) return parsed;
  }

  // 4. Character.AI older GDPR / CAI Tools bundle (histories.json + optional characters.json)
  const caiHist = findEntry(filesMap, ["histories.json"]);
  if (caiHist) {
    const parsed = parseCAIHistoriesZip(
      decodeText(caiHist.bytes),
      caiCharacter ? decodeText(caiCharacter.bytes) : ""
    );
    if (parsed.length > 0) return parsed;
  }

  // 5. Replika export bundle (chat_history.json + memory.json + diary.json)
  const repChat = findEntry(filesMap, ["chat_history.json"]);
  if (repChat) {
    const repMem = findEntry(filesMap, ["memory.json"]);
    const repDiary = findEntry(filesMap, ["diary.json"]);
    const parsed = parseReplikaBundle(
      decodeText(repChat.bytes),
      repMem ? decodeText(repMem.bytes) : "",
      repDiary ? decodeText(repDiary.bytes) : "",
      baseNameWithoutExt(archiveName)
    );
    if (parsed) return [parsed];
  }

  // 6. Fallback: scan every .json / .jsonl / .png in the drop
  const sortedNames = [...filesMap.keys()].sort();
  for (const name of sortedNames) {
    const lower = name.toLowerCase();
    const bytes = filesMap.get(name);
    if (lower.endsWith("user.json") || lower.endsWith("user_settings.json")) continue;
    try {
      if (lower.endsWith(".png") && isPNG(bytes)) {
        const list = parseSingleFile(bytes, name);
        results.push(...list);
      } else if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
        const list = parseSingleFile(bytes, name);
        results.push(...list);
      }
    } catch {
      // Ignore auxiliary non-chat JSON files inside zips
    }
  }

  if (results.length === 0) {
    throw new Error(
      "No recognizable Character.AI, ChatGPT, Replika, or SillyTavern export files were found."
    );
  }
  results.sort((a, b) => (b.stats?.total_turns || 0) - (a.stats?.total_turns || 0));
  return results;
}

export function parseSingleFile(rawBytes, filename = "export.json") {
  if (!rawBytes || rawBytes.length === 0) {
    throw new Error("Empty file");
  }

  // PNG Tavern V2/V3 card
  if (isPNG(rawBytes)) {
    const card = decodeTavernPNG(rawBytes);
    const firstMes = card.data?.first_mes || "";
    const turns = firstMes
      ? [{ role: "assistant", speaker: card.data.name || "Companion", text: firstMes, timestamp: "" }]
      : [];
    const comp = enrichCompanion({
      id: makeID("png", 0, card.data?.name),
      source_format: "tavern_png",
      sourceLabel: "Tavern PNG Card",
      card,
      history: turns,
      avatarPNG: rawBytes,
      speakersInferred: false,
    });
    return [comp];
  }

  const text = decodeText(rawBytes).trim();
  if (!text) throw new Error("Empty text export");
  const fallbackName = baseNameWithoutExt(filename);

  // JSONL (SillyTavern / CAI Tools JSONL)
  if (text.startsWith("{") && /\r?\n\s*\{/.test(text)) {
    return [parseJSONL(text, fallbackName)];
  }

  // JSON array (could be ChatGPT conversations.json, C.AI message.json, or generic message list)
  if (text.startsWith("[")) {
    const cg = tryParseChatGPTConversations(text, "User");
    if (cg.length > 0) return cg;

    let arr;
    try {
      arr = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON array in ${filename}: ${err.message}`);
    }
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "object") {
      // Check if official Character.AI flat message.json
      if (looksLikeCAIOfficialMessages(arr)) {
        const cai = parseCAIOfficialGDPR(text, "", "");
        if (cai.length > 0) return cai;
      }
      return [buildCompanionFromMessages("json_array", "JSON Transcript", arr, fallbackName, "User", "", "")];
    }
    throw new Error("Empty JSON array");
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse JSON in ${filename}: ${err.message}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Unsupported export format");
  }

  // amavie.character-ai-export community format
  if (obj.format === "amavie.character-ai-export" || (Array.isArray(obj.chats) && Array.isArray(obj.characters))) {
    return parseAmavieExport(obj);
  }

  // Tavern V2 / V3 JSON card
  if (obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3") {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: obj.data || {},
    };
    const turns = card.data.first_mes
      ? [{ role: "assistant", speaker: card.data.name || fallbackName, text: card.data.first_mes, timestamp: "" }]
      : [];
    return [
      enrichCompanion({
        id: makeID("tavern", 0, card.data.name),
        source_format: "tavern_v2",
        sourceLabel: "Tavern V2/V3 Card",
        card,
        history: turns,
        speakersInferred: false,
      }),
    ];
  }

  // Character.AI histories wrapper
  if (obj.histories) {
    return parseCAIHistoriesObject(obj, fallbackName);
  }

  // Replika chat_history
  if (Array.isArray(obj.chat_history)) {
    const name = strField(obj, "bot_name", "replika_name", "name") || fallbackName || "Replika";
    return [
      buildCompanionFromMessages(
        "replika",
        "Replika",
        obj.chat_history,
        name,
        "User",
        strField(obj, "bio", "description"),
        ""
      ),
    ];
  }

  // Character.AI turns
  if (Array.isArray(obj.turns)) {
    return [
      buildCompanionFromMessages(
        "character_ai_turns",
        "Character.AI",
        obj.turns,
        strField(obj, "character_name", "name") || fallbackName,
        "User",
        strField(obj, "description"),
        ""
      ),
    ];
  }

  // Messages wrapper (could be official C.AI {"messages": [...]} with chat_id/raw_content)
  if (Array.isArray(obj.messages)) {
    if (looksLikeCAIOfficialMessages(obj.messages)) {
      const cai = parseCAIOfficialGDPR(JSON.stringify(obj.messages), "", "");
      if (cai.length > 0) return cai;
    }
    return [
      buildCompanionFromMessages(
        "messages_json",
        "Chat JSON",
        obj.messages,
        strField(obj, "character_name", "name") || fallbackName,
        "User",
        strField(obj, "description", "persona"),
        ""
      ),
    ];
  }

  // Tavern V1 flat card
  if (typeof obj.name === "string" && obj.name && ("first_mes" in obj || "description" in obj)) {
    const card = buildCardFromParts({
      name: obj.name,
      description: cleanStr(obj.description),
      personality: cleanStr(obj.personality),
      scenario: cleanStr(obj.scenario),
      firstMes: cleanStr(obj.first_mes),
      mesExample: cleanStr(obj.mes_example),
      sourceFormat: "tavern_v1",
    });
    const turns = obj.first_mes
      ? [{ role: "assistant", speaker: obj.name, text: cleanStr(obj.first_mes), timestamp: "" }]
      : [];
    return [
      enrichCompanion({
        id: makeID("tavern1", 0, obj.name),
        source_format: "tavern_v1",
        sourceLabel: "Tavern V1 Card",
        card,
        history: turns,
        speakersInferred: false,
      }),
    ];
  }

  throw new Error(`Unrecognized companion export format in ${filename}`);
}

function extractUserName(rawBytes) {
  if (!rawBytes) return "User";
  try {
    const u = JSON.parse(decodeText(rawBytes));
    return strField(u, "name", "username", "first_name") || "User";
  } catch {
    return "User";
  }
}

function looksLikeCAIOfficialMessages(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const sample = arr.slice(0, 10);
  return sample.some(
    (m) => m && typeof m === "object" && ("raw_content" in m || "chat_id" in m || "candidate_id" in m)
  );
}

// Official Character.AI GDPR export: data/message.json + data/character.json + data/user.json
function parseCAIOfficialGDPR(messageText, characterText, userText) {
  let msgRaw;
  try {
    msgRaw = JSON.parse(messageText);
  } catch {
    return [];
  }
  const msgList = Array.isArray(msgRaw)
    ? msgRaw
    : Array.isArray(msgRaw?.messages)
      ? msgRaw.messages
      : Array.isArray(msgRaw?.data)
        ? msgRaw.data
        : [];
  if (msgList.length === 0) return [];

  // Parse user.json to identify human author IDs/usernames
  const userIds = new Set();
  let userName = "User";
  if (userText) {
    try {
      const u = JSON.parse(userText);
      const uObj = Array.isArray(u) ? u[0] : u?.user || u;
      if (uObj && typeof uObj === "object") {
        userName = strField(uObj, "name", "username", "first_name") || "User";
        for (const k of ["id", "user_id", "external_id", "username", "name"]) {
          if (uObj[k] != null && String(uObj[k]).trim()) {
            userIds.add(String(uObj[k]).trim().toLowerCase());
          }
        }
      }
    } catch {
      // ignore malformed user.json
    }
  }

  // Parse character.json to recover character names, descriptions, greetings, definitions
  const charById = new Map();
  const charList = [];
  if (characterText) {
    try {
      const cRaw = JSON.parse(characterText);
      const arr = Array.isArray(cRaw)
        ? cRaw
        : Array.isArray(cRaw?.characters)
          ? cRaw.characters
          : Array.isArray(cRaw?.data)
            ? cRaw.data
            : [];
      for (const c of arr) {
        if (!c || typeof c !== "object") continue;
        charList.push(c);
        for (const k of ["external_id", "character_id", "id", "participant__user__username", "name"]) {
          const val = c[k];
          if (val != null && String(val).trim()) {
            charById.set(String(val).trim(), c);
          }
        }
      }
    } catch {
      // ignore malformed character.json
    }
  }

  // Group flat messages by chat_id (or character_id)
  const groups = new Map();
  for (const m of msgList) {
    if (!m || typeof m !== "object") continue;
    const text = extractMessageText(m);
    if (!text) continue;
    const chatId = String(
      m.chat_id || m.history_id || m.character_id || m.character_external_id || "default"
    );
    if (!groups.has(chatId)) groups.set(chatId, []);
    groups.get(chatId).push(m);
  }

  const results = [];
  let idx = 0;

  for (const [chatId, msgs] of groups.entries()) {
    // Sort chronologically by create_time / timestamp
    msgs.sort((a, b) => {
      const ta = Date.parse(normalizeTimestamp(a.create_time || a.timestamp || a.created_at)) || 0;
      const tb = Date.parse(normalizeTimestamp(b.create_time || b.timestamp || b.created_at)) || 0;
      return ta - tb;
    });

    // Deduplicate multi-candidate swipes on the same turn_id if primary_candidate_id exists
    const deduped = deduplicateTurnCandidates(msgs);

    // Try matching a character definition from character.json
    let charMeta = null;
    for (const m of deduped) {
      const cid = String(m.character_id || m.character_external_id || m.author?.author_id || "");
      if (cid && charById.has(cid)) {
        charMeta = charById.get(cid);
        break;
      }
    }
    // Also check if the very first message matches a character's greeting text
    if (!charMeta && charList.length > 0 && deduped.length > 0) {
      const firstText = extractMessageText(deduped[0]).slice(0, 80);
      if (firstText.length >= 20) {
        charMeta = charList.find((c) => cleanStr(c.greeting).startsWith(firstText)) || null;
      }
    }

    let charName = charMeta
      ? strField(charMeta, "name", "participant__name", "title")
      : "";
    if (!charName) {
      for (const m of deduped) {
        const exp = extractExplicitRole(m, userIds);
        if (exp && exp.role === "assistant" && exp.speaker && exp.speaker !== "Character") {
          charName = exp.speaker;
          break;
        }
      }
    }
    if (!charName) {
      charName = chatId === "default" ? "Character.AI Chat" : `Character.AI Chat (${chatId.slice(0, 8)})`;
    }

    // Determine roles: use explicit flags when present, otherwise infer from C.AI structure
    let explicitCount = 0;
    for (const m of deduped) {
      if (extractExplicitRole(m, userIds)) explicitCount++;
    }
    const speakersInferred = explicitCount < deduped.length * 0.5;

    const turns = [];
    // In Character.AI, chats start with the character's greeting (turn 0 = assistant) followed by user (turn 1),
    // unless a turn has explicit human metadata.
    let nextInferredRole = "assistant";
    for (let i = 0; i < deduped.length; i++) {
      const m = deduped[i];
      const text = extractMessageText(m);
      if (!text) continue;
      const ts = normalizeTimestamp(m.create_time || m.timestamp || m.created_at || m.send_date);
      const explicit = extractExplicitRole(m, userIds);
      let role;
      let speaker;
      if (explicit) {
        role = explicit.role;
        speaker = explicit.speaker || (role === "assistant" ? charName : userName);
        nextInferredRole = role === "assistant" ? "user" : "assistant";
      } else {
        // Heuristic: C.AI bot messages often have candidate_id + longer prose/asterisks, and chats open with greeting
        role = nextInferredRole;
        speaker = role === "assistant" ? charName : userName;
        nextInferredRole = role === "assistant" ? "user" : "assistant";
      }
      turns.push({ role, speaker, text, timestamp: ts });
    }

    if (turns.length === 0) continue;

    const descParts = [];
    if (charMeta) {
      const title = strField(charMeta, "title");
      const desc = strField(charMeta, "description");
      const def = strField(charMeta, "definition");
      if (title) descParts.push(title);
      if (desc && desc !== title) descParts.push(desc);
      if (def) descParts.push("\nCharacter Definition:\n" + def);
    }

    const comp = buildCompanionFromNormalized({
      id: makeID("cai", idx++, charName),
      sourceFormat: "character_ai_gdpr",
      sourceLabel: "Character.AI GDPR Export",
      turns,
      charName,
      explicitDesc: descParts.join("\n\n"),
      explicitGreeting: charMeta ? strField(charMeta, "greeting") : "",
      speakersInferred,
    });
    results.push(comp);
  }

  results.sort((a, b) => (b.stats?.total_turns || 0) - (a.stats?.total_turns || 0));
  return results;
}

function deduplicateTurnCandidates(msgs) {
  const seenTurn = new Set();
  const out = [];
  for (const m of msgs) {
    const tid = m.turn_id || m.turn_key?.turn_id;
    if (tid) {
      const key = String(tid);
      if (seenTurn.has(key)) continue;
      seenTurn.add(key);
    }
    out.push(m);
  }
  return out;
}

function parseAmavieExport(obj) {
  const charById = new Map();
  for (const c of obj.characters || []) {
    const id = strField(c, "external_id", "id", "name");
    if (id) charById.set(id, c);
  }
  const results = [];
  let idx = 0;
  for (const chat of obj.chats || []) {
    const meta = charById.get(chat.character_id) || {};
    const charName = strField(chat, "character_name") || strField(meta, "name") || `Character ${idx + 1}`;
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    if (msgs.length === 0) continue;
    const desc = [strField(meta, "description"), strField(meta, "definition")].filter(Boolean).join("\n\n");
    results.push(
      buildCompanionFromMessages(
        "character_ai_amavie",
        "Character.AI Export",
        msgs,
        charName,
        "User",
        desc,
        strField(meta, "greeting"),
        idx++
      )
    );
  }
  results.sort((a, b) => (b.stats?.total_turns || 0) - (a.stats?.total_turns || 0));
  return results;
}

function parseCAIHistoriesZip(histText, charText) {
  const charMeta = new Map();
  if (charText) {
    try {
      const arr = JSON.parse(charText);
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const id = strField(c, "external_id", "participant__user__username", "name");
          if (id) charMeta.set(id, c);
        }
      }
    } catch {
      // ignore
    }
  }
  let raw;
  try {
    raw = JSON.parse(histText);
  } catch {
    return [];
  }
  const histList = Array.isArray(raw) ? raw : Array.isArray(raw?.histories) ? raw.histories : [];
  const groups = new Map();
  for (const h of histList) {
    const cid = strField(h, "character_external_id", "character_id", "character_name");
    const msgs = Array.isArray(h.msgs) ? h.msgs : Array.isArray(h.turns) ? h.turns : [];
    if (msgs.length === 0) continue;
    let detected = cid;
    for (const m of msgs) {
      const r = extractExplicitRole(m, new Set());
      if (r && r.role === "assistant" && r.speaker && r.speaker !== "Character") {
        detected = r.speaker;
        break;
      }
    }
    const key = cid || detected || "Companion";
    if (!groups.has(key)) {
      const meta = charMeta.get(cid) || {};
      groups.set(key, {
        name: strField(meta, "name", "participant__name") || detected || "Companion",
        desc: strField(meta, "description", "title"),
        greeting: strField(meta, "greeting"),
        msgs: [],
      });
    }
    groups.get(key).msgs.push(...msgs);
  }
  const results = [];
  let idx = 0;
  for (const g of groups.values()) {
    results.push(
      buildCompanionFromMessages(
        "character_ai_gdpr",
        "Character.AI Export",
        g.msgs,
        g.name,
        "User",
        g.desc,
        g.greeting,
        idx++
      )
    );
  }
  results.sort((a, b) => (b.stats?.total_turns || 0) - (a.stats?.total_turns || 0));
  return results;
}

function parseCAIHistoriesObject(probe, fallbackName) {
  const charObj = probe.character || probe.info || {};
  const charName = strField(charObj, "name") || strField(probe, "character_name") || fallbackName || "Character";
  const desc = [strField(charObj, "description", "title"), strField(charObj, "definition")].filter(Boolean).join("\n\n");
  const greeting = strField(charObj, "greeting");

  const rawMsgs = [];
  const hists = Array.isArray(probe.histories)
    ? probe.histories
    : Array.isArray(probe.histories?.histories)
      ? probe.histories.histories
      : [];
  for (const h of hists) {
    const arr = Array.isArray(h.msgs) ? h.msgs : Array.isArray(h.turns) ? h.turns : [];
    rawMsgs.push(...arr);
  }
  return [
    buildCompanionFromMessages("character_ai", "Character.AI", rawMsgs, charName, "User", desc, greeting, 0),
  ];
}

// ChatGPT conversations.json (#Keep4o) — walks active branch from current_node -> parent,
// tracks metadata.model_slug, and extracts embedded Custom Instructions (user_editable_context).
export function tryParseChatGPTConversations(text, userName = "User") {
  let convs;
  try {
    convs = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(convs) || convs.length === 0) return [];
  if (!convs.some((c) => c && typeof c === "object" && c.mapping && typeof c.mapping === "object")) {
    return [];
  }

  const results = [];
  let idx = 0;

  for (const c of convs) {
    if (!c || typeof c !== "object" || !c.mapping) continue;
    const title = cleanStr(c.title, `ChatGPT Thread ${idx + 1}`);
    const mapping = c.mapping;

    // 1. Walk active branch from current_node back to root so regenerated/dead branches are excluded.
    let orderedNodes = [];
    if (c.current_node && mapping[c.current_node]) {
      const visited = new Set();
      let cur = c.current_node;
      while (cur && mapping[cur] && !visited.has(cur)) {
        visited.add(cur);
        orderedNodes.push(mapping[cur]);
        cur = mapping[cur].parent;
      }
      orderedNodes.reverse();
    } else {
      orderedNodes = Object.values(mapping).filter(Boolean);
      orderedNodes.sort((a, b) => (a?.message?.create_time || 0) - (b?.message?.create_time || 0));
    }

    const turns = [];
    let customSys = "";
    let aboutUser = "";
    let aboutModel = "";
    const modelCounts = new Map();
    let hasGpt4o = false;

    for (const node of orderedNodes) {
      const msg = node?.message;
      if (!msg || typeof msg !== "object") continue;

      const role = String(msg.author?.role || "").toLowerCase();
      const content = msg.content || {};
      const contentType = String(content.content_type || "");

      // OpenAI embeds Custom Instructions inside user_editable_context nodes!
      if (contentType === "user_editable_context") {
        const umd = msg.metadata?.user_context_message_data || {};
        if (typeof umd.about_user_message === "string" && umd.about_user_message.trim()) {
          aboutUser = umd.about_user_message.trim();
        }
        if (typeof umd.about_model_message === "string" && umd.about_model_message.trim()) {
          aboutModel = umd.about_model_message.trim();
        }
        continue;
      }

      const parts = Array.isArray(content.parts)
        ? content.parts.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
        : typeof content.text === "string" && content.text.trim()
          ? [content.text.trim()]
          : [];
      const fullText = parts.join("\n").trim();
      if (!fullText) continue;

      if (role === "system") {
        if (fullText.length > customSys.length) customSys = fullText;
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;

      const slug = cleanStr(msg.metadata?.model_slug || msg.metadata?.default_model_slug || "");
      if (slug) {
        modelCounts.set(slug, (modelCounts.get(slug) || 0) + 1);
        if (/4o|chatgpt-4o/i.test(slug)) hasGpt4o = true;
      }

      turns.push({
        role,
        speaker: role === "assistant" ? title : userName,
        text: fullText,
        timestamp: normalizeTimestamp(msg.create_time || c.create_time),
        model_slug: slug || undefined,
      });
    }

    if (turns.length === 0) continue;

    // Also check conversation-level default_model_slug
    const convSlug = cleanStr(c.default_model_slug || "");
    if (convSlug && /4o/i.test(convSlug)) hasGpt4o = true;
    const dominantModel =
      [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || convSlug || "";

    const customBlocks = [];
    if (customSys) customBlocks.push(customSys);
    if (aboutUser) customBlocks.push(`About User (ChatGPT Custom Instructions):\n${aboutUser}`);
    if (aboutModel) customBlocks.push(`How to Respond (ChatGPT Custom Instructions):\n${aboutModel}`);
    const customInstructions = customBlocks.join("\n\n");

    const extraLore = [];
    if (aboutUser || aboutModel) {
      extraLore.push({
        id: 1,
        name: "Custom Instructions (from ChatGPT)",
        keys: ["about me", "custom", "remember", title.toLowerCase()],
        content: [aboutUser && `About User: ${aboutUser}`, aboutModel && `Style/Persona: ${aboutModel}`]
          .filter(Boolean)
          .join("\n\n"),
        enabled: true,
        insertion_order: 135,
        case_sensitive: false,
        priority: 30,
        position: "before_char",
      });
    }

    const comp = buildCompanionFromNormalized({
      id: makeID("cgpt", idx++, title),
      sourceFormat: "chatgpt_export",
      sourceLabel: dominantModel ? `ChatGPT (${dominantModel})` : "ChatGPT Export",
      turns,
      charName: title,
      explicitDesc: customInstructions,
      explicitGreeting: "",
      extraLore,
      dominantModel,
      hasGpt4o,
      customInstructions,
      speakersInferred: false,
    });
    results.push(comp);
  }

  results.sort((a, b) => (b.stats?.total_turns || 0) - (a.stats?.total_turns || 0));
  return results;
}

function parseReplikaBundle(chatText, memText, diaryText, fallbackName) {
  let chatObj;
  try {
    chatObj = JSON.parse(chatText);
  } catch {
    return null;
  }
  const msgs = Array.isArray(chatObj) ? chatObj : Array.isArray(chatObj?.chat_history) ? chatObj.chat_history : [];
  if (msgs.length === 0) return null;

  const charName = strField(chatObj, "bot_name", "replika_name", "name") || fallbackName || "Replika";
  const extraLore = [];

  if (memText) {
    try {
      const memObj = JSON.parse(memText);
      const facts = Array.isArray(memObj) ? memObj : Array.isArray(memObj?.facts) ? memObj.facts : [];
      const factLines = facts
        .map((f) => (typeof f === "string" ? f.trim() : strField(f, "text", "value", "fact")))
        .filter(Boolean);
      if (factLines.length > 0) {
        extraLore.push({
          id: 1,
          name: "Replika Core Facts",
          keys: ["about me", "remember", "fact", "user", charName.toLowerCase()],
          content: "Saved Replika Facts:\n- " + factLines.join("\n- "),
          enabled: true,
          insertion_order: 135,
          case_sensitive: false,
          priority: 30,
          position: "before_char",
        });
      }
    } catch {
      // ignore
    }
  }

  if (diaryText) {
    try {
      const diaryArr = JSON.parse(diaryText);
      if (Array.isArray(diaryArr)) {
        diaryArr.slice(0, 8).forEach((d, i) => {
          const title = strField(d, "title") || `Diary Entry ${i + 1}`;
          const body = strField(d, "text", "content", "body");
          if (body) {
            extraLore.push({
              id: 2 + i,
              name: `Diary: ${title}`,
              keys: title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
              content: `${charName}'s Diary (${title}): ${body}`,
              enabled: true,
              insertion_order: 95 - i,
              case_sensitive: false,
              priority: 15,
              position: "after_char",
            });
          }
        });
      }
    } catch {
      // ignore
    }
  }

  return buildCompanionFromMessages(
    "replika_bundle",
    "Replika Archive",
    msgs,
    charName,
    "User",
    strField(chatObj, "bio", "description"),
    "",
    0,
    extraLore
  );
}

function parseJSONL(text, fallbackName) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rawMsgs = [];
  let charName = fallbackName;
  let userName = "User";
  for (const line of lines) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.character_name && m.mes == null && m.text == null && m.raw_content == null) {
      charName = cleanStr(m.character_name, charName);
      if (m.user_name) userName = cleanStr(m.user_name, userName);
      continue;
    }
    rawMsgs.push(m);
  }
  return buildCompanionFromMessages(
    "sillytavern_jsonl",
    "SillyTavern JSONL",
    rawMsgs,
    charName || "Companion",
    userName,
    "",
    "",
    0
  );
}

function extractMessageText(m) {
  for (const k of ["raw_content", "text", "mes", "content", "message", "body"]) {
    if (typeof m[k] === "string" && m[k].trim()) return cleanStr(m[k]);
  }
  if (Array.isArray(m.candidates) && m.candidates.length > 0) {
    const primary = m.primary_candidate_id
      ? m.candidates.find((c) => c?.candidate_id === m.primary_candidate_id) || m.candidates[0]
      : m.candidates[0];
    if (typeof primary?.raw_content === "string" && primary.raw_content.trim()) {
      return cleanStr(primary.raw_content);
    }
  }
  return "";
}

function extractExplicitRole(m, userIds) {
  if (typeof m.is_user === "boolean") {
    return { role: m.is_user ? "user" : "assistant", speaker: strField(m, "name", "speaker") };
  }
  if (typeof m.is_human === "boolean") {
    return { role: m.is_human ? "user" : "assistant", speaker: strField(m, "name", "speaker") };
  }
  if (m.src && typeof m.src === "object" && typeof m.src.is_human === "boolean") {
    return { role: m.src.is_human ? "user" : "assistant", speaker: strField(m.src, "name", "user__username") };
  }
  if (m.author && typeof m.author === "object") {
    if (typeof m.author.is_human === "boolean") {
      return { role: m.author.is_human ? "user" : "assistant", speaker: strField(m.author, "name") };
    }
    const aid = String(m.author.author_id || m.author.id || m.author.name || "").trim().toLowerCase();
    if (aid && userIds.has(aid)) {
      return { role: "user", speaker: strField(m.author, "name") };
    }
  }
  const roleStr = strField(m, "role", "sender", "author").toLowerCase();
  const speaker = strField(m, "name", "speaker");
  if (["user", "human", "me", "you"].includes(roleStr)) {
    return { role: "user", speaker };
  }
  if (["assistant", "bot", "character", "ai", "replika", "model"].includes(roleStr)) {
    return { role: "assistant", speaker };
  }
  if (m.user_id && userIds.has(String(m.user_id).toLowerCase())) {
    return { role: "user", speaker };
  }
  return null;
}

function buildCompanionFromMessages(
  sourceFormat,
  sourceLabel,
  rawMsgs,
  charName,
  userName,
  explicitDesc,
  explicitGreeting,
  idx = 0,
  extraLore = []
) {
  let detectedName = charName || "Companion";
  const turns = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const text = extractMessageText(m);
    if (!text) continue;
    const exp = extractExplicitRole(m, new Set());
    let role = exp?.role || "user";
    let speaker = exp?.speaker || (role === "assistant" ? detectedName : userName);
    if (!exp && speaker && speaker.toLowerCase() !== userName.toLowerCase() && speaker.toLowerCase() !== "user") {
      role = "assistant";
    }
    if (role === "assistant" && speaker && !["Character", "Companion", "assistant", "bot"].includes(speaker)) {
      detectedName = speaker;
    }
    turns.push({
      role,
      speaker: role === "assistant" ? (speaker || detectedName) : (speaker || userName),
      text,
      timestamp: normalizeTimestamp(m.create_time || m.timestamp || m.send_date || m.created_at),
    });
  }

  for (const t of turns) {
    if (t.role === "assistant" && (!t.speaker || t.speaker === "Character" || t.speaker === "Companion")) {
      t.speaker = detectedName;
    }
  }

  return buildCompanionFromNormalized({
    id: makeID(sourceFormat.slice(0, 6), idx, detectedName),
    sourceFormat,
    sourceLabel,
    turns,
    charName: detectedName,
    explicitDesc,
    explicitGreeting,
    extraLore,
    speakersInferred: false,
  });
}

function buildCompanionFromNormalized({
  id,
  sourceFormat,
  sourceLabel,
  turns,
  charName,
  explicitDesc,
  explicitGreeting,
  extraLore = [],
  dominantModel = "",
  hasGpt4o = false,
  customInstructions = "",
  speakersInferred = false,
}) {
  const firstMes =
    explicitGreeting || turns.find((t) => t.role === "assistant")?.text || "";
  const { mesExample } = buildExampleDialogue(turns, 6);
  const voice = computeVoiceProfile(turns, charName);
  const book = extractLorebook(turns, charName, extraLore);

  const totalWords = turns.reduce((s, t) => s + (t.text ? t.text.split(/\s+/).length : 0), 0);
  const desc =
    explicitDesc ||
    `${charName} — rescued from ${turns.length} exported turns (${totalWords.toLocaleString("en-US")} words). Voice profile: ${voice.style_lock_prompt}`;

  const lastTurn = turns[turns.length - 1];
  const scen = lastTurn
    ? `Continuing an established history of ${turns.length} turns with {{user}}. Most recent context (${lastTurn.speaker}): ${lastTurn.text.slice(0, 220)}`
    : `Ongoing conversation between ${charName} and {{user}}.`;

  const card = buildCardFromParts({
    name: charName,
    description: desc,
    personality: voice.style_lock_prompt,
    scenario: scen,
    firstMes,
    mesExample,
    book,
    sourceFormat,
  });

  return enrichCompanion({
    id,
    source_format: sourceFormat,
    sourceLabel,
    dominantModel,
    hasGpt4o,
    customInstructions,
    speakersInferred,
    card,
    history: turns,
    avatarPNG: null,
  });
}
