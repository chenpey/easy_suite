import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_TARGET_TTL_MS,
  canReceiveShare,
  composeSharedText,
  createPendingShare,
  inspectPendingShare,
  parseShareFormData,
} from "../web/share-target.js";

const target = { method: "POST", sameOrigin: true, pathname: "/share-target", mode: "navigate" };

function shareForm(fields = {}, files = []) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append("files", file);
  return form;
}

test("canReceiveShare accepts only same-origin target POST navigations", () => {
  assert.equal(canReceiveShare(target), true);
  for (const [name, value] of Object.entries({
    method: "GET",
    sameOrigin: false,
    pathname: "/share-target-fallback.html",
    mode: "no-cors",
    mode2: "cors",
  })) {
    const overrides = name === "mode2" ? { mode: value } : { [name]: value };
    assert.equal(canReceiveShare({ ...target, ...overrides }), false, `${name}=${value} must be rejected`);
  }
  assert.equal(canReceiveShare({ method: "POST", sameOrigin: true, pathname: "/share-target" }), false);
});

test("parseShareFormData preserves title text and URL composition", () => {
  const cases = [
    [{ title: "A title", text: "body", url: "https://example.test/path" }, "A title\nbody\nhttps://example.test/path"],
    [{ text: "  padded line\nsecond  ", url: "https://example.test" }, "  padded line\nsecond  \nhttps://example.test"],
    [{ title: "only title" }, "only title"],
    [{ url: "https://example.test" }, "https://example.test"],
    [{ title: "   ", text: "\n\t", url: "" }, null],
    [{}, null],
  ];
  for (const [fields, expected] of cases) {
    const parsed = parseShareFormData(shareForm(fields));
    if (expected === null) {
      assert.equal(parsed, null, JSON.stringify(fields));
    } else {
      assert.equal(composeSharedText(parsed), expected, JSON.stringify(fields));
      assert.deepEqual(parsed.files, []);
    }
  }
  assert.equal(composeSharedText({ title: "same", text: "same", url: "" }), "same\nsame");
  assert.equal(composeSharedText({ title: "", text: "body", url: "body" }), "body\nbody");
  const duplicate = shareForm({ title: "first" });
  duplicate.append("title", "second");
  duplicate.append("unknown", "ignored");
  const duplicateFields = parseShareFormData(duplicate);
  assert.equal(duplicateFields.title, "first");
  assert.equal(composeSharedText(duplicateFields), "first");
});

test("parseShareFormData retains every file in field order", () => {
  const zeroByte = new File([], "empty.txt", { type: "text/plain", lastModified: 111 });
  const binary = new File([new Uint8Array([1, 2, 3])], "blob.bin", { type: "", lastModified: 222 });
  const parsed = parseShareFormData(shareForm({ text: "with files" }, [zeroByte, binary]));
  assert.equal(parsed.text, "with files");
  assert.equal(parsed.files.length, 2);
  assert.deepEqual(parsed.files.map((file) => file.name), ["empty.txt", "blob.bin"]);
  assert.deepEqual(parsed.files.map((file) => file.type), ["text/plain", ""]);
  assert.deepEqual(parsed.files.map((file) => file.lastModified), [111, 222]);

  const unknownTimestamp = parseShareFormData({
    get: (name) => (name === "text" ? "fake" : null),
    getAll: () => [{ name: "fake.txt", type: "text/plain", size: 3, lastModified: Number.NaN, slice() {} }],
  });
  assert.deepEqual(unknownTimestamp.files.map((file) => file.lastModified), [0]);

  const placeholder = parseShareFormData(shareForm({}, [new File([], "")]));
  assert.equal(placeholder, null);
  const unreadableName = parseShareFormData(shareForm({}, [new File(["x"], "")]));
  assert.equal(unreadableName.files.length, 1);
  assert.equal(unreadableName.files[0].name, "");

  assert.equal(parseShareFormData(shareForm({ files: "not a file" })), null);
  assert.equal(parseShareFormData(shareForm({ text: new File(["x"], "text.txt") })), null);
});

test("createPendingShare computes ten-minute expiry without provenance fields", () => {
  const now = 1700000000000;
  const record = createPendingShare({
    title: "t",
    text: "body",
    url: "https://example.test",
    files: [],
  }, now);
  assert.deepEqual(Object.keys(record).sort(), ["createdAt", "expiresAt", "files", "state", "text", "title", "url"]);
  assert.equal(record.state, "pending");
  assert.equal(record.createdAt, now);
  assert.equal(record.expiresAt, now + SHARE_TARGET_TTL_MS);
  assert.equal(SHARE_TARGET_TTL_MS, 600000);
  assert.equal(record.title, "t");
  assert.equal(record.text, "body");
  assert.equal(record.url, "https://example.test");
});

test("inspectPendingShare handles state and expiry boundaries", () => {
  const now = 1700000000000;
  const pending = createPendingShare({ title: "", text: "body", url: "", files: [] }, now);
  assert.deepEqual(inspectPendingShare(undefined, now), { status: "empty" });
  assert.equal(inspectPendingShare(pending, now + SHARE_TARGET_TTL_MS - 1).status, "ready");
  assert.equal(inspectPendingShare(pending, now + SHARE_TARGET_TTL_MS).status, "expired");
  assert.equal(inspectPendingShare(pending, now + SHARE_TARGET_TTL_MS + 1).status, "expired");
  assert.equal(inspectPendingShare({ ...pending, state: "consumed" }, now).status, "invalid");
  assert.equal(inspectPendingShare({ ...pending, text: 42 }, now).status, "invalid");
  assert.equal(inspectPendingShare({ ...pending, files: "nope" }, now).status, "invalid");
  assert.equal(inspectPendingShare({ ...pending, expiresAt: "later" }, now).status, "invalid");
  assert.equal(inspectPendingShare({ ...pending, state: "expired", notified: false }, now).status, "expired");
  assert.equal(inspectPendingShare({ ...pending, state: "expired", notified: true }, now).status, "silent");
  const expired = inspectPendingShare(pending, now + SHARE_TARGET_TTL_MS);
  assert.equal(expired.text, undefined);
  assert.equal(expired.files, undefined);
  const empty = createPendingShare({ title: "", text: "   ", url: "", files: [] }, now);
  assert.equal(inspectPendingShare(empty, now).status, "invalid");
});
