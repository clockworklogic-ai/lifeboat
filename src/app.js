// Lifeboat client-side UI controller. Zero outbound network calls.

import {
  mergeCompanions,
  recallEpisodes,
  swapCompanionSpeakers,
} from "./compiler.js";
import {
  exportClaudeProjectPack,
  exportLorebookWorldInfoJSON,
  exportPlatformPrompts,
  exportReadableHTML,
  exportReadableMarkdown,
  exportSillyTavernJSONL,
  safeSlug,
} from "./exporters.js";
import { parseFileMap, parseSingleFile } from "./parsers.js";
import {
  decodeTavernPNG,
  encodeTavernPNG,
  renderPortraitPNG,
  renderRescuedShareCard,
} from "./pngcard.js";
import { loadSampleArchive } from "./sample.js";
import { buildZipBundle, extractZipArchive, isZipBytes } from "./zip.js";

const state = {
  companions: [],
  activeId: null,
  selectedIds: new Set(),
  filter: "all", // all | 4o | deep
  searchQuery: "",
  activeTab: "export",
  promptPlatform: "kindroid",
  extraMemories: "",
  pendingEncryptedZip: null, // { bytes, name }
  readerLimit: 120,
  shareCardUrl: null,
  portraitUrl: null,
};

const $ = (id) => document.getElementById(id);

function init() {
  wireOfflineIndicator();
  wireTheme();
  wireDropzone();
  wireUnlockForm();
  wireSidebar();
  wireTabs();
  wireExports();
  wireReader();
  wireVoiceAndStudio();
}

function wireOfflineIndicator() {
  const pill = $("offline-pill");
  const label = $("offline-label");
  const update = () => {
    if (!navigator.onLine) {
      label.textContent = "Offline Verified (Airplane Mode) · Safe to Drop";
      pill.style.fontWeight = "700";
    } else {
      label.textContent = "100% Client-Side · Turn off Wi-Fi to verify";
    }
  };
  update();
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
}

function wireTheme() {
  const btn = $("btn-theme");
  btn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = cur === "dark" || (!cur && prefersDark);
    document.documentElement.setAttribute("data-theme", isDark ? "light" : "dark");
  });
}

function setStatus(msg, kind = "") {
  const el = $("status-banner");
  const txt = $("status-text");
  if (!msg) {
    el.classList.add("hidden");
    return;
  }
  el.className = "status-banner" + (kind ? " " + kind : "");
  txt.textContent = msg;
  el.classList.remove("hidden");
}

function wireDropzone() {
  const dz = $("dropzone");
  const input = $("file-input");

  $("btn-choose").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });

  $("btn-new-file").addEventListener("click", () => {
    input.value = "";
    input.click();
  });

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  });

  input.addEventListener("change", () => {
    if (input.files?.length) handleFiles(input.files);
  });

  $("btn-sample").addEventListener("click", (e) => {
    e.stopPropagation();
    const samples = loadSampleArchive();
    loadCompanions(samples, "Loaded sample Character.AI + ChatGPT (#Keep4o) archives locally.");
  });
}

async function handleFiles(fileList) {
  setStatus("Reading archive locally in your browser...", "");
  $("unlock-card").classList.add("hidden");
  $("unlock-error").textContent = "";
  state.pendingEncryptedZip = null;

  try {
    const files = [...fileList];
    // Single ZIP / CharX file
    if (files.length === 1) {
      const f = files[0];
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isZipBytes(bytes)) {
        await processZipBytes(bytes, f.name, "");
        return;
      }
      const parsed = parseSingleFile(bytes, f.name);
      loadCompanions(parsed, `Rescued ${parsed.length} companion${parsed.length === 1 ? "" : "s"} from ${f.name} locally.`);
      return;
    }

    // Multiple files dropped together (e.g. unzipped message.json + character.json + user.json)
    const fileMap = new Map();
    const avatars = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isZipBytes(bytes)) {
        await processZipBytes(bytes, f.name, "");
        return;
      }
      fileMap.set(f.name, bytes);
      if (f.name.toLowerCase().endsWith(".png")) avatars.push(bytes);
    }
    const parsed = parseFileMap(fileMap, files[0].name, avatars);
    loadCompanions(parsed, `Rescued ${parsed.length} companion${parsed.length === 1 ? "" : "s"} from ${files.length} files locally.`);
  } catch (err) {
    setStatus(err?.message || String(err), "error");
  }
}

async function processZipBytes(bytes, filename, password) {
  const res = await extractZipArchive(bytes, password);
  if (res.status === "needs_password") {
    state.pendingEncryptedZip = { bytes, name: filename };
    $("landing-section").classList.remove("hidden");
    $("workspace-section").classList.add("hidden");
    $("unlock-card").classList.remove("hidden");
    $("unlock-error").textContent = "";
    $("zip-password").value = "";
    $("unlock-card").scrollIntoView({ behavior: "smooth", block: "center" });
    $("zip-password").focus();
    setStatus("", "");
    return;
  }
  if (res.status === "wrong_password") {
    state.pendingEncryptedZip = { bytes, name: filename };
    $("unlock-card").classList.remove("hidden");
    $("unlock-error").textContent = res.message;
    $("zip-password").focus();
    $("zip-password").select();
    setStatus("", "");
    return;
  }

  $("unlock-card").classList.add("hidden");
  state.pendingEncryptedZip = null;
  const parsed = parseFileMap(res.files, filename, res.avatars);
  const pwNote = res.unlockedWithLowercase ? " (auto-lowercased email password)" : "";
  loadCompanions(
    parsed,
    `Unlocked & parsed ${parsed.length} companion${parsed.length === 1 ? "" : "s"} from ${filename}${pwNote} — 0 bytes uploaded.`
  );
}

function wireUnlockForm() {
  $("btn-toggle-pw").addEventListener("click", () => {
    const inp = $("zip-password");
    const isPw = inp.type === "password";
    inp.type = isPw ? "text" : "password";
    $("btn-toggle-pw").textContent = isPw ? "Hide" : "Show";
  });

  $("unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.pendingEncryptedZip) return;
    const pw = $("zip-password").value;
    if (!pw) return;
    $("btn-unlock").disabled = true;
    $("btn-unlock").textContent = "Unlocking...";
    $("unlock-error").textContent = "";
    try {
      await processZipBytes(state.pendingEncryptedZip.bytes, state.pendingEncryptedZip.name, pw);
    } catch (err) {
      $("unlock-error").textContent = err?.message || String(err);
    } finally {
      $("btn-unlock").disabled = false;
      $("btn-unlock").textContent = "Unlock Locally";
    }
  });
}

function loadCompanions(list, bannerMsg) {
  state.companions = list;
  state.activeId = list[0]?.id || null;
  state.selectedIds.clear();
  state.filter = "all";
  state.searchQuery = "";
  state.readerLimit = 120;
  $("comp-search").value = "";

  $("landing-section").classList.add("hidden");
  $("workspace-section").classList.remove("hidden");
  $("btn-new-file").classList.remove("hidden");

  if (bannerMsg) setStatus(bannerMsg, "ok");
  renderSidebar();
  renderActiveCompanion();
}

function getActiveCompanion() {
  return state.companions.find((c) => c.id === state.activeId) || state.companions[0] || null;
}

function replaceActiveCompanion(updated) {
  const idx = state.companions.findIndex((c) => c.id === updated.id);
  if (idx >= 0) state.companions[idx] = updated;
  state.activeId = updated.id;
  renderSidebar();
  renderActiveCompanion();
}

function getFilteredCompanions() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.companions.filter((c) => {
    if (state.filter === "4o" && !c.hasGpt4o) return false;
    if (state.filter === "deep" && (c.stats?.total_turns || 0) < 10) return false;
    if (q) {
      const name = (c.card?.data?.name || "").toLowerCase();
      const src = (c.sourceLabel || "").toLowerCase();
      if (!name.includes(q) && !src.includes(q)) return false;
    }
    return true;
  });
}

function wireSidebar() {
  $("comp-search").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderSidebar();
  });

  const setFilter = (f) => {
    state.filter = f;
    $("filter-all").classList.toggle("active", f === "all");
    $("filter-4o").classList.toggle("active", f === "4o");
    $("filter-deep").classList.toggle("active", f === "deep");
    renderSidebar();
  };
  $("filter-all").addEventListener("click", () => setFilter("all"));
  $("filter-4o").addEventListener("click", () => setFilter("4o"));
  $("filter-deep").addEventListener("click", () => setFilter("deep"));

  $("btn-clear-all").addEventListener("click", () => {
    state.companions = [];
    state.activeId = null;
    state.selectedIds.clear();
    $("workspace-section").classList.add("hidden");
    $("landing-section").classList.remove("hidden");
    $("btn-new-file").classList.add("hidden");
    setStatus("", "");
  });

  $("btn-clear-sel").addEventListener("click", () => {
    state.selectedIds.clear();
    renderSidebar();
  });

  $("btn-merge").addEventListener("click", () => {
    const picked = state.companions.filter((c) => state.selectedIds.has(c.id));
    if (picked.length < 2) return;
    const customName = $("merge-name").value.trim() || picked[0].card?.data?.name?.split("—")[0]?.trim() || "Unified Companion";
    const merged = mergeCompanions(picked, customName);
    state.companions.unshift(merged);
    state.activeId = merged.id;
    state.selectedIds.clear();
    $("merge-name").value = "";
    renderSidebar();
    renderActiveCompanion();
  });

  $("btn-rename").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const next = window.prompt("Rename companion:", comp.card.data.name);
    if (!next || !next.trim()) return;
    const clean = next.trim();
    const oldName = comp.card.data.name;
    comp.card.data.name = clean;
    for (const t of comp.history || []) {
      if (t.role === "assistant" && (t.speaker === oldName || !t.speaker)) {
        t.speaker = clean;
      }
    }
    renderSidebar();
    renderActiveCompanion();
  });

  $("btn-swap-speakers").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const updated = swapCompanionSpeakers(comp, "User");
    replaceActiveCompanion(updated);
  });
}

function renderSidebar() {
  const listEl = $("comp-list");
  const filtered = getFilteredCompanions();
  $("comp-count").textContent = String(filtered.length);

  const has4oCount = state.companions.filter((c) => c.hasGpt4o).length;
  $("filter-4o").textContent = has4oCount > 0 ? `#Keep4o (${has4oCount})` : "#Keep4o (GPT-4o)";

  // Merge bar
  const mergeBar = $("merge-bar");
  if (state.selectedIds.size >= 2) {
    mergeBar.classList.remove("hidden");
    $("merge-count").textContent = String(state.selectedIds.size);
  } else {
    mergeBar.classList.add("hidden");
  }

  listEl.innerHTML = "";
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:1rem;color:var(--muted);font-size:0.84rem;text-align:center";
    empty.textContent = "No conversations match this filter.";
    listEl.appendChild(empty);
    return;
  }

  for (const c of filtered) {
    const row = document.createElement("div");
    row.className = "comp-item" + (c.id === state.activeId ? " active" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedIds.has(c.id);
    cb.title = "Select to merge multiple threads into one companion";
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedIds.add(c.id);
      else state.selectedIds.delete(c.id);
      renderSidebar();
    });

    const meta = document.createElement("div");
    meta.className = "comp-meta";

    const nameEl = document.createElement("div");
    nameEl.className = "comp-name";
    nameEl.textContent = c.card?.data?.name || "Companion";

    const sub = document.createElement("div");
    sub.className = "comp-sub mono";
    sub.innerHTML =
      `<span>${(c.stats?.total_turns || 0).toLocaleString("en-US")} msgs</span>` +
      (c.hasGpt4o ? `<span class="tag-4o">gpt-4o</span>` : `<span>${escapeText(c.sourceLabel || c.source_format)}</span>`) +
      (c.span?.spanLabel ? `<span>${escapeText(c.span.spanLabel)}</span>` : "");

    meta.append(nameEl, sub);
    row.append(cb, meta);
    row.addEventListener("click", () => {
      state.activeId = c.id;
      state.readerLimit = 120;
      $("bm25-query").value = "";
      $("bm25-results").classList.add("hidden");
      $("btn-bm25-clear").classList.add("hidden");
      renderSidebar();
      renderActiveCompanion();
    });
    listEl.appendChild(row);
  }
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      ["export", "read", "voice", "studio"].forEach((t) => {
        $("tab-" + t).classList.toggle("hidden", t !== state.activeTab);
      });
      if (state.activeTab === "studio") refreshPortraitPreview();
    });
  });
}

function renderActiveCompanion() {
  const comp = getActiveCompanion();
  if (!comp) return;

  $("active-name").textContent = comp.card?.data?.name || "Companion";
  $("active-source-badge").textContent = comp.sourceLabel || comp.source_format;

  const stats = [
    `${(comp.stats?.total_turns || 0).toLocaleString("en-US")} messages`,
    `${(comp.stats?.total_words || 0).toLocaleString("en-US")} words`,
    `${comp.stats?.lorebook_entries || 0} memory anchors`,
    comp.span?.firstDate ? `${comp.span.firstDate} → ${comp.span.lastDate}` : "",
  ].filter(Boolean);
  $("active-stats").textContent = stats.join(" · ");

  $("inferred-warning").classList.toggle("hidden", !comp.speakersInferred);

  renderPromptFields(comp);
  renderShareCardPreview(comp);
  renderReader(comp);
  renderVoiceTab(comp);
  renderStudioTab(comp);
}

function wireExports() {
  $("extra-memories").addEventListener("input", (e) => {
    state.extraMemories = e.target.value;
    const comp = getActiveCompanion();
    if (comp) renderPromptFields(comp);
  });

  document.querySelectorAll("[data-platform]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.promptPlatform = btn.dataset.platform;
      document.querySelectorAll("[data-platform]").forEach((b) => b.classList.toggle("active", b === btn));
      const comp = getActiveCompanion();
      if (comp) renderPromptFields(comp);
    });
  });

  $("dl-html").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const html = exportReadableHTML(comp, state.extraMemories);
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${safeSlug(comp.card.data.name)}-keepsake.html`);
  });

  $("dl-md").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const md = exportReadableMarkdown(comp, state.extraMemories);
    downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), `${safeSlug(comp.card.data.name)}-archive.md`);
  });

  $("dl-claude-zip").addEventListener("click", async () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const pack = exportClaudeProjectPack(comp, state.extraMemories);
    const entries = Object.entries(pack).map(([name, content]) => ({ name, content }));
    const zipBytes = await buildZipBundle(entries);
    downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${safeSlug(comp.card.data.name)}-claude-project.zip`);
  });

  $("copy-claude-inst").addEventListener("click", async () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const pack = exportClaudeProjectPack(comp, state.extraMemories);
    await copyText(pack["01_project_instructions.txt"], $("copy-claude-inst"));
  });

  $("dl-tavern-png").addEventListener("click", () => downloadTavernPNG());

  $("dl-st-jsonl").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const jsonl = exportSillyTavernJSONL(comp);
    downloadBlob(new Blob([jsonl], { type: "application/x-ndjson;charset=utf-8" }), `${safeSlug(comp.card.data.name)}-chat.jsonl`);
  });

  $("dl-lore-json").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const lore = exportLorebookWorldInfoJSON(comp);
    downloadBlob(new Blob([lore], { type: "application/json;charset=utf-8" }), `${safeSlug(comp.card.data.name)}-lorebook.json`);
  });

  $("dl-all-zip").addEventListener("click", async () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const slug = safeSlug(comp.card.data.name);
    const claude = exportClaudeProjectPack(comp, state.extraMemories);
    const prompts = exportPlatformPrompts(comp, state.extraMemories);
    const pngBytes = await encodeTavernPNG(comp.card, comp.avatarPNG, comp.sourceLabel);

    const entries = [
      { name: `${slug}-keepsake.html`, content: exportReadableHTML(comp, state.extraMemories) },
      { name: `${slug}-archive.md`, content: exportReadableMarkdown(comp, state.extraMemories) },
      { name: `claude-project/01_project_instructions.txt`, content: claude["01_project_instructions.txt"] },
      { name: `claude-project/02_memory_bible.md`, content: claude["02_memory_bible.md"] },
      { name: `claude-project/03_voice_samples.md`, content: claude["03_voice_samples.md"] },
      { name: `claude-project/04_recent_continuity.md`, content: claude["04_recent_continuity.md"] },
      { name: `claude-project/README_HOW_TO_IMPORT.txt`, content: claude["README_HOW_TO_IMPORT.txt"] },
      { name: `sillytavern/${slug}.card.v2v3.png`, content: pngBytes },
      { name: `sillytavern/${slug}.card.v2.json`, content: JSON.stringify(comp.card, null, 2) },
      { name: `sillytavern/${slug}-chat.jsonl`, content: exportSillyTavernJSONL(comp) },
      { name: `sillytavern/${slug}-lorebook.json`, content: exportLorebookWorldInfoJSON(comp) },
      { name: `prompts/kindroid.json`, content: JSON.stringify(prompts.kindroid, null, 2) },
      { name: `prompts/grok-mistral-system.txt`, content: prompts.grokMistral.systemPrompt },
      {
        name: `prompts/chatgpt-custom-instructions.txt`,
        content: `ABOUT USER:\n${prompts.chatgpt.aboutUser}\n\nHOW TO RESPOND:\n${prompts.chatgpt.howToRespond}\n`,
      },
    ];
    const zipBytes = await buildZipBundle(entries);
    downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${slug}-lifeboat-complete.zip`);
  });

  $("share-show-name").addEventListener("change", () => {
    const comp = getActiveCompanion();
    if (comp) renderShareCardPreview(comp);
  });

  $("dl-share-card").addEventListener("click", async () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const pngBytes = await buildShareCardBytes(comp);
    downloadBlob(new Blob([pngBytes], { type: "image/png" }), `lifeboat-rescued-${safeSlug(comp.card.data.name)}.png`);
  });
}

async function downloadTavernPNG() {
  const comp = getActiveCompanion();
  if (!comp) return;
  const pngBytes = await encodeTavernPNG(comp.card, comp.avatarPNG, comp.sourceLabel);
  // Self-verify round-trip before download
  const check = decodeTavernPNG(pngBytes);
  const note = $("png-verify-note");
  if (note) note.textContent = `Verified V2/V3 PNG (${(pngBytes.length / 1024).toFixed(1)} KB · ${check.data.name})`;
  downloadBlob(new Blob([pngBytes], { type: "image/png" }), `${safeSlug(comp.card.data.name)}.card.v2v3.png`);
}

function renderPromptFields(comp) {
  const container = $("prompt-fields");
  const packs = exportPlatformPrompts(comp, state.extraMemories);
  container.innerHTML = "";

  const fields =
    state.promptPlatform === "kindroid"
      ? [
          { label: "Backstory", max: 2500, val: packs.kindroid.backstory },
          { label: "Key Memories", max: 1000, val: packs.kindroid.keyMemories },
          { label: "Response Directive", max: 150, val: packs.kindroid.responseDirective },
          { label: "Example Message", max: 750, val: packs.kindroid.exampleMessage },
        ]
      : state.promptPlatform === "grok"
        ? [{ label: "Grok / Mistral / LeChat System Prompt", max: 4000, val: packs.grokMistral.systemPrompt }]
        : [
            { label: "What would you like ChatGPT to know about you?", max: 1500, val: packs.chatgpt.aboutUser },
            { label: "How would you like ChatGPT to respond?", max: 1500, val: packs.chatgpt.howToRespond },
          ];

  for (const f of fields) {
    const wrap = document.createElement("div");
    wrap.className = "field-block";
    const head = document.createElement("div");
    head.className = "field-head";
    head.innerHTML = `<span>${escapeText(f.label)}</span><span class="char-meter mono">${f.val.length} / ${f.max} chars</span>`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "small";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => copyText(f.val, copyBtn));
    head.appendChild(copyBtn);

    const ta = document.createElement("textarea");
    ta.value = f.val;
    ta.readOnly = true;
    ta.rows = Math.min(8, Math.max(3, Math.ceil(f.val.length / 110)));

    wrap.append(head, ta);
    container.appendChild(wrap);
  }
}

async function buildShareCardBytes(comp) {
  // Exclude raw source threads already folded into a merged companion so totals never double-count.
  const absorbedIds = new Set();
  for (const c of state.companions) {
    for (const id of c.mergedFromIds || []) absorbedIds.add(id);
  }
  const uniqueComps = state.companions.filter((c) => !absorbedIds.has(c.id));
  const totalTurns = uniqueComps.reduce((s, c) => s + (c.stats?.total_turns || 0), 0);
  const totalWords = uniqueComps.reduce((s, c) => s + (c.stats?.total_words || 0), 0);
  const showName = $("share-show-name").checked ? comp.card?.data?.name || "" : "";
  const singleFocus = Boolean(showName) || uniqueComps.length <= 1;
  return renderRescuedShareCard({
    companionCount: singleFocus ? 1 : uniqueComps.length,
    totalTurns: singleFocus ? comp.stats?.total_turns || 0 : totalTurns,
    totalWords: singleFocus ? comp.stats?.total_words || 0 : totalWords,
    spanLabel: comp.span?.spanLabel || "",
    sourceLabel: comp.sourceLabel || comp.source_format,
    destinationLabel: "Portable Offline Archive",
    showName,
  });
}

async function renderShareCardPreview(comp) {
  const bytes = await buildShareCardBytes(comp);
  if (state.shareCardUrl) URL.revokeObjectURL(state.shareCardUrl);
  state.shareCardUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  $("share-card-preview").src = state.shareCardUrl;
}

function wireReader() {
  $("bm25-query").addEventListener("input", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const q = $("bm25-query").value.trim();
    const resBox = $("bm25-results");
    $("btn-bm25-clear").classList.toggle("hidden", !q);

    if (!q) {
      resBox.classList.add("hidden");
      resBox.innerHTML = "";
      return;
    }
    const hits = recallEpisodes(comp.episodes || [], q, 6);
    resBox.innerHTML = "";
    resBox.classList.remove("hidden");
    if (hits.length === 0) {
      resBox.innerHTML = `<div class="bm25-hit">No episodic memory matches for "${escapeText(q)}".</div>`;
      return;
    }
    for (const h of hits) {
      const card = document.createElement("div");
      card.className = "bm25-hit";
      card.innerHTML = `<div class="mono" style="font-size:0.75rem;color:var(--warn)">Turns #${h.start_turn}–${h.end_turn} · BM25 score ${h.score}</div>`;
      const pre = document.createElement("pre");
      pre.textContent = h.transcript;
      card.appendChild(pre);
      resBox.appendChild(card);
    }
  });

  $("btn-bm25-clear").addEventListener("click", () => {
    $("bm25-query").value = "";
    $("bm25-results").classList.add("hidden");
    $("btn-bm25-clear").classList.add("hidden");
  });

  $("btn-load-more").addEventListener("click", () => {
    state.readerLimit += 200;
    const comp = getActiveCompanion();
    if (comp) renderReader(comp);
  });
}

function renderReader(comp) {
  const feed = $("chat-feed");
  const turns = comp.history || [];
  const start = Math.max(0, turns.length - state.readerLimit);
  const slice = turns.slice(start);

  $("reader-count").textContent =
    start > 0
      ? `Showing latest ${slice.length} of ${turns.length.toLocaleString("en-US")} messages`
      : `${turns.length.toLocaleString("en-US")} messages`;

  $("load-more-wrap").classList.toggle("hidden", start === 0);

  feed.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    const div = document.createElement("div");
    div.className = "bubble " + (t.role === "user" ? "user" : "bot");
    const ts = t.timestamp ? t.timestamp.slice(0, 16).replace("T", " ") : `#${start + i + 1}`;
    div.innerHTML = `<div class="bubble-head"><strong>${escapeText(t.speaker)}</strong><span class="mono">${escapeText(ts)}</span></div>`;
    const body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent = t.text;
    div.appendChild(body);
    frag.appendChild(div);
  }
  feed.appendChild(frag);
}

function wireVoiceAndStudio() {
  $("voice-style-lock").addEventListener("input", (e) => {
    const comp = getActiveCompanion();
    if (!comp) return;
    comp.voice.style_lock_prompt = e.target.value;
    comp.card.data.post_history_instructions = e.target.value;
    renderPromptFields(comp);
  });

  $("btn-add-lore").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    const entries = comp.card.data.character_book.entries;
    entries.unshift({
      id: Date.now(),
      name: "New Memory Anchor",
      keys: ["keyword"],
      content: "Describe a shared memory, person, or boundary here.",
      enabled: true,
      insertion_order: 120,
      case_sensitive: false,
      priority: 15,
      position: "before_char",
    });
    comp.stats.lorebook_entries = entries.length;
    renderVoiceTab(comp);
    renderActiveCompanion();
  });

  // Studio bindings
  const bindStudio = (id, fn) => {
    $(id).addEventListener("input", (e) => {
      const comp = getActiveCompanion();
      if (!comp) return;
      fn(comp, e.target.value);
      renderPromptFields(comp);
    });
  };
  bindStudio("studio-name", (c, v) => {
    c.card.data.name = v;
    $("active-name").textContent = v || "Companion";
  });
  bindStudio("studio-desc", (c, v) => (c.card.data.description = v));
  bindStudio("studio-scen", (c, v) => (c.card.data.scenario = v));
  bindStudio("studio-first", (c, v) => (c.card.data.first_mes = v));
  bindStudio("studio-ex", (c, v) => (c.card.data.mes_example = v));

  $("btn-upload-avatar").addEventListener("click", () => $("avatar-input").click());
  $("avatar-input").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    const comp = getActiveCompanion();
    if (!f || !comp) return;
    comp.avatarPNG = new Uint8Array(await f.arrayBuffer());
    refreshPortraitPreview();
  });

  $("btn-dl-studio-png").addEventListener("click", () => downloadTavernPNG());
  $("btn-dl-studio-json").addEventListener("click", () => {
    const comp = getActiveCompanion();
    if (!comp) return;
    downloadBlob(
      new Blob([JSON.stringify(comp.card, null, 2)], { type: "application/json;charset=utf-8" }),
      `${safeSlug(comp.card.data.name)}.card.v2.json`
    );
  });
}

function renderVoiceTab(comp) {
  const v = comp.voice || {};
  const metrics = [
    { val: `${v.avg_words_per_turn || 0}w`, lbl: "Avg Words / Turn" },
    { val: `${v.median_words_per_turn || 0}w`, lbl: "Median Length" },
    { val: `${Math.round((v.action_ratio || 0) * 100)}%`, lbl: "*Action* Rate" },
    { val: `${Math.round((v.dialogue_ratio || 0) * 100)}%`, lbl: "Quoted Speech" },
    { val: `${Math.round((v.question_ratio || 0) * 100)}%`, lbl: "Question Rate" },
    { val: `${comp.stats?.episode_count || 0}`, lbl: "BM25 Episodes" },
  ];
  $("voice-metrics").innerHTML = metrics
    .map((m) => `<div class="metric-box"><div class="metric-val mono">${escapeText(m.val)}</div><div class="metric-lbl">${escapeText(m.lbl)}</div></div>`)
    .join("");

  $("voice-style-lock").value = v.style_lock_prompt || "";

  const pBox = $("voice-phrases");
  pBox.innerHTML = "";
  if (v.top_phrases?.length) {
    const lbl = document.createElement("span");
    lbl.style.cssText = "font-size:0.8rem;color:var(--muted);align-self:center";
    lbl.textContent = "Signature phrases:";
    pBox.appendChild(lbl);
    for (const p of v.top_phrases) {
      const span = document.createElement("span");
      span.className = "pill mono";
      span.textContent = p;
      pBox.appendChild(span);
    }
  }

  const loreEl = $("lore-list");
  loreEl.innerHTML = "";
  const entries = comp.card?.data?.character_book?.entries || [];
  entries.forEach((entry, idx) => {
    const item = document.createElement("div");
    item.className = "lore-item";

    const head = document.createElement("div");
    head.className = "lore-head";
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = entry.name || "";
    nameIn.style.fontWeight = "700";
    nameIn.addEventListener("input", () => (entry.name = nameIn.value));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "small ghost";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      entries.splice(idx, 1);
      comp.stats.lorebook_entries = entries.length;
      renderVoiceTab(comp);
      renderPromptFields(comp);
    });
    head.append(nameIn, delBtn);

    const keysIn = document.createElement("input");
    keysIn.type = "text";
    keysIn.className = "mono";
    keysIn.style.cssText = "font-size:0.78rem;margin-bottom:0.45rem";
    keysIn.placeholder = "Trigger keywords (comma-separated)";
    keysIn.value = (entry.keys || []).join(", ");
    keysIn.addEventListener("input", () => {
      entry.keys = keysIn.value.split(",").map((s) => s.trim()).filter(Boolean);
    });

    const bodyIn = document.createElement("textarea");
    bodyIn.value = entry.content || "";
    bodyIn.addEventListener("input", () => {
      entry.content = bodyIn.value;
      renderPromptFields(comp);
    });

    item.append(head, keysIn, bodyIn);
    loreEl.appendChild(item);
  });
}

function renderStudioTab(comp) {
  $("studio-name").value = comp.card?.data?.name || "";
  $("studio-desc").value = comp.card?.data?.description || "";
  $("studio-scen").value = comp.card?.data?.scenario || "";
  $("studio-first").value = comp.card?.data?.first_mes || "";
  $("studio-ex").value = comp.card?.data?.mes_example || "";
  $("png-verify-note").textContent = "";
  if (state.activeTab === "studio") refreshPortraitPreview();
}

async function refreshPortraitPreview() {
  const comp = getActiveCompanion();
  if (!comp) return;
  let bytes = comp.avatarPNG;
  if (!bytes) {
    bytes = await renderPortraitPNG(comp.card?.data?.name || "Companion", comp.sourceLabel || "");
  }
  if (state.portraitUrl) URL.revokeObjectURL(state.portraitUrl);
  state.portraitUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  $("card-portrait-preview").src = state.portraitUrl;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = prev), 1400);
  } catch {
    window.prompt("Copy text:", text);
  }
}

function escapeText(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
