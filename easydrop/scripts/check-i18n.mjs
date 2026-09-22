#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { zh, en } from "../web/i18n.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let hasErrors = false;

function error(msg) {
  console.error(`\x1b[31m[i18n check error]\x1b[0m ${msg}`);
  hasErrors = true;
}

// 1. Check zh <-> en symmetry
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

for (const key of zhKeys) {
  if (!enKeys.has(key)) {
    error(`Key "${key}" exists in "zh" but is missing in "en".`);
  }
}

for (const key of enKeys) {
  if (!zhKeys.has(key)) {
    error(`Key "${key}" exists in "en" but is missing in "zh".`);
  }
}

// 2. Check HTML files
const htmlFiles = ["web/index.html", "web/login.html"];
const i18nAttrRegex = /data-i18n(?:-[a-z-]+)?="([^"]+)"/g;

for (const relPath of htmlFiles) {
  const fullPath = resolve(root, relPath);
  const content = await readFile(fullPath, "utf8");
  let match;
  while ((match = i18nAttrRegex.exec(content)) !== null) {
    const key = match[1];
    if (!zhKeys.has(key)) {
      error(`Missing translation key "${key}" referenced in ${relPath}.`);
    }
  }
}

// 3. Check JS files for t('key') calls
const jsFiles = ["web/app.js"];
const tCallRegex = /\bt\(\s*["']([^"']+)["']/g;

for (const relPath of jsFiles) {
  const fullPath = resolve(root, relPath);
  const content = await readFile(fullPath, "utf8");
  let match;
  while ((match = tCallRegex.exec(content)) !== null) {
    const key = match[1];
    if (!zhKeys.has(key)) {
      error(`Missing translation key "${key}" called via t() in ${relPath}.`);
    }
  }
}

if (hasErrors) {
  console.error("\x1b[31mEasyDrop i18n key alignment check failed.\x1b[0m");
  process.exit(1);
} else {
  console.log(`\x1b[32mEasyDrop i18n check passed: ${zhKeys.size} keys aligned across zh/en, HTML, and JS.\x1b[0m`);
}
