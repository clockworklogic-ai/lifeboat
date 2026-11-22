// Pure binary PNG tEXt chunk encoder/decoder for Tavern V2 ("chara") and V3 ("ccv3") cards,
// plus deterministic editorial portrait & anonymized "Rescued" proof card renderers.
// Works in both browsers (Canvas) and Node (minimal uncompressed PNG fallback).

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Precomputed IEEE CRC-32 table
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function isPNG(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return false;
  }
  return true;
}

// UTF-8 safe base64 encode/decode (never throws InvalidCharacterError on emojis or non-ASCII)
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return bytesToBase64(bytes);
}

export function base64ToUtf8(b64) {
  const bytes = base64ToBytes(b64);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readUint32BE(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeUint32BE(buf, off, val) {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function makeChunk(typeStr, dataBytes) {
  const typeBytes = new TextEncoder().encode(typeStr);
  const out = new Uint8Array(12 + dataBytes.length);
  writeUint32BE(out, 0, dataBytes.length);
  out.set(typeBytes, 4);
  out.set(dataBytes, 8);
  const crcInput = out.subarray(4, 8 + dataBytes.length);
  writeUint32BE(out, 8 + dataBytes.length, crc32(crcInput));
  return out;
}

export function stripExistingCardChunks(pngBytes) {
  if (!isPNG(pngBytes)) throw new Error("Not a valid PNG file");
  const parts = [PNG_SIG];
  let offset = 8;
  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BE(pngBytes, offset);
    const total = 12 + length;
    if (offset + total > pngBytes.length) break;
    const type = String.fromCharCode(
      pngBytes[offset + 4],
      pngBytes[offset + 5],
      pngBytes[offset + 6],
      pngBytes[offset + 7]
    );
    let skip = false;
    if (type === "tEXt") {
      const data = pngBytes.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const kw = new TextDecoder("latin1").decode(data.subarray(0, nul));
        if (kw === "chara" || kw === "ccv3") skip = true;
      }
    }
    if (!skip) parts.push(pngBytes.subarray(offset, offset + total));
    offset += total;
  }
  const size = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(size);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function injectPNGTextChunk(pngBytes, keyword, asciiText) {
  if (!isPNG(pngBytes)) throw new Error("Invalid base PNG");
  const kwBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(asciiText);
  const payload = new Uint8Array(kwBytes.length + 1 + textBytes.length);
  payload.set(kwBytes, 0);
  payload[kwBytes.length] = 0;
  payload.set(textBytes, kwBytes.length + 1);
  const chunk = makeChunk("tEXt", payload);

  let offset = 8;
  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BE(pngBytes, offset);
    const type = String.fromCharCode(
      pngBytes[offset + 4],
      pngBytes[offset + 5],
      pngBytes[offset + 6],
      pngBytes[offset + 7]
    );
    if (type === "IEND") {
      const out = new Uint8Array(pngBytes.length + chunk.length);
      out.set(pngBytes.subarray(0, offset), 0);
      out.set(chunk, offset);
      out.set(pngBytes.subarray(offset), offset + chunk.length);
      return out;
    }
    offset += 12 + length;
  }
  throw new Error("IEND chunk not found in PNG");
}

export function decodeTavernPNG(pngBytes) {
  if (!isPNG(pngBytes)) throw new Error("Not a valid PNG file");
  let offset = 8;
  let charaB64 = "";
  let ccv3B64 = "";
  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BE(pngBytes, offset);
    if (offset + 12 + length > pngBytes.length) break;
    const type = String.fromCharCode(
      pngBytes[offset + 4],
      pngBytes[offset + 5],
      pngBytes[offset + 6],
      pngBytes[offset + 7]
    );
    if (type === "tEXt") {
      const data = pngBytes.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const kw = new TextDecoder("latin1").decode(data.subarray(0, nul));
        const val = new TextDecoder("latin1").decode(data.subarray(nul + 1));
        if (kw === "chara") charaB64 = val;
        if (kw === "ccv3") ccv3B64 = val;
      }
    }
    offset += 12 + length;
  }
  const found = charaB64 || ccv3B64;
  if (!found) throw new Error("No 'chara' or 'ccv3' metadata chunk found in PNG");
  const jsonText = base64ToUtf8(found);
  const card = JSON.parse(jsonText);
  if (!card.data) {
    // Tavern V1 embedded inside chara
    return {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: card.name || "Companion",
        description: card.description || "",
        personality: card.personality || "",
        scenario: card.scenario || "",
        first_mes: card.first_mes || "",
        mes_example: card.mes_example || "",
        creator_notes: card.creator_notes || "",
        system_prompt: card.system_prompt || "",
        post_history_instructions: card.post_history_instructions || "",
        alternate_greetings: card.alternate_greetings || [],
        tags: card.tags || [],
        creator: card.creator || "",
        character_version: card.character_version || "1.0",
        character_book: card.character_book || null,
      },
    };
  }
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: card.data,
  };
}

// Minimal valid solid-color PNG fallback for Node headless environments (no Canvas)
function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function generateFallbackPNG(name = "Companion", width = 64, height = 96) {
  let seed = 2166136261;
  for (let i = 0; i < name.length; i++) {
    seed ^= name.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const r1 = 36 + (seed & 0x3f);
  const g1 = 40 + ((seed >>> 6) & 0x3f);
  const b1 = 58 + ((seed >>> 12) & 0x4f);
  const r2 = 135 + ((seed >>> 18) & 0x4f);
  const g2 = 72 + ((seed >>> 24) & 0x3f);
  const b2 = 62 + ((seed >>> 10) & 0x3f);

  const rowStride = 1 + width * 3;
  const raw = new Uint8Array(rowStride * height);
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const cr = Math.round(r1 * (1 - t) + r2 * t);
    const cg = Math.round(g1 * (1 - t) + g2 * t);
    const cb = Math.round(b1 * (1 - t) + b2 * t);
    const rowOff = y * rowStride;
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const border = x === 3 || x === width - 4 || y === 3 || y === height - 4;
      raw[rowOff + 1 + x * 3] = border ? 226 : cr;
      raw[rowOff + 2 + x * 3] = border ? 210 : cg;
      raw[rowOff + 3 + x * 3] = border ? 182 : cb;
    }
  }

  // Zlib stream with stored blocks (no external deflate lib required)
  const blocks = [];
  const maxBlock = 65535;
  for (let pos = 0; pos < raw.length; pos += maxBlock) {
    const slice = raw.subarray(pos, Math.min(raw.length, pos + maxBlock));
    const isLast = pos + slice.length >= raw.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = isLast;
    hdr[1] = slice.length & 0xff;
    hdr[2] = (slice.length >>> 8) & 0xff;
    const nlen = (~slice.length) & 0xffff;
    hdr[3] = nlen & 0xff;
    hdr[4] = (nlen >>> 8) & 0xff;
    blocks.push(hdr, slice);
  }
  const zlibLen = 2 + blocks.reduce((s, b) => s + b.length, 0) + 4;
  const zlib = new Uint8Array(zlibLen);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let zpos = 2;
  for (const b of blocks) {
    zlib.set(b, zpos);
    zpos += b.length;
  }
  writeUint32BE(zlib, zpos, adler32(raw));

  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const cIHDR = makeChunk("IHDR", ihdr);
  const cIDAT = makeChunk("IDAT", zlib);
  const cIEND = makeChunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(PNG_SIG.length + cIHDR.length + cIDAT.length + cIEND.length);
  let p = 0;
  for (const part of [PNG_SIG, cIHDR, cIDAT, cIEND]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export async function renderPortraitPNG(name, subtitle = "") {
  if (typeof document === "undefined") {
    return generateFallbackPNG(name);
  }
  const w = 500, h = 750;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  let seed = 2166136261;
  for (let i = 0; i < name.length; i++) {
    seed ^= name.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const hue1 = (seed % 360);
  const hue2 = (hue1 + 32 + ((seed >>> 8) % 35)) % 360;

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue1}, 30%, 16%)`);
  grad.addColorStop(0.55, `hsl(${hue2}, 34%, 22%)`);
  grad.addColorStop(1, `hsl(${hue1}, 26%, 11%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle archival radial glow
  const rad = ctx.createRadialGradient(w * 0.5, h * 0.36, 12, w * 0.5, h * 0.36, 260);
  rad.addColorStop(0, "rgba(245, 224, 190, 0.14)");
  rad.addColorStop(1, "rgba(245, 224, 190, 0)");
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, w, h);

  // Double archival border
  ctx.strokeStyle = "rgba(232, 214, 184, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 22, w - 44, h - 44);
  ctx.strokeStyle = "rgba(232, 214, 184, 0.22)";
  ctx.lineWidth = 1;
  ctx.strokeRect(30, 30, w - 60, h - 60);

  // Monogram emblem
  const words = (name || "C").trim().split(/\s+/);
  const initials = words.length >= 2
    ? (words[0][0] + words[1][0]).toUpperCase()
    : (name.slice(0, 2) || "LB").toUpperCase();

  ctx.beginPath();
  ctx.arc(w / 2, h * 0.36, 86, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(232, 214, 184, 0.45)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#f4ecdc";
  ctx.font = '600 68px Georgia, "Iowan Old Style", serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, w / 2, h * 0.365);

  // Companion title
  ctx.fillStyle = "#f7f3ea";
  ctx.font = '600 32px Georgia, "Iowan Old Style", serif';
  const displayName = name.length > 22 ? name.slice(0, 21) + "…" : name;
  ctx.fillText(displayName, w / 2, h * 0.62);

  if (subtitle) {
    ctx.fillStyle = "rgba(236, 224, 202, 0.72)";
    ctx.font = '500 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(subtitle.toUpperCase(), w / 2, h * 0.68);
  }

  ctx.fillStyle = "rgba(232, 214, 184, 0.45)";
  ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText("LIFEBOAT · PORTABLE COMPANION CARD V2/V3", w / 2, h - 52);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function normalizeImageToPNG(rawBytes) {
  if (isPNG(rawBytes)) return stripExistingCardChunks(rawBytes);
  if (typeof document === "undefined") {
    throw new Error("Non-PNG avatar conversion requires browser canvas");
  }
  const blob = new Blob([rawBytes]);
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode custom avatar image"));
      el.src = url;
    });
    const maxDim = 1024;
    let w = img.naturalWidth || 500;
    let h = img.naturalHeight || 750;
    if (w > maxDim || h > maxDim) {
      const scale = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await outBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function encodeTavernPNG(card, customAvatarBytes = null, subtitle = "") {
  const v2 = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: card.data,
  };
  const v3 = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: card.data,
  };
  const b64V2 = utf8ToBase64(JSON.stringify(v2));
  const b64V3 = utf8ToBase64(JSON.stringify(v3));

  let basePNG;
  if (customAvatarBytes && customAvatarBytes.length > 0) {
    try {
      basePNG = await normalizeImageToPNG(customAvatarBytes);
    } catch {
      basePNG = await renderPortraitPNG(card.data?.name || "Companion", subtitle);
    }
  } else {
    basePNG = await renderPortraitPNG(card.data?.name || "Companion", subtitle);
  }

  const withV2 = injectPNGTextChunk(basePNG, "chara", b64V2);
  return injectPNGTextChunk(withV2, "ccv3", b64V3);
}

// Generates an anonymized, zero-chat-text "RESCUED" boarding pass PNG for sharing on Reddit/X/TikTok.
export async function renderRescuedShareCard({
  companionCount = 1,
  totalTurns = 0,
  totalWords = 0,
  spanLabel = "",
  sourceLabel = "AI Archive",
  destinationLabel = "Offline Portable Archive",
  showName = "",
  siteLabel = "lifeboat-22u.pages.dev · 0 bytes uploaded",
}) {
  if (typeof document === "undefined") {
    return generateFallbackPNG("RESCUED", 120, 63);
  }
  const w = 1200, h = 630;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  // Warm archival paper + dark maritime left rail
  ctx.fillStyle = "#13171f";
  ctx.fillRect(0, 0, w, h);

  // Subtle top accent bar
  ctx.fillStyle = "#c85532";
  ctx.fillRect(0, 0, w, 10);

  // Inner archival card frame
  ctx.strokeStyle = "rgba(238, 226, 204, 0.22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 42, w - 72, h - 84);

  // Top badge
  ctx.fillStyle = "#1f6f4a";
  roundRect(ctx, 76, 80, 260, 40, 20);
  ctx.fill();
  ctx.fillStyle = "#eefaf2";
  ctx.font = '700 16px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("●  0 BYTES UPLOADED", 98, 100);

  // Right stamp
  ctx.fillStyle = "rgba(238, 226, 204, 0.55)";
  ctx.font = '600 16px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = "right";
  ctx.fillText("BOARDING PASS · ARCHIVE RESCUED", w - 76, 100);

  // Headline
  ctx.textAlign = "left";
  ctx.fillStyle = "#f7f3ea";
  ctx.font = '700 58px Georgia, "Iowan Old Style", serif';
  const headline = showName
    ? `${showName} is safely off-platform.`
    : companionCount > 1
      ? `${companionCount} companions safely off-platform.`
      : "Companion archive safely rescued.";
  ctx.fillText(headline.length > 38 ? headline.slice(0, 37) + "…" : headline, 76, 198);

  // Route line
  ctx.fillStyle = "#e07a5f";
  ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${sourceLabel}  →  ${destinationLabel}`, 76, 258);

  // Divider
  ctx.strokeStyle = "rgba(238, 226, 204, 0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(76, 304);
  ctx.lineTo(w - 76, 304);
  ctx.stroke();

  // Metrics row (3 columns)
  const metrics = [
    { val: totalTurns.toLocaleString("en-US"), label: "MESSAGES SAVED" },
    { val: totalWords.toLocaleString("en-US"), label: "WORDS PRESERVED" },
    { val: spanLabel || `${companionCount} ARCHIVE${companionCount === 1 ? "" : "S"}`, label: spanLabel ? "HISTORY SPAN" : "COMPANIONS" },
  ];
  metrics.forEach((m, idx) => {
    const x = 76 + idx * 355;
    ctx.fillStyle = "#f7f3ea";
    ctx.font = '700 52px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(m.val, x, 386);
    ctx.fillStyle = "rgba(238, 226, 204, 0.62)";
    ctx.font = '600 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(m.label, x, 434);
  });

  // Bottom bar
  ctx.strokeStyle = "rgba(238, 226, 204, 0.16)";
  ctx.beginPath();
  ctx.moveTo(76, 502);
  ctx.lineTo(w - 76, 502);
  ctx.stroke();

  ctx.fillStyle = "rgba(238, 226, 204, 0.72)";
  ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText("No private messages shown · Unlocked & compiled locally in Airplane Mode", 76, 542);

  ctx.textAlign = "right";
  ctx.fillStyle = "#f4ecdc";
  ctx.font = '700 18px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(siteLabel, w - 76, 542);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
