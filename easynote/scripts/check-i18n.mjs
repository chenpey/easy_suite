#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const i18nPath = resolve(projectRoot, "src/client/i18n.ts");
const clientDir = resolve(projectRoot, "src/client");

async function loadI18n() {
  const content = await readFile(i18nPath, "utf8");
  const match = content.match(/export const translations\s*(?::\s*[\s\S]*?)?=\s*(\{[\s\S]*?\n\};)/);
  if (!match) {
    throw new Error("Could not find translations in i18n.ts");
  }
  const fn = new Function(`return ${match[1]};`);
  return fn();
}

async function getFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getFiles(fullPath)));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith("i18n.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const translations = await loadI18n();
  if (!translations || !translations.zh || !translations.en) {
    console.error("Failed to load EasyNote translations from src/client/i18n.ts");
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

  const files = await getFiles(clientDir);
  const keyRegex = /(?:\btranslate|\bt)\(\s*["']([^"']+)["']/g;
  const usedKeys = new Set();

  for (const file of files) {
    const code = await readFile(file, "utf8");
    let match;
    while ((match = keyRegex.exec(code)) !== null) {
      usedKeys.add(match[1]);
    }
  }

  const missingKeys = [...usedKeys].filter((k) => !zhKeys.has(k));
  if (missingKeys.length > 0) {
    console.error("Keys referenced in client code but missing in dictionary:", missingKeys);
    hasErrors = true;
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(
    `EasyNote i18n check passed: ${zhKeys.size} keys aligned across zh/en and client code.`,
  );
}

main().catch((err) => {
  console.error("Error running EasyNote i18n check:", err);
  process.exit(1);
});
