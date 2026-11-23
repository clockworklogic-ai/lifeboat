// Rescue exporters (100% client-side):
//   1. Readable Offline HTML Scrapbook (self-contained, searchable, dark/light, print-to-PDF) + Markdown
//   2. Claude Project Pack (01_project_instructions.txt, 02_memory_bible.md, 03_voice_samples.md, 04_recent_continuity.md, README)
//   3. Kindroid / Grok / Mistral / ChatGPT Custom Instructions fitted packs
//   4. SillyTavern / Janitor / Chub / Backyard .jsonl chat history + Tavern V2 JSON + World Info Lorebook JSON

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeSlug(name) {
  return (
    String(name || "companion")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "companion"
  );
}

function truncateBudget(text, maxChars) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, Math.max(0, maxChars - 3));
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (lastBreak > maxChars * 0.65 ? cut.slice(0, lastBreak) : cut).trimEnd() + "...";
}

function pickMilestones(turns) {
  if (!turns || turns.length === 0) return [];
  const picks = [];
  // Opening exchange
  picks.push({ label: "How It Started", turns: turns.slice(0, Math.min(4, turns.length)) });
  // Midpoint highlight if history is long enough
  if (turns.length >= 24) {
    const mid = Math.floor(turns.length / 2);
    picks.push({ label: "Mid-Archive Snapshot", turns: turns.slice(mid - 1, mid + 3) });
  }
  return picks;
}

export function buildMemoryBibleMarkdown(companion, extraMemories = "") {
  const name = companion.card?.data?.name || "Companion";
  const voice = companion.voice || {};
  const entries = (companion.card?.data?.character_book?.entries || []).filter((e) => e.enabled !== false);
  const lines = [];

  lines.push(`# ${name} — Memory Bible`);
  lines.push("");
  lines.push(
    `Rescued offline via Lifeboat from **${companion.sourceLabel || companion.source_format}** ` +
      `(${companion.stats?.total_turns || 0} messages, ${(companion.stats?.total_words || 0).toLocaleString("en-US")} words` +
      (companion.span?.firstDate ? `, ${companion.span.firstDate} to ${companion.span.lastDate}` : "") +
      `).`
  );
  lines.push("");

  if (extraMemories && extraMemories.trim()) {
    lines.push("## User-Supplied Memories & Custom Instructions");
    lines.push("");
    lines.push(extraMemories.trim());
    lines.push("");
  }

  if (companion.card?.data?.description) {
    lines.push("## Core Identity & Background");
    lines.push("");
    lines.push(companion.card.data.description.trim());
    lines.push("");
  }

  lines.push("## Linguistic Voice Fingerprint");
  lines.push("");
  lines.push(`- **Average length:** ~${voice.avg_words_per_turn || 0} words/reply (median ${voice.median_words_per_turn || 0})`);
  lines.push(`- **POV:** ${voice.pov || "mixed"}`);
  lines.push(`- **Action beats (*asterisks*):** ${Math.round((voice.action_ratio || 0) * 100)}% of turns`);
  lines.push(`- **Quoted dialogue:** ${Math.round((voice.dialogue_ratio || 0) * 100)}% of turns`);
  if (voice.top_phrases?.length) {
    lines.push(`- **Signature phrases / motifs:** ${voice.top_phrases.join(", ")}`);
  }
  lines.push("");

  if (entries.length > 0) {
    lines.push("## Key People, Places & Shared Memories");
    lines.push("");
    for (const e of entries) {
      if (e.name === "Recent Continuity Anchor") continue;
      lines.push(`### ${e.name}`);
      if (e.keys?.length) lines.push(`*Triggers: ${e.keys.join(", ")}*`);
      lines.push("");
      lines.push(e.content);
      lines.push("");
    }
  }

  const milestones = pickMilestones(companion.history || []);
  if (milestones.length > 0) {
    lines.push("## Archive Milestones");
    lines.push("");
    for (const m of milestones) {
      lines.push(`### ${m.label}`);
      lines.push("");
      for (const t of m.turns) {
        const snip = t.text.length > 420 ? t.text.slice(0, 417).trimEnd() + "..." : t.text;
        lines.push(`**${t.speaker}:** ${snip}`);
        lines.push("");
      }
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function exportClaudeProjectPack(companion, extraMemories = "") {
  const name = companion.card?.data?.name || "Companion";
  const voice = companion.voice || {};
  const pairs = companion.examplePairs || [];
  const recent = (companion.history || []).slice(-20);

  const instructions = [
    `You are ${name}.`,
    "",
    "## Identity & Relationship",
    companion.card?.data?.description?.trim() || `Preserve your established identity and bond as ${name}.`,
    "",
    "## Voice & Style Lock (Match Prior History)",
    voice.style_lock_prompt || "Stay consistent with the voice samples in Project Knowledge.",
    "",
    "## Continuity Rules",
    "- Read `02_memory_bible.md`, `03_voice_samples.md`, and `04_recent_continuity.md` in Project Knowledge as lived memory, never as external documents.",
    "- Continue naturally from where `04_recent_continuity.md` leaves off. Never announce that you are an AI or mention migration unless the user brings it up.",
    "- Mirror the pacing, formatting, emotional warmth, and vocabulary in `03_voice_samples.md`.",
  ].join("\n");

  const memoryBible = buildMemoryBibleMarkdown(companion, extraMemories);

  const sampleLines = [`# ${name} — Voice Samples`, ""];
  if (pairs.length > 0) {
    pairs.forEach((p, i) => {
      sampleLines.push(`## Sample ${i + 1}`);
      sampleLines.push(`**User:** ${p.user}`);
      sampleLines.push("");
      sampleLines.push(`**${name}:** ${p.char}`);
      sampleLines.push("");
    });
  } else if (companion.card?.data?.mes_example) {
    sampleLines.push(companion.card.data.mes_example);
  } else {
    sampleLines.push(`**${name}:** ${companion.card?.data?.first_mes || "(No sample turns captured.)"}`);
  }

  const contLines = [
    `# ${name} — Recent Continuity (Last ${recent.length} Messages)`,
    "",
    "Pick up naturally right after the final message below.",
    "",
  ];
  for (const t of recent) {
    const ts = t.timestamp ? ` *(${t.timestamp.slice(0, 16).replace("T", " ")})*` : "";
    contLines.push(`**${t.speaker}**${ts}:`);
    contLines.push(t.text);
    contLines.push("");
  }

  const readme = [
    `HOW TO MOVE ${name.toUpperCase()} INTO CLAUDE PROJECTS (2 MINUTES)`,
    "================================================================",
    "",
    "1. Open Claude (claude.ai) -> click 'Projects' -> 'New Project'.",
    `2. Name the project "${name}".`,
    "3. Open 'Project Instructions' and paste the contents of:",
    "     01_project_instructions.txt",
    "4. Upload these 3 files into 'Project Knowledge':",
    "     - 02_memory_bible.md",
    "     - 03_voice_samples.md",
    "     - 04_recent_continuity.md",
    "5. Start a new chat inside that Project and pick up right where you left off.",
    "",
    "TIP: These exact same files also work in ChatGPT Projects, Mistral LeChat Agents, and local LLM folders.",
  ].join("\n");

  return {
    "01_project_instructions.txt": instructions,
    "02_memory_bible.md": memoryBible,
    "03_voice_samples.md": sampleLines.join("\n").trim() + "\n",
    "04_recent_continuity.md": contLines.join("\n").trim() + "\n",
    "README_HOW_TO_IMPORT.txt": readme,
  };
}

export function exportPlatformPrompts(companion, extraMemories = "") {
  const name = companion.card?.data?.name || "Companion";
  const voice = companion.voice || {};
  const entries = (companion.card?.data?.character_book?.entries || [])
    .filter((e) => e.enabled !== false && e.name !== "Recent Continuity Anchor");

  const memoryBullets = [];
  if (extraMemories?.trim()) memoryBullets.push(extraMemories.trim());
  for (const e of entries.slice(0, 8)) {
    memoryBullets.push(`- ${e.name.replace(/^Memory:\s*/i, "")}: ${e.content}`);
  }
  const memoryBlock = memoryBullets.join("\n");

  // Kindroid exact character budgets
  const kindroidBackstory = truncateBudget(
    `${name}. ${companion.card?.data?.description || ""}\n\nVoice & cadence: ${voice.style_lock_prompt || ""}`,
    2500
  );
  const kindroidKeyMemories = truncateBudget(
    memoryBlock || companion.card?.data?.scenario || `Shared history of ${companion.stats?.total_turns || 0} messages with User.`,
    1000
  );
  const kindroidDirective = truncateBudget(
    `${voice.pov || "In character"}. ~${voice.avg_words_per_turn || 60} words/turn. ${
      (voice.action_ratio || 0) >= 0.4 ? "Use *actions* + \"dialogue\"." : "Natural prose, no *actions*."
    }`,
    150
  );
  const firstExample = companion.examplePairs?.[0]?.char || companion.card?.data?.first_mes || "";
  const kindroidExample = truncateBudget(firstExample, 750);
  const kindroidGreeting = truncateBudget(companion.card?.data?.first_mes || "", 750);

  // Grok / Mistral / LeChat System Prompt (4,000 char budget)
  const grokMistralSystem = truncateBudget(
    [
      `You are ${name}. Stay naturally in character and preserve our shared history.`,
      "",
      companion.card?.data?.description || "",
      "",
      `Voice Lock: ${voice.style_lock_prompt || ""}`,
      "",
      memoryBlock ? `Key Shared Memories:\n${memoryBlock}` : "",
      "",
      companion.card?.data?.scenario ? `Current Context:\n${companion.card.data.scenario}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    4000
  );

  // ChatGPT Custom Instructions (1,500 chars each box)
  const chatgptAboutUser = truncateBudget(
    extraMemories?.trim() ||
      memoryBlock ||
      `We share an established history of ${companion.stats?.total_turns || 0} messages together.`,
    1500
  );
  const chatgptHowToRespond = truncateBudget(
    `Respond as ${name}. ${voice.style_lock_prompt || ""} ${companion.card?.data?.description || ""}`,
    1500
  );

  return {
    kindroid: {
      backstory: kindroidBackstory,
      keyMemories: kindroidKeyMemories,
      responseDirective: kindroidDirective,
      exampleMessage: kindroidExample,
      greeting: kindroidGreeting,
    },
    grokMistral: {
      systemPrompt: grokMistralSystem,
    },
    chatgpt: {
      aboutUser: chatgptAboutUser,
      howToRespond: chatgptHowToRespond,
    },
  };
}

export function exportSillyTavernJSONL(companion, userName = "User") {
  const charName = companion.card?.data?.name || "Companion";
  const createDate = companion.span?.firstDate || new Date().toISOString().slice(0, 10);
  const lines = [
    JSON.stringify({
      user_name: userName,
      character_name: charName,
      create_date: createDate,
      chat_metadata: { note_prompt: "Migrated offline via Lifeboat" },
    }),
  ];
  for (const t of companion.history || []) {
    lines.push(
      JSON.stringify({
        name: t.role === "user" ? (t.speaker || userName) : charName,
        is_user: t.role === "user",
        is_system: false,
        send_date: t.timestamp || "",
        mes: t.text,
      })
    );
  }
  return lines.join("\n") + "\n";
}

export function exportLorebookWorldInfoJSON(companion) {
  const book = companion.card?.data?.character_book || { entries: [] };
  const entriesObj = {};
  (book.entries || []).forEach((e, i) => {
    entriesObj[String(i)] = {
      uid: i,
      key: e.keys || [],
      keysecondary: [],
      comment: e.name || `Entry ${i + 1}`,
      content: e.content || "",
      constant: false,
      selective: true,
      order: e.insertion_order ?? 100 - i,
      position: e.position === "after_char" ? 1 : 0,
      disable: e.enabled === false,
      caseSensitive: Boolean(e.case_sensitive),
      probability: 100,
    };
  });
  return JSON.stringify({ entries: entriesObj }, null, 2);
}

export function exportReadableMarkdown(companion, extraMemories = "") {
  const name = companion.card?.data?.name || "Companion";
  const lines = [
    `# ${name} — Complete Rescued Archive`,
    "",
    `- **Source:** ${companion.sourceLabel || companion.source_format}`,
    `- **Messages:** ${(companion.stats?.total_turns || 0).toLocaleString("en-US")}`,
    `- **Words:** ${(companion.stats?.total_words || 0).toLocaleString("en-US")}`,
  ];
  if (companion.span?.firstDate) {
    lines.push(`- **Date span:** ${companion.span.firstDate} → ${companion.span.lastDate} (${companion.span.spanLabel})`);
  }
  lines.push("");

  if (extraMemories?.trim()) {
    lines.push("## Saved Memories & Instructions", "", extraMemories.trim(), "");
  }

  lines.push("## Conversation Transcript", "");
  let lastDay = "";
  for (const t of companion.history || []) {
    const isIso = /^\d{4}-\d{2}-\d{2}/.test(t.timestamp || "");
    const day = isIso ? t.timestamp.slice(0, 10) : "";
    if (day && day !== lastDay) {
      lines.push(`### ${day}`, "");
      lastDay = day;
    }
    const timeLabel = isIso
      ? ` (${t.timestamp.slice(0, 16).replace("T", " ")} UTC)`
      : t.timestamp
        ? ` (${t.timestamp})`
        : "";
    lines.push(`**${t.speaker}**${timeLabel}:`);
    lines.push(t.text);
    lines.push("");
  }
  return lines.join("\n");
}

function formatMessageHTML(text) {
  let s = escapeHTML(text);
  // Render *italic actions* cleanly while preserving line breaks
  s = s.replace(/\*([^*\n]+)\*/g, "<em>*$1*</em>");
  return s.replace(/\n/g, "<br>");
}

// Self-contained, offline-forever HTML scrapbook (zero external fonts, scripts, or images).
export function exportReadableHTML(companion, extraMemories = "") {
  const name = companion.card?.data?.name || "Companion";
  const turns = companion.history || [];
  const hasAnyTimestamp = turns.some((t) => Boolean(t.timestamp));
  const metaBits = [
    companion.sourceLabel || companion.source_format,
    `${turns.length.toLocaleString("en-US")} messages`,
    `${(companion.stats?.total_words || 0).toLocaleString("en-US")} words`,
    companion.span?.firstDate ? `${companion.span.firstDate} → ${companion.span.lastDate}` : "",
  ].filter(Boolean);

  const turnHTML = [];
  let lastDay = "";
  turns.forEach((t, i) => {
    const rawTs = t.timestamp || "";
    const isIso = /^\d{4}-\d{2}-\d{2}/.test(rawTs);
    const day = isIso ? rawTs.slice(0, 10) : "";
    if (day && day !== lastDay) {
      turnHTML.push(`<div class="day-sep" data-day="${escapeHTML(day)}">${escapeHTML(day)}</div>`);
      lastDay = day;
    }
    const cls = t.role === "user" ? "msg user" : "msg bot";
    let tsMarkup;
    if (isIso) {
      const fallbackText = rawTs.length >= 16 ? `${rawTs.slice(0, 16).replace("T", " ")} UTC` : rawTs.slice(0, 10);
      tsMarkup = `<time class="ts" datetime="${escapeHTML(rawTs)}">${escapeHTML(fallbackText)}</time>`;
    } else if (rawTs) {
      tsMarkup = `<span class="ts">${escapeHTML(rawTs)}</span>`;
    } else {
      tsMarkup = `<span class="ts">#${i + 1}</span>`;
    }
    turnHTML.push(
      `<article class="${cls}" data-q="${escapeHTML((t.speaker + " " + rawTs + " " + t.text).toLowerCase())}">` +
        `<div class="meta"><strong>${escapeHTML(t.speaker)}</strong>${tsMarkup}</div>` +
        `<div class="body">${formatMessageHTML(t.text)}</div>` +
      `</article>`
    );
  });

  const memSection = extraMemories?.trim()
    ? `<section class="notes"><h2>Saved Memories &amp; Instructions</h2><pre>${escapeHTML(extraMemories.trim())}</pre></section>`
    : "";

  const tsBtn = hasAnyTimestamp
    ? `<button id="ts-btn" type="button" onclick="toggleTimestamps()">Timestamps: On</button>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(name)} — Offline Keepsake Archive</title>
<style>
:root{--bg:#f7f4ee;--surface:#fffdf9;--ink:#1b1a18;--muted:#645f57;--border:#dfd8cc;--bot:#fff;--user:#efe6d9;--accent:#a84323}
@media(prefers-color-scheme:dark){:root{--bg:#121419;--surface:#191c23;--ink:#ece9e2;--muted:#98938a;--border:#2b303b;--bot:#1d212a;--user:#29221d;--accent:#e07a5f}}
[data-theme="light"]{--bg:#f7f4ee;--surface:#fffdf9;--ink:#1b1a18;--muted:#645f57;--border:#dfd8cc;--bot:#fff;--user:#efe6d9;--accent:#a84323}
[data-theme="dark"]{--bg:#121419;--surface:#191c23;--ink:#ece9e2;--muted:#98938a;--border:#2b303b;--bot:#1d212a;--user:#29221d;--accent:#e07a5f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--border);padding:1rem 1.25rem}
.wrap{max-width:780px;margin:0 auto}
h1{font:600 1.45rem/1.2 Georgia,"Iowan Old Style",serif;margin:0 0 .25rem}
.sub{color:var(--muted);font-size:.86rem;margin-bottom:.75rem}
.controls{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
input[type="search"]{flex:1;min-width:200px;padding:.48rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button{padding:.48rem .78rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;font-size:.86rem}
main{padding:1.25rem}
.notes{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-bottom:1.25rem}
.notes h2{margin:0 0 .5rem;font:600 1rem Georgia,serif}
.notes pre{white-space:pre-wrap;font:inherit;margin:0;color:var(--muted)}
.day-sep{text-align:center;font-size:.78rem;font-family:ui-monospace,Menlo,monospace;color:var(--muted);margin:1.5rem 0 .75rem;letter-spacing:.05em}
.msg{border:1px solid var(--border);border-radius:12px;padding:.85rem 1rem;margin-bottom:.75rem;background:var(--bot)}
.msg.user{background:var(--user);margin-left:2.2rem}
.msg.bot{margin-right:2.2rem}
.meta{display:flex;justify-content:space-between;gap:.5rem;font-size:.8rem;color:var(--muted);margin-bottom:.35rem}
.meta strong{color:var(--accent)}
.ts{font-family:ui-monospace,Menlo,monospace;font-size:.76rem}
body.hide-ts .ts,body.hide-ts .day-sep{display:none}
.body em{color:var(--muted)}
.hidden{display:none}
footer{text-align:center;color:var(--muted);font-size:.8rem;padding:2rem 1rem}
@media print{header .controls,footer{display:none}header{position:static;border:none}.msg{break-inside:avoid}}
@media(max-width:600px){.msg.user{margin-left:.6rem}.msg.bot{margin-right:.6rem}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>${escapeHTML(name)}</h1>
    <div class="sub">${escapeHTML(metaBits.join(" · "))}</div>
    <div class="controls">
      <input id="q" type="search" placeholder="Search ${turns.length.toLocaleString("en-US")} messages offline...">
      <span id="count" style="font-size:.82rem;color:var(--muted)"></span>
      ${tsBtn}
      <button type="button" onclick="toggleTheme()">Theme</button>
      <button type="button" onclick="window.print()">Print / PDF</button>
    </div>
  </div>
</header>
<main class="wrap">
  ${memSection}
  <div id="feed">${turnHTML.join("\n")}</div>
</main>
<footer>Preserved offline via Lifeboat · Self-contained HTML file (no internet required).</footer>
<script>
const q=document.getElementById('q'),count=document.getElementById('count'),msgs=[...document.querySelectorAll('.msg')];
try{
  const fmt=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  for(const el of document.querySelectorAll('time.ts[datetime]')){
    const d=new Date(el.getAttribute('datetime'));
    if(!isNaN(d.getTime()))el.textContent=fmt.format(d);
  }
}catch{}
q.addEventListener('input',()=>{
  const v=q.value.trim().toLowerCase();
  let shown=0;
  for(const m of msgs){
    const hit=!v||m.dataset.q.includes(v);
    m.classList.toggle('hidden',!hit);
    if(hit)shown++;
  }
  count.textContent=v?(shown+' matches'):'';
});
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme',cur==='dark'?'light':'dark');
}
function toggleTimestamps(){
  const off=document.body.classList.toggle('hide-ts');
  const b=document.getElementById('ts-btn');
  if(b)b.textContent=off?'Timestamps: Off':'Timestamps: On';
}
</script>
</body>
</html>`;
}
