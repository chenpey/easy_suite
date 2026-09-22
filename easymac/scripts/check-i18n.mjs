#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const i18nPath = resolve(projectRoot, "web/i18n.js");
const htmlPath = resolve(projectRoot, "web/index.html");
const appPath = resolve(projectRoot, "web/app.js");

async function loadI18n() {
  const code = await readFile(i18nPath, "utf8");
  const sandbox = { module: { exports: {} }, exports: {}, globalThis: {} };
  sandbox.window = sandbox;
  sandbox.localStorage = { getItem: () => null, setItem: () => {} };
  sandbox.document = {
    documentElement: { lang: "zh-CN" },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.translations || sandbox.window.EasyMacI18n?.translations;
}

async function main() {
  const translations = await loadI18n();
  if (!translations || !translations.zh || !translations.en) {
    console.error("Failed to load EasyMac translations from web/i18n.js");
    process.exit(1);
  }

  const zhKeys = new Set(Object.keys(translations.zh));
  const enKeys = new Set(Object.keys(translations.en));

  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

  let hasErrors = false;

  if (missingInEn.length > 0) {
    console.error("Keys present in zh but missing in en:", missingInEn);
    hasErrors = true;
  }
  if (missingInZh.length > 0) {
    console.error("Keys present in en but missing in zh:", missingInZh);
    hasErrors = true;
  }

  const htmlContent = await readFile(htmlPath, "utf8");
  const htmlKeyRegex = /data-i18n(?:-[a-z-]+)?="([^"]+)"/g;
  let match;
  const usedInHtml = new Set();
  while ((match = htmlKeyRegex.exec(htmlContent)) !== null) {
    usedInHtml.add(match[1]);
  }

  const appContent = await readFile(appPath, "utf8");
  const jsKeyRegex = /(?:\bwindow\.)?\bt\(\s*["']([^"']+)["']/g;
  const usedInJs = new Set();
  while ((match = jsKeyRegex.exec(appContent)) !== null) {
    usedInJs.add(match[1]);
  }

  // Also check filter labelKey in app.js
  const filterKeyRegex = /labelKey:\s*["']([^"']+)["']/g;
  while ((match = filterKeyRegex.exec(appContent)) !== null) {
    usedInJs.add(match[1]);
  }

  const allUsedKeys = new Set([...usedInHtml, ...usedInJs]);
  const missingKeys = [...allUsedKeys].filter((k) => !zhKeys.has(k));

  if (missingKeys.length > 0) {
    console.error("Keys referenced in HTML/JS but missing in dictionary:", missingKeys);
    hasErrors = true;
  }

  const unusedKeys = [...zhKeys].filter((k) => !allUsedKeys.has(k));
  if (unusedKeys.length > 0) {
    console.warn("Keys defined in dictionary but not referenced:", unusedKeys);
    // Warning only or error? Let's check if unused keys are expected
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(
    `EasyMac i18n check passed: ${zhKeys.size} keys aligned across zh/en, HTML, and JS.`,
  );
}

main().catch((err) => {
  console.error("Error running EasyMac i18n check:", err);
  process.exit(1);
});
