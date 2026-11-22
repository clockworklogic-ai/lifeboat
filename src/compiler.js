// Companion compiler: linguistic voice fingerprinting, multi-word entity lorebook extraction,
// Okapi BM25 episodic memory indexing, timeline span analysis, and multi-thread merging.

const TRIVIAL_STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "what", "when", "where",
  "which", "while", "your", "you", "are", "was", "were", "will", "would", "could", "should",
  "about", "into", "over", "after", "before", "there", "their", "they", "them", "then",
  "than", "just", "like", "know", "think", "really", "very", "some", "more", "most", "much",
  "here", "only", "been", "being", "also", "back", "down", "even", "still", "well", "good",
  "going", "make", "made", "want", "need", "take", "come", "look", "looks", "said", "says",
  "yeah", "okay", "sure", "right", "dont", "cant", "wont", "didnt", "isnt", "arent", "thats",
  "youre", "theyre", "ive", "im", "hes", "shes", "its", "not", "but", "can", "all", "one",
  "two", "out", "now", "how", "who", "why", "too", "had", "has", "did", "does", "got", "get",
  "let", "see", "way", "thing", "things", "something", "anything", "nothing", "everything",
  "someone", "anyone", "everyone", "little", "never", "always", "maybe", "actually",
]);

const STOP_CAPITALIZED = new Set([
  "The", "This", "That", "There", "Their", "Then", "They", "What", "When", "Where", "Which",
  "While", "With", "Would", "Could", "Should", "Have", "Here", "From", "Into", "Just", "Like",
  "Look", "Looks", "Well", "Yeah", "Your", "User", "Character", "Companion", "Some",
  "Something", "Nothing", "Everything", "After", "Before", "About", "Around", "Because",
  "Still", "Never", "Always", "Maybe", "Really", "Okay", "Sure", "Right", "Wait", "Please",
  "Sorry", "Thanks", "Thank", "Hello", "Hey", "Good", "Great", "Nice", "True", "False",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December", "Today", "Tomorrow", "Yesterday", "Tonight",
  "Also", "Even", "Though", "However", "Actually", "Honestly", "Perhaps", "Suddenly",
  "Slowly", "Quietly", "Softly", "Gently", "Finally", "Quickly", "Almost", "Inside", "Outside",
  "Through", "Without", "Under", "Between", "Against", "Every", "Another", "Other",
]);

export function tokenizeWords(text) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9']+/g);
  if (!matches) return [];
  return matches
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 0);
}

export function countWords(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  return s.split(/\s+/).length;
}

export function bestSentenceContaining(text, needle) {
  const sentences = String(text || "")
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lowerNeedle = needle.toLowerCase();
  for (const s of sentences) {
    if (s.toLowerCase().includes(lowerNeedle)) {
      return s.length > 200 ? s.slice(0, 197).trimEnd() + "..." : s;
    }
  }
  const clean = String(text || "").trim();
  return clean.length > 200 ? clean.slice(0, 197).trimEnd() + "..." : clean;
}

export function computeVoiceProfile(turns, charName = "Companion") {
  const lengths = [];
  let totalWords = 0;
  let actionTurns = 0;
  let dialogueTurns = 0;
  let questionTurns = 0;
  let emojiTurns = 0;
  let emDashTurns = 0;
  let ellipsisTurns = 0;
  let multiParagraphTurns = 0;
  let firstPerson = 0;
  let thirdPerson = 0;
  const ngramCounts = new Map();

  const emojiRe = /\p{Extended_Pictographic}/u;

  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const text = String(t.text || "").trim();
    if (!text) continue;
    const wc = countWords(text);
    if (wc === 0) continue;

    lengths.push(wc);
    totalWords += wc;
    if (/\*[^*\n]{2,}\*/.test(text)) actionTurns++;
    if (text.includes('"') || text.includes("“")) dialogueTurns++;
    if (text.includes("?")) questionTurns++;
    if (emojiRe.test(text)) emojiTurns++;
    if (text.includes("—") || text.includes(" -- ")) emDashTurns++;
    if (text.includes("...") || text.includes("…")) ellipsisTurns++;
    if (text.includes("\n\n")) multiParagraphTurns++;

    const words = tokenizeWords(text);
    for (const w of words) {
      if (w === "i" || w === "me" || w === "my" || w === "mine" || w === "myself") {
        firstPerson++;
      } else if (
        w === "he" || w === "him" || w === "his" ||
        w === "she" || w === "her" || w === "hers" ||
        w === "they" || w === "them" || w === "their"
      ) {
        thirdPerson++;
      }
    }

    const seenInTurn = new Set();
    for (let i = 0; i + 1 < words.length; i++) {
      const w1 = words[i];
      const w2 = words[i + 1];
      if (w1.length < 3 || w2.length < 3) continue;
      if (TRIVIAL_STOP.has(w1) || TRIVIAL_STOP.has(w2)) continue;
      if (/^\d+$/.test(w1) || /^\d+$/.test(w2)) continue;
      const bg = `${w1} ${w2}`;
      if (!seenInTurn.has(bg)) {
        seenInTurn.add(bg);
        ngramCounts.set(bg, (ngramCounts.get(bg) || 0) + 1);
      }
    }
  }

  const n = lengths.length;
  if (n === 0) {
    return {
      avg_words_per_turn: 0,
      median_words_per_turn: 0,
      action_ratio: 0,
      dialogue_ratio: 0,
      question_ratio: 0,
      emoji_ratio: 0,
      em_dash_ratio: 0,
      ellipsis_ratio: 0,
      pov: "mixed",
      top_phrases: [],
      style_lock_prompt: `Stay strictly in character as ${charName}.`,
    };
  }

  lengths.sort((a, b) => a - b);
  const avg = Math.round(totalWords / n);
  const median = lengths[Math.floor(n / 2)];
  const round2 = (x) => Math.round(x * 100) / 100;
  const actionRatio = round2(actionTurns / n);
  const dialogueRatio = round2(dialogueTurns / n);
  const questionRatio = round2(questionTurns / n);
  const emojiRatio = round2(emojiTurns / n);
  const emDashRatio = round2(emDashTurns / n);
  const ellipsisRatio = round2(ellipsisTurns / n);
  const multiParaRatio = round2(multiParagraphTurns / n);

  let pov = "first-person ('I/my') dialogue with narrative beats";
  if (thirdPerson > firstPerson * 2) {
    pov = "third-person narrative POV ('he/she/they')";
  } else if (firstPerson > thirdPerson * 2) {
    pov = "direct first-person POV ('I/me/my')";
  }

  const topPhrases = [...ngramCounts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, 8)
    .map(([p]) => p);

  const rules = [];
  rules.push(`Target ~${avg} words per reply (median ${median}).`);
  rules.push(`Write in ${pov}.`);

  if (actionRatio >= 0.5) {
    rules.push('Wrap physical actions, expressions, and sensory beats in *asterisks* and spoken lines in "double quotes".');
  } else if (actionRatio >= 0.2) {
    rules.push("Use occasional *asterisk* action beats alongside spoken dialogue.");
  } else {
    rules.push("Use natural conversational prose without theatrical *asterisk* stage directions.");
  }

  if (multiParaRatio >= 0.45) {
    rules.push("Break replies into distinct paragraphs for pacing.");
  }
  if (emojiRatio >= 0.25) {
    rules.push("Include warm, sparing emoji accents matching prior cadence.");
  } else if (emojiRatio <= 0.03) {
    rules.push("Avoid emojis.");
  }
  if (emDashRatio >= 0.25) {
    rules.push("Use em-dashes (—) naturally for conversational rhythm.");
  }
  if (questionRatio >= 0.45) {
    rules.push("Keep the exchange active with genuine follow-up questions.");
  }
  if (topPhrases.length > 0) {
    rules.push(`Recurring motifs/phrases from history: ${topPhrases.slice(0, 6).join(", ")}.`);
  }

  return {
    avg_words_per_turn: avg,
    median_words_per_turn: median,
    action_ratio: actionRatio,
    dialogue_ratio: dialogueRatio,
    question_ratio: questionRatio,
    emoji_ratio: emojiRatio,
    em_dash_ratio: emDashRatio,
    ellipsis_ratio: ellipsisRatio,
    pov,
    top_phrases: topPhrases,
    style_lock_prompt: rules.join(" "),
  };
}

export function buildExampleDialogue(turns, limit = 6) {
  const pairs = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    if (turns[i].role === "user" && turns[i + 1].role === "assistant") {
      const u = String(turns[i].text || "").trim();
      const c = String(turns[i + 1].text || "").trim();
      if (!u || c.length < 40 || c.length > 1200) continue;
      let score = Math.min(c.length, 600);
      if (/\*[^*\n]{2,}\*/.test(c)) score += 120;
      if (c.includes('"') || c.includes("“")) score += 80;
      if (u.length >= 25 && u.length <= 320) score += 60;
      pairs.push({ user: u, char: c, score, idx: i });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  // Pick diverse turns spread across the archive (not 6 consecutive messages)
  const chosen = [];
  for (const p of pairs) {
    if (chosen.length >= limit) break;
    if (chosen.every((c) => Math.abs(c.idx - p.idx) >= 4)) {
      chosen.push(p);
    }
  }
  for (const p of pairs) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  chosen.sort((a, b) => a.idx - b.idx);

  const formatted = chosen
    .map((p) => `<START>\n{{user}}: ${p.user}\n{{char}}: ${p.char}`)
    .join("\n");
  return { mesExample: formatted, pairs: chosen, count: chosen.length };
}

export function extractLorebook(turns, charName = "Companion", existingEntries = []) {
  const entityRe = /\b([A-Z][a-z]{2,18}(?:\s+[A-Z][a-z]{2,18}){0,2})\b/g;
  const counts = new Map();
  const samples = new Map();
  const charLower = String(charName || "").toLowerCase();

  for (const t of turns) {
    const text = String(t.text || "");
    const seen = new Set();
    let m;
    entityRe.lastIndex = 0;
    while ((m = entityRe.exec(text)) !== null) {
      let cand = m[1].trim();
      // Trim leading stop word from multi-word matches ("The Glass Observatory" -> "Glass Observatory")
      const parts = cand.split(/\s+/);
      while (parts.length > 1 && STOP_CAPITALIZED.has(parts[0])) {
        parts.shift();
      }
      cand = parts.join(" ");
      if (cand.length < 4) continue;
      if (STOP_CAPITALIZED.has(cand)) continue;
      if (cand.toLowerCase() === charLower) continue;
      if (parts.length === 1 && TRIVIAL_STOP.has(cand.toLowerCase())) continue;

      const key = cand.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const prev = counts.get(key) || { label: cand, count: 0 };
        prev.count++;
        if (cand.length > prev.label.length) prev.label = cand;
        counts.set(key, prev);

        const sArr = samples.get(key) || [];
        if (sArr.length < 2) {
          const sent = bestSentenceContaining(text, cand);
          if (!sArr.includes(sent)) sArr.push(sent);
          samples.set(key, sArr);
        }
      }
    }
  }

  // Deduplicate single words that are fully subsumed by a multi-word phrase with similar count
  const multiWords = [...counts.entries()].filter(([, v]) => v.label.includes(" ") && v.count >= 2);
  for (const [k, v] of [...counts.entries()]) {
    if (!v.label.includes(" ")) {
      const subsumed = multiWords.some(
        ([, mv]) => mv.label.toLowerCase().split(/\s+/).includes(k) && mv.count >= v.count * 0.65
      );
      if (subsumed) counts.delete(k);
    }
  }

  const ranked = [...counts.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => (b[1].count !== a[1].count ? b[1].count - a[1].count : a[1].label.localeCompare(b[1].label)))
    .slice(0, 18);

  const entries = [];
  let nextId = 1;

  for (const ex of existingEntries || []) {
    entries.push({ ...ex, id: nextId++ });
  }

  for (const [key, info] of ranked) {
    const keys = [key, info.label];
    for (const part of info.label.split(/\s+/)) {
      if (part.length >= 4 && !STOP_CAPITALIZED.has(part) && !keys.includes(part.toLowerCase())) {
        keys.push(part.toLowerCase());
      }
    }
    entries.push({
      id: nextId++,
      name: `Memory: ${info.label}`,
      keys: [...new Set(keys)],
      content: `Recurring reference (${info.count}× in prior history) to ${info.label}: ${(samples.get(key) || []).join(" / ")}`,
      enabled: true,
      insertion_order: 100 - entries.length,
      case_sensitive: false,
      priority: 10,
      position: "before_char",
    });
  }

  if (turns.length >= 4) {
    const recent = turns.slice(-6).map((t) => {
      const snip = t.text.length > 200 ? t.text.slice(0, 197).trimEnd() + "..." : t.text;
      return `${t.speaker}: ${snip}`;
    });
    entries.push({
      id: nextId++,
      name: "Recent Continuity Anchor",
      keys: ["remember", "last time", "before", "earlier", charLower].filter(Boolean),
      content: "Recent turns before migration:\n" + recent.join("\n"),
      enabled: true,
      insertion_order: 120,
      case_sensitive: false,
      priority: 20,
      position: "after_char",
    });
  }

  return {
    name: `${charName} Extracted Lorebook`,
    description: "Automatically distilled offline from exported companion history by Lifeboat.",
    scan_depth: 4,
    token_budget: 1536,
    recursive_scanning: false,
    entries,
  };
}

export function buildEpisodicIndex(turns) {
  if (!turns || turns.length === 0) return [];
  const win = 8;
  const stride = 6;
  const episodes = [];
  let epId = 1;

  for (let start = 0; start < turns.length; start += stride) {
    const end = Math.min(turns.length, start + win);
    const slice = turns.slice(start, end);
    const kwSet = new Set();
    const lines = [];
    for (const t of slice) {
      lines.push(`${t.speaker}: ${t.text}`);
      for (const w of tokenizeWords(t.text)) {
        if (w.length >= 4 && !TRIVIAL_STOP.has(w)) kwSet.add(w);
      }
    }
    const summarySrc = slice[0]?.text || "";
    const summary = summarySrc.length > 140 ? summarySrc.slice(0, 137).trimEnd() + "..." : summarySrc;
    episodes.push({
      id: epId++,
      start_turn: start + 1,
      end_turn: end,
      timestamp: slice[0]?.timestamp || "",
      keywords: [...kwSet].slice(0, 24),
      summary,
      transcript: lines.join("\n"),
    });
    if (end === turns.length) break;
  }
  return episodes;
}

export function recallEpisodes(episodes, query, topK = 8) {
  if (!episodes || episodes.length === 0) return [];
  const qTerms = tokenizeWords(query).filter((w) => w.length >= 2 && !TRIVIAL_STOP.has(w));
  if (qTerms.length === 0) return [];

  const n = episodes.length;
  const docs = episodes.map((ep) => {
    const toks = tokenizeWords(ep.transcript);
    const tf = new Map();
    for (const tok of toks) tf.set(tok, (tf.get(tok) || 0) + 1);
    return { ep, tf, len: toks.length };
  });

  const avgdl = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, n);
  const df = new Map();
  for (const term of new Set(qTerms)) {
    let count = 0;
    for (const d of docs) {
      if (d.tf.has(term)) count++;
    }
    df.set(term, count);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = [];

  for (const d of docs) {
    let score = 0;
    for (const term of qTerms) {
      const f = d.tf.get(term) || 0;
      if (f === 0) continue;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const num = f * (k1 + 1);
      const den = f + k1 * (1 - b + (b * d.len) / Math.max(1, avgdl));
      score += idf * (num / den);
    }
    if (score > 0) {
      scored.push({ ...d.ep, score: Math.round(score * 1000) / 1000 });
    }
  }

  scored.sort((a, b2) => (b2.score !== a.score ? b2.score - a.score : a.id - b2.id));
  return scored.slice(0, topK);
}

export function computeDateSpan(turns) {
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const t of turns) {
    if (!t.timestamp) continue;
    const ms = Date.parse(t.timestamp);
    if (!Number.isNaN(ms) && ms > 946684800000) {
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return { firstDate: "", lastDate: "", spanDays: 0, spanLabel: "" };
  }
  const firstDate = new Date(minMs).toISOString().slice(0, 10);
  const lastDate = new Date(maxMs).toISOString().slice(0, 10);
  const spanDays = Math.max(1, Math.round((maxMs - minMs) / 86400000) + 1);
  let spanLabel = `${spanDays} day${spanDays === 1 ? "" : "s"}`;
  if (spanDays >= 60) {
    const months = Math.round(spanDays / 30.4);
    spanLabel = months >= 12 ? `${(spanDays / 365.25).toFixed(1)} yrs` : `${months} mos`;
  }
  return { firstDate, lastDate, spanDays, spanLabel };
}

export function buildCardFromParts({
  name,
  description,
  personality,
  scenario,
  firstMes,
  mesExample,
  book,
  sourceFormat,
  systemPrompt = "",
}) {
  const baseSys =
    systemPrompt ||
    `Stay strictly in character as ${name}. Preserve the established tone, pacing, and shared history with {{user}}. Never break character or insert meta-commentary.`;
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: name || "Companion",
      description: description || "",
      personality: personality || "",
      scenario: scenario || "",
      first_mes: firstMes || "",
      mes_example: mesExample || "",
      creator_notes: `Rescued offline via Lifeboat (${sourceFormat})`,
      system_prompt: baseSys,
      post_history_instructions: "Maintain continuity with the CharacterBook memory entries and prior tone.",
      alternate_greetings: [],
      tags: ["lifeboat", sourceFormat].filter(Boolean),
      creator: "Lifeboat",
      character_version: "1.0",
      character_book: book || {
        name: `${name || "Companion"} Lorebook`,
        description: "",
        scan_depth: 4,
        token_budget: 1536,
        recursive_scanning: false,
        entries: [],
      },
    },
  };
}

export function enrichCompanion(comp) {
  const name = comp.card?.data?.name || comp.name || "Companion";
  const turns = comp.history || [];
  const voice = computeVoiceProfile(turns, name);
  const episodes = buildEpisodicIndex(turns);
  const span = computeDateSpan(turns);
  const { mesExample, pairs, count: exCount } = buildExampleDialogue(turns, 6);

  if (!comp.card.data.mes_example && mesExample) {
    comp.card.data.mes_example = mesExample;
  }

  let charTurns = 0;
  let userTurns = 0;
  let totalWords = 0;
  for (const t of turns) {
    if (t.role === "assistant") charTurns++;
    else userTurns++;
    totalWords += countWords(t.text);
  }

  if (voice.style_lock_prompt) {
    comp.card.data.post_history_instructions = voice.style_lock_prompt;
    if (!comp.card.data.system_prompt.includes("Voice Lock:")) {
      comp.card.data.system_prompt = `${comp.card.data.system_prompt}\n\nVoice Lock: ${voice.style_lock_prompt}`.trim();
    }
  }

  comp.voice = voice;
  comp.episodes = episodes;
  comp.examplePairs = pairs;
  comp.span = span;
  comp.stats = {
    total_turns: turns.length,
    character_turns: charTurns,
    user_turns: userTurns,
    total_words: totalWords,
    lorebook_entries: comp.card?.data?.character_book?.entries?.length || 0,
    example_dialogues: exCount,
    episode_count: episodes.length,
    span_days: span.spanDays,
    first_date: span.firstDate,
    last_date: span.lastDate,
  };
  return comp;
}

export function swapCompanionSpeakers(comp, newUserName = "User") {
  const charName = comp.card?.data?.name || "Companion";
  const swapped = (comp.history || []).map((t) => {
    const nextRole = t.role === "user" ? "assistant" : "user";
    return {
      ...t,
      role: nextRole,
      speaker: nextRole === "assistant" ? charName : newUserName,
    };
  });
  const book = extractLorebook(swapped, charName);
  const { mesExample } = buildExampleDialogue(swapped, 6);
  const firstAssistant = swapped.find((t) => t.role === "assistant")?.text || comp.card.data.first_mes;

  const updated = {
    ...comp,
    speakersInferred: false,
    history: swapped,
    card: {
      ...comp.card,
      data: {
        ...comp.card.data,
        first_mes: firstAssistant,
        mes_example: mesExample,
        character_book: book,
      },
    },
  };
  return enrichCompanion(updated);
}

export function mergeCompanions(companions, mergedName = "") {
  if (!companions || companions.length === 0) {
    throw new Error("Select at least one conversation to merge");
  }
  const name = mergedName.trim() || companions[0].card?.data?.name || "Merged Companion";
  const allTurns = [];
  const customSysBlocks = [];
  const extraLore = [];
  const sourceModels = new Set();

  for (const c of companions) {
    if (c.dominantModel) sourceModels.add(c.dominantModel);
    if (c.customInstructions) customSysBlocks.push(c.customInstructions);
    for (const t of c.history || []) {
      allTurns.push({
        ...t,
        speaker: t.role === "assistant" ? name : (t.speaker || "User"),
        _thread: c.card?.data?.name || "",
      });
    }
    for (const entry of c.card?.data?.character_book?.entries || []) {
      if (entry.name?.startsWith("Replika ") || entry.name?.startsWith("Diary:") || entry.name?.startsWith("Custom ")) {
        extraLore.push(entry);
      }
    }
  }

  allTurns.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : NaN;
    const tb = b.timestamp ? Date.parse(b.timestamp) : NaN;
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
    return 0;
  });

  const cleanTurns = allTurns.map(({ _thread, ...rest }) => rest);
  const { mesExample } = buildExampleDialogue(cleanTurns, 6);
  const book = extractLorebook(cleanTurns, name, extraLore);
  const firstMes = cleanTurns.find((t) => t.role === "assistant")?.text || "";
  const combinedDesc =
    customSysBlocks.find(Boolean) ||
    `${name} — unified from ${companions.length} conversations (${cleanTurns.length} total turns).`;

  const lastTurn = cleanTurns[cleanTurns.length - 1];
  const scen = lastTurn
    ? `Continuing a merged history of ${cleanTurns.length} turns across ${companions.length} threads. Most recent context (${lastTurn.speaker}): ${lastTurn.text.slice(0, 220)}`
    : `Ongoing conversation between ${name} and {{user}}.`;

  const voice = computeVoiceProfile(cleanTurns, name);
  const card = buildCardFromParts({
    name,
    description: combinedDesc,
    personality: voice.style_lock_prompt,
    scenario: scen,
    firstMes,
    mesExample,
    book,
    sourceFormat: `${companions[0].source_format}_merged`,
  });

  return enrichCompanion({
    id: `merged-${Date.now()}`,
    mergedFromIds: companions.map((c) => c.id),
    source_format: `${companions[0].source_format}_merged`,
    sourceLabel: `${companions[0].sourceLabel || companions[0].source_format} (${companions.length} merged)`,
    dominantModel: [...sourceModels].join(", "),
    hasGpt4o: companions.some((c) => c.hasGpt4o),
    customInstructions: [...new Set(customSysBlocks)].join("\n\n"),
    speakersInferred: false,
    card,
    history: cleanTurns,
    avatarPNG: companions.find((c) => c.avatarPNG)?.avatarPNG || null,
  });
}
