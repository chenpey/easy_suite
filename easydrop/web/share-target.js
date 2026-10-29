// Pure rules for receiving Android system shares through the PWA share target.
// This module deliberately avoids browser globals so Node can test it directly.
export const SHARE_TARGET_PATH = "/share-target";
export const SHARE_TARGET_TTL_MS = 10 * 60 * 1000;
export const SHARE_TARGET_PENDING_KEY = "pending";
export const SHARE_TARGET_DB_NAME = "easydrop-share-target";
export const SHARE_TARGET_STORE_NAME = "shares";
export const SHARE_TARGET_TEXT_FIELDS = ["title", "text", "url"];

// A share navigates into the installed app from the operating system, so only a
// same-origin POST navigation may be received. Origin/Referer/Sec-Fetch-Site are
// deliberately not used: the service worker cannot read the Sec-Fetch-* headers,
// and the remaining headers cannot prove the share came from the system.
export function canReceiveShare({ method, sameOrigin, pathname, mode }) {
  return method === "POST" &&
    sameOrigin === true &&
    pathname === SHARE_TARGET_PATH &&
    mode === "navigate";
}

const isFileValue = (value) => value !== null &&
  typeof value === "object" &&
  typeof value.name === "string" &&
  typeof value.type === "string" &&
  typeof value.size === "number" &&
  typeof value.slice === "function";

// Title, text and URL are joined verbatim so the recipient sees exactly what the
// sending app provided; trimming only decides whether a field is empty.
export function composeSharedText({ title = "", text = "", url = "" } = {}) {
  return [title, text, url].filter((value) => value.trim()).join("\n");
}

// Returns null for payloads that must not be staged (unknown field types, no
// content). Unselected file inputs arrive as an empty, nameless zero-byte file.
export function parseShareFormData(form) {
  const fields = {};
  for (const name of SHARE_TARGET_TEXT_FIELDS) {
    const value = form.get(name);
    if (value === null || value === undefined) {
      fields[name] = "";
      continue;
    }
    if (typeof value !== "string") return null;
    fields[name] = value;
  }
  const files = [];
  for (const value of form.getAll("files")) {
    if (!isFileValue(value)) return null;
    if (!value.name && value.size === 0) continue;
    files.push({
      blob: value,
      name: value.name,
      type: value.type,
      lastModified: Number.isFinite(value.lastModified) ? value.lastModified : 0,
    });
  }
  if (!composeSharedText(fields) && !files.length) return null;
  return { ...fields, files };
}

export function createPendingShare(content, now) {
  return {
    state: "pending",
    createdAt: now,
    expiresAt: now + SHARE_TARGET_TTL_MS,
    title: content.title,
    text: content.text,
    url: content.url,
    files: content.files,
  };
}

const isStoredFile = (file) => file !== null && typeof file === "object" &&
  typeof file.name === "string" &&
  typeof file.type === "string" &&
  file.blob !== null && typeof file.blob === "object";

// Validates a stored slot at the moment it is actually read. Expired records
// never return their content, and a notified tombstone stays silent so a plain
// app launch does not repeat the warning.
export function inspectPendingShare(record, now) {
  if (record === undefined || record === null) return { status: "empty" };
  if (typeof record !== "object") return { status: "invalid" };
  if (record.state === "expired") {
    if (typeof record.notified !== "boolean") return { status: "invalid" };
    return { status: record.notified ? "silent" : "expired" };
  }
  if (record.state !== "pending") return { status: "invalid" };
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)) return { status: "invalid" };
  if (!SHARE_TARGET_TEXT_FIELDS.every((name) => typeof record[name] === "string")) return { status: "invalid" };
  if (!Array.isArray(record.files) || !record.files.every(isStoredFile)) return { status: "invalid" };
  if (now >= record.expiresAt) return { status: "expired" };
  const text = composeSharedText(record);
  if (!text && !record.files.length) return { status: "invalid" };
  return { status: "ready", text, files: record.files };
}

export function expiredTombstone(record, notified) {
  return { state: "expired", createdAt: record.createdAt, expiresAt: record.expiresAt, notified };
}
