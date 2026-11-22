// Pure client-side ZIP extraction (supporting ZipCrypto & WinZip AES-256 encrypted archives,
// including Character.AI's lowercase-email password-protected GDPR .zip files) and ZIP bundle writer.

import {
  configure,
  ZipReader,
  ZipWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  TextReader,
  ERR_ENCRYPTED,
  ERR_INVALID_PASSWORD,
} from "@zip.js/zip.js";

// Keep everything in-thread so it works identically in Airplane Mode, CSP-locked hosts,
// mobile Safari, file://, and headless Node tests with zero external worker scripts.
configure({ useWebWorkers: false });

const MAX_ENTRY_BYTES = 256 * 1024 * 1024; // 256 MB safety cap per entry

export function isZipBytes(bytes) {
  return (
    bytes &&
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

/**
 * Inspects and extracts relevant JSON/JSONL/TXT/PNG entries from a .zip Uint8Array.
 * Returns:
 *   { status: "needs_password", encryptedCount }
 *   { status: "wrong_password", message }
 *   { status: "ok", files: Map<string, Uint8Array>, avatars: Uint8Array[], unlockedWithLowercase: boolean, totalEntries: number }
 */
export async function extractZipArchive(rawBytes, password = "") {
  const reader = new ZipReader(new Uint8ArrayReader(rawBytes));
  try {
    const entries = await reader.getEntries();
    const relevant = entries.filter((e) => !e.directory && isRelevantEntry(e.filename));
    const encryptedEntries = relevant.filter((e) => e.encrypted);

    if (encryptedEntries.length > 0 && !password) {
      return {
        status: "needs_password",
        encryptedCount: encryptedEntries.length,
        totalEntries: entries.length,
      };
    }

    // Try exact password first; if Character.AI user typed mixed-case email or leading/trailing spaces,
    // automatically retry trimmed lowercase!
    const candidates = [];
    if (password) {
      candidates.push({ pw: password, lowered: false });
      const trimmedLower = password.trim().toLowerCase();
      if (trimmedLower !== password) {
        candidates.push({ pw: trimmedLower, lowered: true });
      }
    } else {
      candidates.push({ pw: undefined, lowered: false });
    }

    let lastErr = null;
    for (const cand of candidates) {
      try {
        const files = new Map();
        const avatars = [];
        for (const entry of relevant) {
          if (entry.uncompressedSize > MAX_ENTRY_BYTES) continue;
          const opts = entry.encrypted && cand.pw !== undefined ? { password: cand.pw } : undefined;
          const data = await entry.getData(new Uint8ArrayWriter(), opts);
          const clean = entry.filename.replace(/\\/g, "/").replace(/^\.\//, "");
          files.set(clean, data);
          if (clean.toLowerCase().endsWith(".png") && data.length > 8) {
            avatars.push(data);
          }
        }
        return {
          status: "ok",
          files,
          avatars,
          unlockedWithLowercase: cand.lowered,
          totalEntries: entries.length,
        };
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err || "");
        const isPwErr =
          msg.includes(ERR_INVALID_PASSWORD) ||
          msg.includes(ERR_ENCRYPTED) ||
          /invalid password|encrypted|wrong password/i.test(msg);
        if (!isPwErr) throw err;
      }
    }

    return {
      status: "wrong_password",
      message:
        "That password didn't unlock the archive. For official Character.AI exports, use your Character.AI account email in all lowercase.",
      detail: String(lastErr?.message || ""),
    };
  } finally {
    await reader.close();
  }
}

function isRelevantEntry(filename) {
  const lower = filename.toLowerCase();
  if (lower.startsWith("__macosx/") || lower.includes("/._")) return false;
  return (
    lower.endsWith(".json") ||
    lower.endsWith(".jsonl") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".png")
  );
}

/**
 * Creates a downloadable ZIP Uint8Array from an array of { name, content } entries
 * where content is either a string or Uint8Array.
 */
export async function buildZipBundle(entries, options = {}) {
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer, options.password ? { password: options.password } : undefined);
  for (const item of entries) {
    if (typeof item.content === "string") {
      await zipWriter.add(item.name, new TextReader(item.content), options.entryOptions);
    } else if (item.content instanceof Uint8Array) {
      await zipWriter.add(item.name, new Uint8ArrayReader(item.content), options.entryOptions);
    }
  }
  await zipWriter.close();
  return writer.getData();
}
