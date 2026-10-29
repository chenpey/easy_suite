import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { en, zh } from "../web/i18n.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist/assets`, { recursive: true });

const fingerprint = (content) => createHash("sha256").update(content).digest("hex").slice(0, 12);
const javascript = await build({
  entryPoints: [`${root}/web/app.js`],
  bundle: true, minify: true, format: "esm", target: "es2022", write: false,
  define: { __EASYDROP_VERSION__: JSON.stringify(version) },
});
const script = javascript.outputFiles[0]?.contents;
if (!script) throw new Error("EasyDrop JavaScript bundle was not generated.");
const appAsset = `/assets/app-${fingerprint(script)}.js`;
await writeFile(`${root}/dist${appAsset}`, script);

const stylesheet = await readFile(`${root}/web/style.css`);
const styleAsset = `/assets/style-${fingerprint(stylesheet)}.css`;
await writeFile(`${root}/dist${styleAsset}`, stylesheet);

for (const page of ["index.html", "login.html"]) {
  const html = (await readFile(`${root}/web/${page}`, "utf8"))
    .replace("/assets/style.css", styleAsset)
    .replace("/assets/app.js", appAsset);
  await writeFile(`${root}/dist/${page}`, html);
}

// The same self-contained page explains every rejected or failed share, both
// from the service worker (inlined) and from the Worker fallback (served as an
// asset), so the wording lives in web/i18n.js only. It is intentionally absent
// from the service worker's static cache and from publicAssets.
const escapeHtml = (value) => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const fallbackTemplate = await readFile(`${root}/web/share-target-fallback.html`, "utf8");
const shareFallbackHtml = fallbackTemplate.replace(/\{\{([a-z0-9_]+)_(zh|en)\}\}/g, (match, key, language) => {
  const dictionary = language === "zh" ? zh : en;
  if (typeof dictionary[key] !== "string") throw new Error(`Unknown share fallback placeholder ${key}.`);
  return escapeHtml(dictionary[key]);
});
if (/\{\{[^}]*\}\}/.test(shareFallbackHtml)) {
  throw new Error("Share target fallback page contains an unresolved placeholder.");
}
await writeFile(`${root}/dist/share-target-fallback.html`, shareFallbackHtml);

const staticAssets = [
  appAsset,
  styleAsset,
  "/apple-touch-icon.png",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-maskable-512x512.png",
];
const serviceWorker = await build({
  entryPoints: [`${root}/web/sw.js`],
  bundle: true, minify: true, format: "iife", target: "es2022", write: false,
  define: {
    __EASYDROP_CACHE_NAME__: JSON.stringify(`easydrop-static-v${version}`),
    __EASYDROP_STATIC_ASSETS__: JSON.stringify(staticAssets),
    __EASYDROP_SHARE_FALLBACK_HTML__: JSON.stringify(shareFallbackHtml),
  },
});
const workerScript = serviceWorker.outputFiles[0]?.contents;
if (!workerScript) throw new Error("EasyDrop service worker was not generated.");
await writeFile(`${root}/dist/sw.js`, workerScript);

await copyFile(`${root}/web/favicon.svg`, `${root}/dist/favicon.svg`);
for (const file of [
  "manifest.webmanifest",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
  "apple-touch-icon.png",
]) {
  await copyFile(`${root}/web/${file}`, `${root}/dist/${file}`);
}
console.log("Built Worker static assets.");
