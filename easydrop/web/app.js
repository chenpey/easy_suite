import { createIcons, LogIn, LogOut, QrCode, Text, Files, FileUp, Send, Download, Pause, Play, RefreshCw, Trash2, X, Copy, Eye, EyeOff, Check, Image as ImageIcon, FileText, Users, UserPlus, Pencil, UserCheck, UserX, Share2, Unlink, KeyRound, UserRound } from "lucide";
import QRCode from "qrcode";
import { t, uiLanguage, dateLocale, setLanguage, renderStaticI18n } from "./i18n.js";

const icons = { LogIn, LogOut, QrCode, Text, Files, FileUp, Send, Download, Pause, Play, RefreshCw, Trash2, X, Copy, Eye, EyeOff, Check, Image: ImageIcon, FileText, Users, UserPlus, Pencil, UserCheck, UserX, Share2, Unlink, KeyRound, UserRound };
const APP_VERSION = __EASYDROP_VERSION__;
const renderIcons = () => createIcons({ icons });
const $ = (id) => document.getElementById(id);

renderStaticI18n();

for (const id of ["language-select", "login-language-select"]) {
  const select = $(id);
  if (!select) continue;
  select.value = uiLanguage;
  select.addEventListener("change", () => {
    setLanguage(select.value);
  });
}
const isLogin = document.body.dataset.page === "login";
if ($("app-version")) $("app-version").textContent = `v${APP_VERSION}`;
let session;
let noticeTimer;
let clearCopyFeedback;
let nextCursor = null;
let currentRevision = -1;
let loading = false;
let deletingHistory = false;
let pendingRefresh = false;
let pendingHistoryPage = null;
let uploading = false;
let pauseRequested = false;
let uploadQueue = [];
let pollTimer;
let pollingStopped = false;
let revisionCheckRunning = false;
let pollFailureCount = 0;
let textSubmitting = false;
let textOperation;
let historyPage = 0;
let historyTotal = 0;
let historyTotalPages = 1;
let historyCursors = [null];
let sessionEnded = false;
let temporaryShareItem;
let temporaryShareGeneration = 0;
const maxPollRetrySeconds = 60;
const activeUploads = new Set();
const activeRequests = new Set();
const busyButtons = new WeakSet();
const copyFeedbackTimers = new WeakMap();
const historyRowCache = new Map();
const previewSourceTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const previewSourceExtension = /\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;
const clipboardImageExtensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
]);
const previewMaxSide = 512;
const previewMaxBytes = 512 * 1024;
const legacyThumbnailFallbackWidth = 384;
const legacyThumbnailFallbackBytes = 8 * 1024 * 1024;
let retainHistoryRows = false;
const uploadStorageKey = () => `easydrop/resumable-uploads/v2/${session?.user.id || "anonymous"}`;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed.", error));
  });
}

class UploadPaused extends Error {}

function requestedDownloadPath() {
  const path = new URL(location.href).searchParams.get("next") || "";
  return /^\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[^/]+$/.test(path)
    ? path
    : null;
}

function notice(message, error = false, duration = error ? 8000 : 1600) {
  clearTimeout(noticeTimer);
  clearCopyFeedback?.();
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("error-details").hidden = true;
  $("error-details").open = false;
  if (message && duration) noticeTimer = setTimeout(() => {
    if ($("error-details").open) return;
    $("notice").textContent = "";
    $("error-details").hidden = true;
  }, duration);
}

function report(error) {
  notice(error.message, true);
  $("error-body").textContent = error.details || String(error);
  $("error-details").hidden = false;
}

function apiError(method, path, status, body) {
  let message = `HTTP ${status}`;
  try { message = JSON.parse(body).message || message; } catch { /* Keep non-JSON error bodies intact. */ }
  const error = new Error(message);
  error.status = status;
  error.details = `${method} ${path}\nHTTP ${status}\n${body}`;
  if (status === 401 && message === "Authentication required." && !isLogin) expireSession();
  return error;
}

function expireSession() {
  pollingStopped = true;
  clearTimeout(pollTimer);
  for (const xhr of activeUploads) xhr.abort();
  $("history-list")?.replaceChildren();
  historyRowCache.clear();
  session = null;
  sessionEnded = true;
  uploading = false;
  textSubmitting = false;
  for (const controller of activeRequests) controller.abort();
  location.replace("/login");
}

async function api(path, { method = "GET", data, payload, contentType, operationKey } = {}) {
  if (data !== undefined && payload !== undefined) throw new Error("API request body is ambiguous.");
  const headers = {};
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (contentType) headers["Content-Type"] = contentType;
  if (operationKey) headers["Idempotency-Key"] = operationKey;
  if (method !== "GET" && session) headers["X-CSRF-Token"] = session.csrfToken;
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method, headers, body: data === undefined ? payload : JSON.stringify(data),
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    });
    const body = await response.text();
    if (sessionEnded) throw new Error("Session ended.");
    if (!response.ok) throw apiError(method, path, response.status, body);
    try { return JSON.parse(body); } catch { throw apiError(method, path, response.status, body); }
  } catch (error) {
    if (!error.details) error.details = `${method} ${path}\n${error.name}: ${error.message}`;
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(controller);
  }
}

async function busy(button, action) {
  if (busyButtons.has(button)) return;
  busyButtons.add(button);
  button.disabled = true;
  try { await action(); } catch (error) { if (!sessionEnded) report(error); } finally {
    busyButtons.delete(button);
    button.disabled = false;
  }
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function icon(name) {
  const node = document.createElement("i");
  node.dataset.lucide = name;
  return node;
}

function appendLinkifiedText(container, value) {
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    let candidate = match[0];
    let suffix = "";
    while (/[.,;:!?，。；：！？、]$/u.test(candidate)) {
      suffix = candidate.at(-1) + suffix;
      candidate = candidate.slice(0, -1);
    }
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    container.append(document.createTextNode(value.slice(offset, match.index)));
    const link = document.createElement("a");
    link.className = "item-text-link";
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = candidate;
    container.append(link, document.createTextNode(suffix));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(value.slice(offset)));
}

function actionButton(label, name, handler, danger = false) {
  const button = document.createElement("button");
  button.className = `icon-button${danger ? " danger" : ""}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", () => busy(button, () => handler(button)));
  return button;
}

function setupPasswordToggles(root = document) {
  for (const toggle of root.querySelectorAll(".password-toggle")) {
    if (toggle.dataset.bound) continue;
    toggle.dataset.bound = "true";
    toggle.addEventListener("click", () => {
      const field = toggle.closest(".password-field");
      const input = field?.querySelector("input");
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      toggle.title = isPassword ? t("hide_password") : t("show_password");
      toggle.setAttribute("aria-label", isPassword ? t("hide_password") : t("show_password"));
      toggle.replaceChildren(icon(isPassword ? "eye-off" : "eye"));
      renderIcons();
    });
  }
}

function setupPasswordRules(input, rulesContainer) {
  if (!input || !rulesContainer) return;
  const rules = {
    length: { el: rulesContainer.querySelector('[data-rule="length"]'), label: t("at_least_12_chars") },
    upper: { el: rulesContainer.querySelector('[data-rule="upper"]'), label: t("contains_uppercase") },
    lower: { el: rulesContainer.querySelector('[data-rule="lower"]'), label: t("contains_lowercase") },
    number: { el: rulesContainer.querySelector('[data-rule="number"]'), label: t("contains_number") },
  };
  const check = () => {
    const val = input.value;
    const checks = {
      length: val.length >= 12 && val.length <= 32,
      upper: /[A-Z]/.test(val),
      lower: /[a-z]/.test(val),
      number: /[0-9]/.test(val),
    };
    for (const [key, rule] of Object.entries(rules)) {
      if (!rule.el) continue;
      const valid = Boolean(checks[key]);
      rule.el.classList.toggle("valid", valid);
      rule.el.replaceChildren(icon(valid ? "check" : "x"), document.createTextNode(rule.label));
    }
    renderIcons();
  };
  input.addEventListener("input", check);
  check();
}

function confirmDelete(title) {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

function resetUserForm() {
  $("user-form").reset();
  $("user-id").value = "";
  $("user-enabled").checked = true;
  $("user-password").required = true;
  $("user-password-label").textContent = t("password");
  $("user-submit-label").textContent = t("add_user");
  $("user-cancel").hidden = true;
}

async function loadUsers() {
  const [data, authConfig] = await Promise.all([api("/api/users"), api("/api/auth/config")]);
  $("registration-enabled").checked = authConfig.registrationEnabled;
  const list = $("user-list");
  list.replaceChildren();
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = `user-row${user.enabled ? "" : " user-disabled"}`;
    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.textContent = (user.username || "U").charAt(0).toUpperCase();

    const meta = document.createElement("div");
    meta.className = "user-meta";
    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.username;

    const detail = document.createElement("div");
    detail.className = "user-detail";

    const roleBadge = document.createElement("span");
    roleBadge.className = `badge ${user.role === "admin" ? "badge-admin" : "badge-user"}`;
    roleBadge.textContent = user.role === "admin" ? t("admin_user") : t("regular_user");

    const sep = document.createElement("span");
    sep.className = "user-sep";
    sep.textContent = " · ";

    const statusBadge = document.createElement("span");
    const statusClass = user.pendingApproval ? "badge-warning" : user.enabled ? "badge-success" : "badge-muted";
    const state = user.pendingApproval ? t("pending_approval") : user.enabled ? t("enabled") : t("disabled");
    statusBadge.className = `badge ${statusClass}`;
    statusBadge.textContent = state;

    detail.append(roleBadge, sep, statusBadge);
    meta.append(name, detail);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const edit = actionButton(t("edit_user"), "pencil", () => {
      $("user-id").value = user.id;
      $("user-name").value = user.username;
      $("user-password").value = "";
      $("user-password").required = false;
      $("user-password-label").textContent = t("new_password_keep");
      $("user-role").value = user.role;
      $("user-enabled").checked = user.enabled;
      $("user-submit-label").textContent = t("save_changes");
      $("user-cancel").hidden = false;
      $("user-name").focus();
    });
    const toggle = actionButton(user.enabled ? t("disable_user") : t("enable_user"), user.enabled ? "user-x" : "user-check", async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", data: { enabled: !user.enabled } });
      await loadUsers();
    });
    const remove = actionButton(t("delete_user"), "trash-2", async () => {
      if (!await confirmDelete(t("delete_user_confirm", user.username))) return;
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      await loadUsers();
    }, true);
    if (user.id === session.user.id) {
      toggle.disabled = true;
      remove.disabled = true;
    }
    actions.append(edit, toggle, remove);
    row.append(avatar, meta, actions);
    list.append(row);
  }
  renderIcons();
  if (session?.user?.role === "admin") {
    const activeAdminCount = data.users.filter((u) => u.role === "admin" && u.enabled && !u.pendingApproval).length;
    session.user.canDeleteAccount = activeAdminCount >= 2;
    updateDeleteAccountVisibility();
  }
}

function showCopyFeedback(button, status, popover) {
  if (!button) return;
  clearCopyFeedback?.();
  notice("");
  clearTimeout(copyFeedbackTimers.get(button));
  status.textContent = t("copied");
  if (popover) {
    button.dataset.copyFeedback = t("copied");
    button.classList.add("copy-confirmed");
  }
  clearCopyFeedback = () => {
    clearTimeout(copyFeedbackTimers.get(button));
    button.classList.remove("copy-confirmed");
    delete button.dataset.copyFeedback;
    status.textContent = "";
    copyFeedbackTimers.delete(button);
    clearCopyFeedback = null;
  };
  copyFeedbackTimers.set(button, setTimeout(clearCopyFeedback, 1600));
}

async function copy(value, button, status) {
  await navigator.clipboard.writeText(value);
  showCopyFeedback(button, status || $("copy-notice"), !status);
}

function requireMatchingPasswords(passwordId, confirmationId) {
  if ($(passwordId).value !== $(confirmationId).value) throw new Error(t("passwords_dont_match"));
}

async function initializeAuth() {
  const path = location.pathname;
  const view = path === "/register" ? "register" : path === "/reset-password" ? "reset" : "login";
  for (const name of ["login", "register", "reset"]) $(`${name}-view`).hidden = name !== view;
  document.title = t(`${view}_page_title`);
  for (const name of ["login", "register"]) {
    const tab = $(`${name}-tab`);
    if (name === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  const authTabs = document.querySelector(".auth-tabs");
  if (authTabs) authTabs.hidden = (view === "reset");

  setupPasswordToggles();
  setupPasswordRules($("register-password"), $("register-password-rules"));
  setupPasswordRules($("reset-password"), $("reset-password-rules"));

  const authConfigRequest = api("/api/auth/config");

  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      await api("/api/login", {
        method: "POST",
        data: { username: $("username").value, password: $("password").value },
      });
      $("password").value = "";
      const downloadPath = requestedDownloadPath();
      if (!downloadPath) {
        location.replace("/");
        return;
      }
      notice(t("signed_in_downloading"));
      const link = document.createElement("a");
      link.href = downloadPath;
      link.download = "";
      link.hidden = true;
      document.body.append(link);
      link.click();
      setTimeout(() => location.replace("/"), 500);
    });
  });

  $("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("register-password", "register-password-confirm");
      const result = await api("/api/register", {
        method: "POST",
        data: {
          username: $("register-username").value,
          password: $("register-password").value,
        },
      });
      $("register-form").reset();
      $("register-form").hidden = true;
      $("registration-recovery-code").textContent = result.recoveryCode;
      $("registration-result").hidden = false;
      notice("");
    });
  });
  $("copy-registration-code").addEventListener("click", () => busy($("copy-registration-code"), () =>
    copy($("registration-recovery-code").textContent, $("copy-registration-code"), $("registration-copy-notice"))));

  $("reset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("reset-password", "reset-password-confirm");
      await api("/api/password/reset", {
        method: "POST",
        data: {
          username: $("reset-username").value,
          recoveryCode: $("recovery-code").value,
          newPassword: $("reset-password").value,
        },
      });
      $("reset-form").reset();
      $("reset-form").hidden = true;
      notice(t("password_reset_return"));
    });
  });

  const authConfig = await authConfigRequest;
  $("register-tab").hidden = !authConfig.registrationEnabled;
  if (view === "register" && !authConfig.registrationEnabled) {
    $("register-form").hidden = true;
    $("registration-closed").hidden = false;
  }
}

function temporaryShareActive(item) {
  return Number(item?.share_expires_at) > Math.floor(Date.now() / 1000);
}

function renderTemporaryShare(item, result = null) {
  const expiresAt = result?.expiresAt || item.share_expires_at;
  const active = Number(expiresAt) > Math.floor(Date.now() / 1000);
  $("temporary-share-file").textContent = item.name;
  $("temporary-share-status").textContent = active
    ? t("current_link_expires_at", new Date(expiresAt * 1000).toLocaleString(dateLocale))
    : t("temporary_access_not_active");
  $("temporary-share-actions").hidden = !active && !result;
  $("temporary-share-revoke").hidden = !active;
  $("temporary-share-result").hidden = !result;
  $("temporary-share-copy").hidden = !result;
  $("temporary-share-notice").textContent = "";
  if (!result) {
    $("temporary-share-url").removeAttribute("href");
    $("temporary-share-url").removeAttribute("download");
    $("temporary-share-url").textContent = "";
    $("temporary-share-expiry").textContent = "";
    return;
  }
  $("temporary-share-url").href = result.url;
  $("temporary-share-url").download = item.name;
  $("temporary-share-url").textContent = result.url;
  $("temporary-share-expiry").textContent = t("expires_at", new Date(result.expiresAt * 1000).toLocaleString(dateLocale));
  $("temporary-share-qr").hidden = false;
  QRCode.toCanvas($("temporary-share-qr"), result.url, { width: 200, margin: 2 }).catch((error) => {
    console.error("Temporary file QR generation failed:", error);
    $("temporary-share-qr").hidden = true;
  });
}

function openTemporaryShare(item) {
  temporaryShareItem = item;
  temporaryShareGeneration++;
  $("temporary-share-form").reset();
  renderTemporaryShare(item);
  $("temporary-share-dialog").showModal();
}

function openImagePreview(item, fileUrl) {
  const image = $("image-preview-content");
  const status = $("image-preview-status");
  $("image-preview-name").textContent = item.name;
  $("image-preview-download").href = fileUrl;
  $("image-preview-download").download = item.name;
  image.hidden = true;
  image.alt = item.name;
  status.hidden = false;
  status.textContent = t("loading_image");
  image.onload = () => {
    image.hidden = false;
    status.hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    status.hidden = false;
    status.textContent = t("image_load_failed");
  };
  image.src = `/images/${item.id}/${encodeURIComponent(item.name)}`;
  $("image-preview-dialog").showModal();
}

let currentFilter = "all";

function applyHistoryFilter() {
  const list = $("history-list");
  if (!list) return;
  const rows = list.querySelectorAll(".history-item");
  let visibleCount = 0;
  for (const row of rows) {
    const match = currentFilter === "all" || row.dataset.category === currentFilter;
    row.hidden = !match;
    if (match) visibleCount++;
  }
  let empty = list.querySelector(".empty-filter");
  if (visibleCount === 0 && rows.length > 0) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "empty empty-filter";
      empty.textContent = t("empty_category");
      list.append(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

function historyRow(item) {
  const row = document.createElement("article");
  row.className = "history-item";
  row.dataset.id = item.id;
  row.dataset.category = item.type === "text" ? "text" : item.media_type ? "image" : "file";
  const content = document.createElement("div");
  content.className = "item-content";
  const time = document.createElement("time");
  time.className = "muted";
  time.dateTime = new Date(item.created_at * 1000).toISOString();
  time.textContent = new Date(item.created_at * 1000).toLocaleString(dateLocale);
  const body = document.createElement("p");
  body.className = item.type === "text" ? "item-text" : "item-name";
  if (item.type === "text") appendLinkifiedText(body, item.content);
  else body.textContent = `${item.name} (${size(item.size)})`;
  content.append(time, body);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (item.type === "text") {
    actions.append(actionButton(t("copy_text"), "copy", (button) => copy(item.content, button)));
  } else {
    const fileUrl = new URL(`/uploads/${item.id}/${encodeURIComponent(item.name)}`, location.origin).href;
    const imageUrl = `/images/${item.id}/${encodeURIComponent(item.name)}`;
    if (item.media_type) {
      const thumbnailLink = document.createElement("button");
      thumbnailLink.type = "button";
      thumbnailLink.className = "thumbnail-link";
      thumbnailLink.title = t("preview_image");
      thumbnailLink.setAttribute("aria-label", t("preview_image_aria", item.name));
      thumbnailLink.addEventListener("click", () => openImagePreview(item, fileUrl));
      const thumbnail = document.createElement("img");
      thumbnail.className = "file-thumbnail";
      thumbnail.src = `/previews/${item.id}`;
      thumbnail.alt = t("thumbnail_alt", item.name);
      thumbnail.loading = "lazy";
      thumbnail.decoding = "async";
      thumbnail.addEventListener("load", () => {
        if (thumbnail.naturalWidth >= legacyThumbnailFallbackWidth ||
            item.size > legacyThumbnailFallbackBytes ||
            thumbnail.dataset.originalFallback) return;
        thumbnail.dataset.originalFallback = "true";
        thumbnail.src = imageUrl;
      });
      thumbnail.addEventListener("error", () => thumbnailLink.remove(), { once: true });
      thumbnailLink.append(thumbnail);
      content.insertBefore(thumbnailLink, body);
    }
    const preview = document.createElement("div");
    preview.className = "file-link-preview";
    const link = document.createElement("a");
    link.className = "icon-button";
    link.href = fileUrl;
    link.download = item.name;
    link.title = t("download_file");
    link.setAttribute("aria-label", t("download_file_aria", item.name));
    link.append(icon("download"));
    const qr = document.createElement("div");
    qr.className = "qr-popover file-link-qr";
    const hint = document.createElement("span");
    hint.textContent = t("scan_to_download");
    qr.append(hint);
    preview.append(link, qr);
    let qrStarted = false;
    const renderQr = () => {
      if (qrStarted) return;
      qrStarted = true;
      const canvas = document.createElement("canvas");
      canvas.width = 168;
      canvas.height = 168;
      canvas.setAttribute("aria-label", t("file_qr_aria", item.name));
      qr.prepend(canvas);
      QRCode.toCanvas(canvas, fileUrl, { width: 168, margin: 1 }).catch((error) => {
        console.error("File QR generation failed:", error);
        qr.remove();
      });
    };
    preview.addEventListener("pointerenter", renderQr, { once: true });
    preview.addEventListener("focusin", renderQr, { once: true });
    const temporaryShare = actionButton(
      temporaryShareActive(item) ? t("manage_temporary_link") : t("create_temporary_link"),
      "share-2",
      () => openTemporaryShare(item),
    );
    temporaryShare.classList.toggle("active-share", temporaryShareActive(item));
    if (item.media_type) {
      actions.append(actionButton(t("preview_image_named", item.name), "eye", () => openImagePreview(item, fileUrl)));
    }
    actions.append(preview, actionButton(t("copy_file_link"), "copy", (button) => copy(fileUrl, button)), temporaryShare);
  }
  actions.append(actionButton(t("delete_record"), "trash-2", async () => {
    if (!await confirmDelete(t("delete_record_confirm"))) return;
    await api(`/api/history/${item.id}`, { method: "DELETE" });
    row.remove();
    updateHistorySelection();
    notice(t("deleted"));
    await loadHistory();
  }, true));
  const selection = document.createElement("div");
  selection.className = "item-selection";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "history-select";
  checkbox.setAttribute("aria-label", t("select_item_aria", item.name || item.content));
  checkbox.addEventListener("change", updateHistorySelection);
  selection.append(checkbox, icon(item.type === "text" ? "file-text" : item.media_type ? "image" : "files"));
  row.append(selection, content, actions);
  return row;
}

function updateHistorySelection() {
  const boxes = [...$("history-list").querySelectorAll(".history-item:not([hidden]) .history-select")];
  const count = boxes.filter((box) => box.checked).length;
  $("select-all").disabled = !boxes.length;
  $("select-all").checked = boxes.length > 0 && count === boxes.length;
  $("select-all").indeterminate = count > 0 && count < boxes.length;
  $("history-count").hidden = count > 0;
  $("selection-count").textContent = count ? t("selected_items_count", count) : "";
  const label = count ? t("delete_selected_items_aria", count) : t("clear_history");
  $("clear").title = label;
  $("clear").setAttribute("aria-label", label);
  $("history-count").textContent = String(historyTotal);
}

function historyItemSnapshot(item) {
  return {
    type: item.type,
    content: item.content,
    name: item.name,
    size: item.size,
    mediaType: item.media_type,
    createdAt: item.created_at,
    shareExpiresAt: item.share_expires_at,
  };
}

function sameHistoryItem(snapshot, item) {
  return snapshot.type === item.type &&
    snapshot.content === item.content &&
    snapshot.name === item.name &&
    snapshot.size === item.size &&
    snapshot.mediaType === item.media_type &&
    snapshot.createdAt === item.created_at &&
    snapshot.shareExpiresAt === item.share_expires_at;
}

function cachedHistoryRow(item) {
  const cached = historyRowCache.get(item.id);
  if (cached && sameHistoryItem(cached.item, item)) return cached.row;
  const row = historyRow(item);
  row.querySelector(".history-select").checked = cached?.row.querySelector(".history-select").checked || false;
  historyRowCache.set(item.id, { item: historyItemSnapshot(item), row });
  return row;
}

function pruneHistoryRowCache() {
  const visible = new Set(Array.from($("history-list").querySelectorAll(".history-item"), (row) => row.dataset.id));
  for (const id of historyRowCache.keys()) if (!visible.has(id)) historyRowCache.delete(id);
}

function updateHistoryPagination() {
  $("history-page").textContent = t("pagination_page", historyPage + 1, historyTotalPages);
  $("history-prev").disabled = loading || historyPage === 0;
  $("history-next").disabled = loading || !nextCursor;
}

function renderHistory(data, page = 0) {
  const list = $("history-list");
  if (page === 0) historyCursors = [null];
  historyPage = page;
  historyTotal = data.total;
  historyTotalPages = data.totalPages;
  currentRevision = data.revision;
  const fragment = document.createDocumentFragment();
  for (const item of data.items) fragment.append(cachedHistoryRow(item));
  list.replaceChildren(fragment);
  nextCursor = data.nextCursor;
  historyCursors.length = page + 1;
  if (nextCursor) historyCursors.push(nextCursor);
  if (!data.items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("empty_history");
    list.append(empty);
  }
  applyHistoryFilter();
  updateHistoryPagination();
  updateHistorySelection();
  if (!retainHistoryRows) pruneHistoryRowCache();
  renderIcons();
}

async function loadHistory(page = historyPage) {
  if (sessionEnded) return;
  if (deletingHistory || loading) {
    pendingHistoryPage = page;
    pendingRefresh = true;
    return;
  }
  loading = true;
  updateHistoryPagination();
  try {
    let data;
    do {
      const cursor = historyCursors[page];
      data = await api(`/api/history${cursor ? `?before=${cursor}` : ""}`);
      if (sessionEnded) return;
      if (deletingHistory) {
        pendingRefresh = true;
        return;
      }
      if (data.items.length || page === 0) break;
      page--;
    } while (true);
    renderHistory(data, page);
  } finally {
    loading = false;
    updateHistoryPagination();
    if (pendingRefresh && !sessionEnded && !deletingHistory) {
      pendingRefresh = false;
      const pendingPage = pendingHistoryPage ?? historyPage;
      pendingHistoryPage = null;
      await loadHistory(pendingPage);
    }
  }
}

function visibleHistoryAnchors() {
  const viewportTop = document.querySelector("header")?.getBoundingClientRect().bottom || 0;
  return Array.from($("history-list").querySelectorAll(".history-item")).flatMap((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > viewportTop && bounds.top < innerHeight
      ? [{ id: row.dataset.id, top: bounds.top }]
      : [];
  });
}

async function refreshHistoryPreservingPosition() {
  const anchors = visibleHistoryAnchors();
  retainHistoryRows = true;
  try {
    await loadHistory();
    for (const anchor of anchors) {
      const row = Array.from($("history-list").querySelectorAll(".history-item"))
        .find((item) => item.dataset.id === anchor.id);
      if (!row) continue;
      scrollBy(0, row.getBoundingClientRect().top - anchor.top);
      break;
    }
  } finally {
    retainHistoryRows = false;
    pruneHistoryRowCache();
  }
}

function schedulePoll(delaySeconds = session?.pollSeconds) {
  clearTimeout(pollTimer);
  if (pollingStopped || !session || document.hidden) return;
  pollTimer = setTimeout(() => { void checkForHistoryUpdates(); }, delaySeconds * 1000);
}

async function checkForHistoryUpdates() {
  clearTimeout(pollTimer);
  if (pollingStopped || !session || document.hidden || revisionCheckRunning) return;
  if (uploading || loading || deletingHistory) {
    schedulePoll();
    return;
  }
  revisionCheckRunning = true;
  let updated = false;
  try {
    const state = await api("/api/revision");
    if (state.revision !== currentRevision) {
      await refreshHistoryPreservingPosition();
      updated = true;
    }
    if (!deletingHistory) {
      if (updated) notice(t("history_updated"));
      else if (pollFailureCount) notice(t("sync_restored"));
    }
    pollFailureCount = 0;
  } catch (error) {
    if (!sessionEnded) {
      pollFailureCount++;
      report(error);
    }
  } finally {
    revisionCheckRunning = false;
    const exponent = Math.max(0, Math.min(pollFailureCount - 1, 10));
    const delay = pollFailureCount
      ? Math.min(session?.pollSeconds * (2 ** exponent), maxPollRetrySeconds)
      : session?.pollSeconds;
    schedulePoll(delay);
  }
}

function savedUploads() {
  try {
    const records = JSON.parse(localStorage.getItem(uploadStorageKey()) || "[]");
    const oldest = Date.now() - 7 * 86400 * 1000;
    return Array.isArray(records) ? records.filter((record) =>
      typeof record.key === "string" && typeof record.name === "string" &&
      Number.isSafeInteger(record.size) && Number.isSafeInteger(record.lastModified) &&
      Number(record.updatedAt) >= oldest) : [];
  } catch {
    return [];
  }
}

function saveUpload(entry) {
  try {
    const records = savedUploads().filter((record) => record.key !== entry.key);
    records.push({
      key: entry.key,
      id: entry.id || null,
      name: entry.file.name,
      size: entry.file.size,
      lastModified: entry.file.lastModified,
      chunkSize: entry.chunkSize || null,
      fileFingerprint: entry.fileFingerprint || null,
      updatedAt: Date.now(),
    });
    localStorage.setItem(uploadStorageKey(), JSON.stringify(records));
  } catch {
    // Upload still resumes within this page when persistent browser storage is unavailable.
  }
}

function forgetUpload(key) {
  try {
    localStorage.setItem(uploadStorageKey(), JSON.stringify(savedUploads().filter((record) => record.key !== key)));
  } catch {
    // Expired server-side upload state is cleaned independently.
  }
}

function uploadButton(name, label, disabled = false) {
  const button = $("upload");
  button.replaceChildren(icon(name), label);
  button.disabled = disabled;
  renderIcons();
}

function updateUploadControls() {
  const pending = uploadQueue.some((entry) => !entry.done);
  if (uploading) {
    uploadButton("pause", pauseRequested ? t("pausing") : t("pause_upload"), pauseRequested);
  } else {
    uploadButton("play", t("resume_upload"), !pending);
  }
  $("upload").hidden = !uploading && !pending;
  $("file-count").textContent = uploadQueue.length ? t("files_count", uploadQueue.length) : "";
  $("file-input").disabled = uploading;
  $("clear").disabled = uploading || !session;
}

function makeUploadRow(file, saved) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "upload-row";
  const name = document.createElement("span");
  name.className = "upload-name";
  name.textContent = `${file.name} (${size(file.size)})`;
  const state = document.createElement("span");
  state.className = "muted";
  state.textContent = saved ? t("resumable") : t("waiting_upload");
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute("aria-label", t("upload_progress_aria", file.name));
  row.append(name, state);
  li.append(row, progress);
  $("upload-list").append(li);
  const entry = {
    file,
    state,
    progress,
    done: false,
    key: saved?.key || crypto.randomUUID(),
    id: saved?.id || null,
    chunkSize: saved?.chunkSize || null,
    fileFingerprint: saved?.fileFingerprint || null,
    partChecksums: new Map(),
    completed: new Map(),
    inFlight: new Map(),
  };
  saveUpload(entry);
  return entry;
}

function clipboardFiles(data) {
  if (!data) return [];
  const itemFiles = Array.from(data.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const files = itemFiles.length ? itemFiles : Array.from(data.files || []);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return files.map((file, index) => {
    if (file.name?.trim()) return file;
    const mediaType = file.type.toLowerCase();
    const extension = clipboardImageExtensions.get(mediaType);
    const prefix = extension ? "pasted-image" : "pasted-file";
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `${prefix}-${stamp}${suffix}${extension ? `.${extension}` : ""}`, {
      type: file.type,
      lastModified: file.lastModified || Date.now(),
    });
  });
}

async function partChecksum(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createImagePreview(file) {
  if (!previewSourceTypes.has(file.type.toLowerCase()) && !previewSourceExtension.test(file.name)) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    if (!bitmap.width || !bitmap.height) return null;
    const scale = Math.min(1, previewMaxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    return preview?.type === "image/webp" && preview.size <= previewMaxBytes ? preview : null;
  } catch (error) {
    console.warn(`Thumbnail generation skipped for ${file.name}:`, error);
    return null;
  } finally {
    bitmap?.close();
  }
}

async function uploadImagePreview(entry, preview) {
  return api(`/api/uploads/${entry.id}/preview`, {
    method: "PUT",
    payload: preview,
    contentType: "image/webp",
  });
}

async function prepareFile(entry) {
  const chunkSize = session.uploadChunkBytes;
  const totalParts = Math.ceil(entry.file.size / chunkSize);
  const checksums = [];
  for (let index = 0; index < totalParts; index++) {
    if (pauseRequested) throw new UploadPaused("Upload paused.");
    entry.state.textContent = t("verifying_file", index + 1, totalParts);
    checksums.push(await partChecksum(entry.file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, entry.file.size))));
  }
  const manifest = JSON.stringify(["multipart-file-v1", entry.file.size, chunkSize, checksums]);
  const fileFingerprint = await partChecksum(new Blob([manifest]));
  if (entry.fileFingerprint && (entry.fileFingerprint !== fileFingerprint || entry.chunkSize !== chunkSize)) {
    forgetUpload(entry.key);
    entry.key = crypto.randomUUID();
    entry.id = null;
  }
  entry.chunkSize = chunkSize;
  entry.fileFingerprint = fileFingerprint;
  entry.partChecksums = new Map(checksums.map((checksum, index) => [index + 1, checksum]));
  saveUpload(entry);
  return { chunkSize, fileFingerprint };
}

function updateUploadProgress(entry) {
  if (entry.file.size === 0) {
    entry.progress.value = entry.done ? 100 : 0;
    return;
  }
  const completed = Array.from(entry.completed.values()).reduce((total, bytes) => total + bytes, 0);
  const inFlight = Array.from(entry.inFlight.values()).reduce((total, bytes) => total + bytes, 0);
  entry.progress.value = Math.min(100, Math.round((completed + inFlight) / entry.file.size * 100));
}

function uploadPart(entry, partNumber, blob, checksum) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUploads.add(xhr);
    const path = `/api/uploads/${entry.id}/parts/${partNumber}`;
    xhr.open("PUT", path);
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Part-SHA256", checksum);
    xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      entry.inFlight.set(partNumber, event.loaded);
      updateUploadProgress(entry);
    };
    xhr.onloadend = () => {
      activeUploads.delete(xhr);
      entry.inFlight.delete(partNumber);
      updateUploadProgress(entry);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(apiError("PUT", path, xhr.status, xhr.responseText));
      try {
        if (!JSON.parse(xhr.responseText).success) throw new Error();
      } catch { return reject(apiError("PUT", path, xhr.status, xhr.responseText)); }
      entry.inFlight.delete(partNumber);
      entry.completed.set(partNumber, blob.size);
      updateUploadProgress(entry);
      resolve();
    };
    xhr.onerror = () => reject(new Error(`PUT ${path}: ${t("network_error", entry.file.name)}`));
    xhr.ontimeout = () => reject(new Error(`PUT ${path}: ${t("chunk_timeout", entry.file.name)}`));
    xhr.onabort = () => reject(pauseRequested ? new UploadPaused("Upload paused.") : new Error(`PUT ${path}: ${t("upload_aborted", entry.file.name)}`));
    xhr.send(blob);
  });
}

async function uploadFile(entry) {
  saveUpload(entry);
  const previewPromise = createImagePreview(entry.file);
  const prepared = await prepareFile(entry);
  entry.state.textContent = entry.id ? t("checking_resume_point") : t("initializing");
  const upload = await api("/api/uploads", {
    method: "POST",
    data: {
      name: entry.file.name,
      size: entry.file.size,
      mediaType: entry.file.type,
      chunkSize: prepared.chunkSize,
      fileFingerprint: prepared.fileFingerprint,
    },
    operationKey: entry.key,
  });
  entry.id = upload.id;
  saveUpload(entry);
  const previewUpload = previewPromise.then(async (preview) => {
    if (preview) await uploadImagePreview(entry, preview);
  }).catch((error) => {
    entry.previewFailed = true;
    console.error("Image preview upload failed:", error.details || error);
  });
  if (upload.complete) {
    await previewUpload;
    if (sessionEnded) throw new Error(t("session_ended"));
    entry.done = true;
    entry.progress.value = 100;
    entry.state.textContent = entry.previewFailed ? t("uploaded_no_thumbnail") : t("uploaded");
    forgetUpload(entry.key);
    return;
  }
  if (upload.chunkSize !== prepared.chunkSize) throw new Error(t("server_chunk_config_changed"));

  const remote = new Map(upload.uploadedParts.map((part) => [part.partNumber, part]));
  entry.completed.clear();
  entry.inFlight.clear();
  let cursor = 1;
  let firstError;

  const processPart = async (partNumber) => {
    const start = (partNumber - 1) * upload.chunkSize;
    const end = Math.min(start + upload.chunkSize, entry.file.size);
    const blob = entry.file.slice(start, end);
    const checksum = entry.partChecksums.get(partNumber);
    const stored = remote.get(partNumber);
    if (stored?.size === blob.size && stored.sha256 === checksum) {
      entry.completed.set(partNumber, blob.size);
      updateUploadProgress(entry);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (pauseRequested) throw new UploadPaused("Upload paused.");
      entry.state.textContent = attempt === 1
        ? t("uploading_chunk", partNumber, upload.totalParts)
        : t("retrying_chunk", partNumber, upload.totalParts, attempt);
      try {
        await uploadPart(entry, partNumber, blob, checksum);
        return;
      } catch (error) {
        const retryable = !error.status || error.status === 429 || error.status >= 500;
        if (error instanceof UploadPaused || sessionEnded || !retryable || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  };

  const worker = async () => {
    while (!pauseRequested && !firstError) {
      const partNumber = cursor++;
      if (partNumber > upload.totalParts) return;
      try {
        await processPart(partNumber);
      } catch (error) {
        firstError ||= error;
      }
    }
  };
  const concurrency = Math.min(upload.uploadConcurrency || session.uploadConcurrency || 1, upload.totalParts);
  await Promise.all([...Array.from({ length: concurrency }, worker), previewUpload]);
  if (sessionEnded) throw new Error(t("session_ended"));
  if (firstError) throw firstError;
  if (pauseRequested) throw new UploadPaused("Upload paused.");

  if (upload.totalParts > 1) entry.state.textContent = t("merging");
  await api(`/api/uploads/${entry.id}/complete`, { method: "POST" });
  entry.done = true;
  entry.progress.value = 100;
  entry.state.textContent = entry.previewFailed ? t("uploaded_no_thumbnail") : t("uploaded");
  forgetUpload(entry.key);
}

async function startUpload() {
  if (uploading || !session) return;
  uploading = true;
  pauseRequested = false;
  updateUploadControls();
  let failures = 0;
  let paused = false;
  const errors = [];
  try {
    const pending = uploadQueue.filter((item) => !item.done);
    let cursor = 0;
    const worker = async () => {
      while (!pauseRequested && session) {
        const entry = pending[cursor++];
        if (!entry) return;
        try {
          if (entry.file.size > session.maxUploadBytes) throw new Error(t("file_exceeds_limit", entry.file.name));
          await uploadFile(entry);
          void loadHistory(0).catch(report);
          setTimeout(() => {
            entry.progress.closest("li").remove();
            uploadQueue = uploadQueue.filter((item) => item !== entry);
            updateUploadControls();
          }, 8000);
        } catch (error) {
          if (error instanceof UploadPaused) {
            entry.state.textContent = t("paused");
            paused = true;
            return;
          }
          failures++;
          entry.state.textContent = t("failed");
          errors.push(error.details || error.message);
        }
      }
    };
    const concurrency = Math.min(
      session.uploadFileConcurrency || 1,
      pending.length,
    );
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (pauseRequested) paused = true;
    if (failures) {
      const error = new Error(t("files_failed_to_upload", failures));
      error.details = errors.join("\n\n");
      report(error);
    } else if (paused && session) notice(t("upload_paused"));
    else if (session) notice(t("upload_complete"), false, 8000);
    if (session) await loadHistory();
  } catch (error) {
    report(error);
  } finally {
    uploading = false;
    pauseRequested = false;
    updateUploadControls();
    if (uploadQueue.every((item) => item.done)) $("file-input").value = "";
  }
}

function pauseUpload() {
  if (!uploading || pauseRequested) return;
  pauseRequested = true;
  updateUploadControls();
  for (const xhr of activeUploads) xhr.abort();
}

function updateDeleteAccountVisibility() {
  const canDelete = session?.user?.role !== "admin" || Boolean(session?.user?.canDeleteAccount);
  if ($("account-danger")) $("account-danger").hidden = !canDelete;
  if ($("delete-account-open")) $("delete-account-open").hidden = !canDelete;
}

async function initializeApp() {
  const bootstrap = await api("/api/bootstrap");
  session = bootstrap.session;
  setupPasswordToggles();
  updateDeleteAccountVisibility();
  $("account-tabs").hidden = session.user.role !== "admin";
  const profileTab = $("tab-profile");
  const usersTab = $("tab-users");
  const profilePanel = $("account-profile-panel");
  const usersPanel = $("account-users-panel");

  const setAccountTab = (tab) => {
    profileTab.classList.toggle("active", tab === "profile");
    usersTab.classList.toggle("active", tab === "users");
    profileTab.setAttribute("aria-pressed", String(tab === "profile"));
    usersTab.setAttribute("aria-pressed", String(tab === "users"));
    profilePanel.hidden = tab !== "profile";
    usersPanel.hidden = tab !== "users";
    if (tab === "users") {
      resetUserForm();
      loadUsers().catch(report);
    }
  };
  profileTab.addEventListener("click", () => setAccountTab("profile"));
  usersTab.addEventListener("click", () => setAccountTab("users"));

  $("upload-limit").textContent = t("upload_limit", size(session.maxUploadBytes));
  const updateCount = () => {
    const bytes = new TextEncoder().encode($("text-input").value).length;
    $("text-count").textContent = `${size(bytes)} / ${size(session.maxTextBytes)}`;
    $("text-form").querySelector("button").disabled = textSubmitting || !$("text-input").value.trim() || bytes > session.maxTextBytes;
  };
  $("text-input").addEventListener("input", updateCount);
  $("text-input").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      const submitBtn = $("text-form").querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.disabled) {
        $("text-form").requestSubmit();
      }
    }
  });
  updateCount();
  $("refresh").disabled = false;
  $("clear").disabled = false;
  updateUploadControls();

  const enqueueFiles = (files) => {
    if (!files || !files.length || uploading) return false;
    $("upload-list").replaceChildren();
    const records = savedUploads();
    const used = new Set();
    uploadQueue = Array.from(files).map((file) => {
      const saved = records.find((record) =>
        !used.has(record.key) && record.name === file.name && record.size === file.size &&
        record.lastModified === file.lastModified);
      if (saved) used.add(saved.key);
      return makeUploadRow(file, saved);
    });
    updateUploadControls();
    if (uploadQueue.length) void startUpload();
    return uploadQueue.length > 0;
  };

  $("text-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (textSubmitting || !session) return;
    textSubmitting = true;
    const button = $("text-form").querySelector("button");
    await busy(button, async () => {
      const text = $("text-input").value;
      if (!textOperation || textOperation.text !== text) textOperation = { text, key: crypto.randomUUID() };
      await api("/api/text", { method: "POST", data: { text }, operationKey: textOperation.key });
      textOperation = null;
      if ($("text-input").value === text) $("text-input").value = "";
      notice(t("shared"));
      await loadHistory(0);
    });
    textSubmitting = false;
    if (session) updateCount();
  });
  $("file-input").addEventListener("change", () => enqueueFiles($("file-input").files));

  const dragOverlay = $("drag-overlay");
  let dragCounter = 0;
  window.addEventListener("dragenter", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounter++;
      dragOverlay.hidden = false;
    }
  });
  window.addEventListener("dragleave", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.hidden = true;
      }
    }
  });
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  });
  window.addEventListener("drop", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dragCounter = 0;
      dragOverlay.hidden = true;
      if (e.dataTransfer.files?.length) {
        enqueueFiles(e.dataTransfer.files);
      }
    }
  });

  window.addEventListener("paste", (e) => {
    const target = e.target;
    const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (document.querySelector("dialog[open]")) return;
    const files = clipboardFiles(e.clipboardData);
    if (files.length && !uploading) {
      e.preventDefault();
      if (enqueueFiles(files)) notice(t("added_files_from_clipboard", files.length));
      return;
    }
    const inCompose = target === document.body || target?.closest?.(".compose");
    if (isInput || !inCompose) return;
    if (e.clipboardData?.types?.includes("text/plain")) {
      const text = e.clipboardData.getData("text/plain");
      if (text && text.trim()) {
        e.preventDefault();
        const input = $("text-input");
        input.value = (input.value ? input.value + "\n" : "") + text;
        updateCount();
        input.focus();
        notice(t("pasted_clipboard_text"));
      }
    }
  });

  for (const btn of document.querySelectorAll(".history-filter-btn")) {
    btn.addEventListener("click", () => {
      for (const b of document.querySelectorAll(".history-filter-btn")) {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      }
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      currentFilter = btn.dataset.filter || "all";
      for (const box of $("history-list").querySelectorAll(".history-select")) box.checked = false;
      applyHistoryFilter();
      updateHistorySelection();
    });
  }

  $("upload").addEventListener("click", () => uploading ? pauseUpload() : startUpload());
  $("refresh").addEventListener("click", () => busy($("refresh"), async () => {
    await loadHistory();
    notice(t("refreshed"));
    pollingStopped = false;
    pollFailureCount = 0;
    schedulePoll();
  }));
  $("history-prev").addEventListener("click", () => loadHistory(historyPage - 1).catch(report));
  $("history-next").addEventListener("click", () => loadHistory(historyPage + 1).catch(report));
  $("select-all").addEventListener("change", () => {
    for (const box of $("history-list").querySelectorAll(".history-item:not([hidden]) .history-select")) box.checked = $("select-all").checked;
    updateHistorySelection();
  });
  $("clear").addEventListener("click", () => busy($("clear"), async () => {
    if (uploading) return;
    const rows = [...$("history-list").querySelectorAll(".history-item")]
      .filter((row) => !row.hidden && row.querySelector(".history-select").checked);
    if (!await confirmDelete(rows.length ? t("delete_selected_confirm", rows.length) : t("clear_all_confirm"))) return;
    const removed = [];
    deletingHistory = true;
    document.querySelector(".history").inert = true;
    for (const row of rows) row.hidden = true;
    notice(t("deleting"), false, 0);
    try {
      if (rows.length) {
        for (const row of rows) {
          await api(`/api/history/${row.dataset.id}`, { method: "DELETE" });
          removed.push(row);
        }
      } else {
        await api("/api/clear_history", { method: "POST" });
        $("history-list").replaceChildren();
        historyRowCache.clear();
        updateHistorySelection();
      }
      notice(rows.length ? t("deleted_items", rows.length) : t("cleared"));
    } finally {
      for (const row of removed) {
        row.remove();
        historyRowCache.delete(row.dataset.id);
      }
      for (const row of rows) row.hidden = false;
      deletingHistory = false;
      document.querySelector(".history").inert = false;
      updateHistorySelection();
      pendingRefresh = false;
      await refreshHistoryPreservingPosition();
    }
  }));
  $("logout").addEventListener("click", () => busy($("logout"), async () => {
    await api("/api/logout", { method: "POST" });
    expireSession();
  }));
  $("account-open").addEventListener("click", () => {
    setAccountTab("profile");
    updateDeleteAccountVisibility();
    $("password-form").reset();
    $("recovery-form").reset();
    $("account-recovery-result").hidden = true;
    $("account-recovery-code").textContent = "";
    $("account-recovery-notice").textContent = "";
    const username = session.user.username || "";
    $("account-username").textContent = username;
    if ($("account-avatar")) $("account-avatar").textContent = username.charAt(0).toUpperCase() || "U";
    if ($("account-role-badge")) {
      const isAdmin = session.user.role === "admin";
      $("account-role-badge").textContent = isAdmin ? t("admin_user") : t("regular_user");
      $("account-role-badge").className = `badge ${isAdmin ? "badge-admin" : "badge-user"}`;
    }
    $("recovery-status").textContent = session.user.hasRecoveryCode
      ? t("recovery_code_set")
      : t("recovery_code_not_set");
    $("recovery-submit-label").textContent = session.user.hasRecoveryCode ? t("regenerate_recovery_code") : t("generate_recovery_code");
    $("account-dialog").showModal();
  });
  $("account-close").addEventListener("click", () => $("account-dialog").close());
  $("password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("new-password", "new-password-confirm");
      await api("/api/account/password", {
        method: "POST",
        data: {
          currentPassword: $("current-password").value,
          newPassword: $("new-password").value,
        },
      });
      expireSession();
    });
  });
  $("recovery-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const result = await api("/api/account/recovery-code", {
        method: "POST",
        data: { currentPassword: $("recovery-current-password").value },
      });
      $("recovery-form").reset();
      $("account-recovery-code").textContent = result.recoveryCode;
      $("account-recovery-result").hidden = false;
      $("recovery-status").textContent = t("recovery_code_updated");
      $("recovery-submit-label").textContent = t("regenerate_recovery_code");
      session.user.hasRecoveryCode = true;
    });
  });
  $("copy-account-recovery").addEventListener("click", () => busy($("copy-account-recovery"), () =>
    copy($("account-recovery-code").textContent, $("copy-account-recovery"), $("account-recovery-notice"))));
  $("delete-account-open").addEventListener("click", () => {
    $("delete-account-form").reset();
    $("account-dialog").close();
    $("delete-account-dialog").showModal();
  });
  $("delete-account-close").addEventListener("click", () => $("delete-account-dialog").close());
  $("delete-account-cancel").addEventListener("click", () => $("delete-account-dialog").close());
  $("delete-account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      await api("/api/account", {
        method: "DELETE",
        data: {
          username: $("delete-account-username").value,
          currentPassword: $("delete-account-password").value,
        },
      });
      expireSession();
    });
  });
  $("site-url-preview").textContent = location.origin;
  QRCode.toCanvas($("site-qr-preview"), location.origin, { width: 168, margin: 1 }).catch((error) => {
    console.error("Site QR preview generation failed:", error);
    $("site-link-popover").remove();
  });
  $("qr-open").addEventListener("click", () => busy($("qr-open"), async () => {
    $("site-url").textContent = location.origin;
    $("site-copy-notice").textContent = "";
    await QRCode.toCanvas($("qr-canvas"), location.origin, { width: 200, margin: 2 });
    $("qr-dialog").showModal();
  }));
  $("qr-close").addEventListener("click", () => $("qr-dialog").close());
  $("copy-url").addEventListener("click", () => busy($("copy-url"), () =>
    copy(location.origin, $("copy-url"), $("site-copy-notice"))));
  const imagePreviewDialog = $("image-preview-dialog");
  $("image-preview-close").addEventListener("click", () => imagePreviewDialog.close());
  imagePreviewDialog.addEventListener("click", (event) => {
    if (event.target === imagePreviewDialog) imagePreviewDialog.close();
  });
  imagePreviewDialog.addEventListener("close", () => {
    const image = $("image-preview-content");
    image.removeAttribute("src");
    image.onload = null;
    image.onerror = null;
  });
  const temporaryShareDialog = $("temporary-share-dialog");
  $("temporary-share-close").addEventListener("click", () => temporaryShareDialog.close());
  temporaryShareDialog.addEventListener("close", () => {
    temporaryShareGeneration++;
    temporaryShareItem = undefined;
  });
  $("temporary-share-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      if (!temporaryShareItem) return;
      const item = temporaryShareItem;
      const generation = temporaryShareGeneration;
      const result = await api(`/api/history/${item.id}/share`, {
        method: "POST",
        data: { hours: Number($("temporary-share-hours").value) },
      });
      if (generation !== temporaryShareGeneration || temporaryShareItem?.id !== item.id) {
        await loadHistory();
        return;
      }
      item.share_expires_at = result.expiresAt;
      renderTemporaryShare(item, result);
      notice(t("temporary_link_created"));
      await loadHistory();
    });
  });
  $("temporary-share-copy").addEventListener("click", () => busy($("temporary-share-copy"), () =>
    copy($("temporary-share-url").href, $("temporary-share-copy"), $("temporary-share-notice"))));
  $("temporary-share-revoke").addEventListener("click", () => busy($("temporary-share-revoke"), async () => {
    if (!temporaryShareItem) return;
    const item = temporaryShareItem;
    const generation = temporaryShareGeneration;
    await api(`/api/history/${item.id}/share`, { method: "DELETE" });
    if (generation !== temporaryShareGeneration || temporaryShareItem?.id !== item.id) {
      await loadHistory();
      return;
    }
    item.share_expires_at = null;
    renderTemporaryShare(item);
    notice(t("temporary_link_revoked"));
    await loadHistory();
  }));
  $("registration-enabled").addEventListener("change", async () => {
    const input = $("registration-enabled");
    const enabled = input.checked;
    input.disabled = true;
    try {
      await api("/api/settings/registration", { method: "PATCH", data: { enabled } });
      notice(enabled ? t("registration_enabled_notice") : t("registration_disabled_notice"));
    } catch (error) {
      input.checked = !enabled;
      report(error);
    } finally {
      input.disabled = false;
    }
  });
  $("user-cancel").addEventListener("click", resetUserForm);
  $("user-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const id = $("user-id").value;
      const data = {
        username: $("user-name").value,
        role: $("user-role").value,
        enabled: $("user-enabled").checked,
      };
      if ($("user-password").value) data.password = $("user-password").value;
      const result = await api(id ? `/api/users/${id}` : "/api/users", {
        method: id ? "PATCH" : "POST",
        data,
      });
      if (result.signedOut) {
        expireSession();
        return;
      }
      resetUserForm();
      await loadUsers();
      notice(id ? t("user_updated_signout") : t("user_added"));
    });
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
  const pollWhenActive = () => {
    if (!document.hidden) void checkForHistoryUpdates();
  };
  document.addEventListener("visibilitychange", pollWhenActive);
  window.addEventListener("focus", pollWhenActive);
  window.addEventListener("online", pollWhenActive);
  window.addEventListener("beforeunload", (event) => {
    if (uploading || textSubmitting) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  renderHistory(bootstrap.history);
  notice("");
  schedulePoll();
}

renderIcons();
if (isLogin) initializeAuth().catch(report);
else initializeApp().catch(report);
