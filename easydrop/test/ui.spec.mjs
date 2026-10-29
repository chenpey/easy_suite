import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { createPreview } from "../scripts/preview.mjs";

let preview;
test.beforeAll(async () => {
  preview = await createPreview({
    POLL_INTERVAL_SECONDS: "5",
    LOGIN_IP_LIMIT: "1000",
    LOGIN_GLOBAL_LIMIT: "10000",
  });
});
test.afterAll(async () => { await preview?.mf.dispose(); });

test("switches login UI to English without mobile overflow", async ({ page }) => {
  await page.goto(`${preview.url}/login`);
  await page.locator("#login-language-select").selectOption("en");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.locator("#username")).toHaveAccessibleName("Username");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("PWA metadata, icons and public-only service worker cache work", async ({ page, context }) => {
  await page.goto(preview.url);
  await expect(page).toHaveURL(`${preview.url}/login`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");

  const manifestResponse = await page.request.get(`${preview.url}/manifest.webmanifest`);
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "EasyDrop",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#0071e3",
    background_color: "#f5f5f7",
  });
  expect(manifest.share_target).toEqual({
    action: "/share-target",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      title: "title",
      text: "text",
      url: "url",
      files: [{ name: "files", accept: ["*/*"] }],
    },
  });
  for (const path of [
    "/pwa-192x192.png",
    "/pwa-512x512.png",
    "/pwa-maskable-512x512.png",
    "/apple-touch-icon.png",
  ]) {
    const icon = await page.request.get(`${preview.url}${path}`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }

  const worker = await page.request.get(`${preview.url}/sw.js`);
  expect(worker.status()).toBe(200);
  expect(worker.headers()["content-type"]).toContain("javascript");
  await expect.poll(() => page.evaluate(async () =>
    Boolean(await navigator.serviceWorker.getRegistration("/")))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cdp = await context.newCDPSession(page);
  const loadedManifest = await cdp.send("Page.getAppManifest");
  expect(loadedManifest.url).toBe(`${preview.url}/manifest.webmanifest`);
  expect(loadedManifest.errors).toEqual([]);
  expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  const cachedPaths = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  const hashedAssets = cachedPaths.filter((path) => /^\/assets\/(?:app|style)-[a-f0-9]{12}\.(?:js|css)$/.test(path));
  expect(hashedAssets).toHaveLength(2);
  expect(cachedPaths.some((path) => path.startsWith("/api/"))).toBe(false);
  expect(cachedPaths.some((path) => path.includes("share-target"))).toBe(false);
  expect(cachedPaths.some((path) => ["/", "/index.html", "/login"].includes(path))).toBe(false);
  await context.setOffline(true);
  try {
    expect(await page.evaluate(async (paths) => Promise.all(paths.map(async (path) => {
      const response = await fetch(path);
      return response.ok;
    })), hashedAssets)).toEqual([true, true]);
  } finally {
    await context.setOffline(false);
  }
});

test("an external top-level launch preserves the persistent session", async ({ page, context }) => {
  const login = await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url },
    data: { username: preview.username, password: preview.password },
  });
  expect(login.status()).toBe(200);
  const sessionCookie = (await context.cookies(preview.url)).find((cookie) => cookie.name === "easydrop_dev");
  expect(sessionCookie).toMatchObject({ sameSite: "Lax" });

  await page.route("https://launcher.example.test/", (route) => route.fulfill({
    contentType: "text/html",
    body: `<a href="${preview.url}/">Open EasyDrop</a>`,
  }));
  const startupApis = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) startupApis.push(path);
  });
  await page.goto("https://launcher.example.test/");
  await page.getByRole("link", { name: "Open EasyDrop" }).click();
  await expect(page).toHaveURL(`${preview.url}/`);
  await expect(page.locator("#file-input")).toBeEnabled();
  expect(startupApis).toEqual(["/api/bootstrap"]);
});

test("login submission does not wait for registration configuration", async ({ page }) => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/auth/config", async (route) => {
    await hold;
    await route.continue();
  });
  try {
    await page.goto(`${preview.url}/login`);
    await page.locator("#login-view").getByLabel("用户名", { exact: true }).fill(preview.username);
    await page.locator("#login-view").getByLabel("密码", { exact: true }).fill(preview.password);
    const loginRequest = page.waitForRequest((request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/login");
    await page.locator("#login-view").getByRole("button", { name: "登录", exact: true }).click();
    await loginRequest;
    release();
    await expect(page).toHaveURL(`${preview.url}/`);
    await expect(page.locator("#file-input")).toBeEnabled();
  } finally {
    release?.();
  }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
  test(`share workflow at ${viewport.width}px`, async ({ page, context, browser }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: preview.url });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await expect(page).toHaveURL(`${preview.url}/login`);
    await expect(page).toHaveTitle("登录 | EasyDrop");
    await expect(page.getByRole("heading", { name: "EasyDrop" })).toBeVisible();
    await expect(page.locator("#login-view").getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(page.locator("#login-view").getByLabel("密码", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/login-${viewport.width}.png`, fullPage: true });

    // A disposable login through the real API installs its HttpOnly cookie into this test context.
    const login = await context.request.post(`${preview.url}/api/login`, {
      headers: { Origin: preview.url }, data: { username: preview.username, password: preview.password },
    });
    expect(login.status()).toBe(200);
    await page.goto(preview.url);
    await expect(page).toHaveTitle("EasyDrop");
    await expect(page.locator("#file-input")).toBeEnabled();
    await expect(page.locator("#upload-limit")).toHaveText("单文件上限 200.0 MB");
    const expectedContentWidth = viewport.width > 680 ? Math.min(viewport.width - 48, 960) : viewport.width - 32;
    const layoutBoxes = await page.locator(".header-inner, .workspace, .compose, .history").evaluateAll((nodes) =>
      nodes.map((node) => {
        const { left, width } = node.getBoundingClientRect();
        return { left, width };
      }));
    expect(layoutBoxes).toEqual(Array(4).fill({
      left: (viewport.width - expectedContentWidth) / 2,
      width: expectedContentWidth,
    }));
    const controlBoxes = await page.locator("#text-input, .file-picker").evaluateAll((nodes) =>
      nodes.map((node) => {
        const { top, height } = node.getBoundingClientRect();
        return { top, height };
      }));
    expect(controlBoxes.map(({ height }) => height)).toEqual([80, 80]);
    if (viewport.width > 680) expect(controlBoxes[0].top).toBe(controlBoxes[1].top);
    if (viewport.width === 1280) {
      await expect(page.locator(".compose")).toHaveCSS("width", "960px");
    }
    const sharedUrl = `${preview.url}/favicon.svg?source=shared#drop`;
    const text = `<script>window.injected = true</script>\n${sharedUrl}。\n${"long-text-".repeat(30)}`;
    await page.getByLabel("分享文本", { exact: true }).fill(text);
    await page.getByRole("button", { name: "分享文本", exact: true }).click();
    const textItem = page.locator(".history-item").filter({ hasText: text });
    await expect(textItem).toBeVisible();
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    const sharedLink = textItem.getByRole("link", { name: sharedUrl });
    await expect(sharedLink).toHaveAttribute("href", sharedUrl);
    await expect(sharedLink).toHaveAttribute("target", "_blank");
    await expect(sharedLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(textItem.locator(".item-text")).toHaveText(text);
    const openedLinkPromise = page.waitForEvent("popup");
    await sharedLink.click();
    const openedLink = await openedLinkPromise;
    await expect(openedLink).toHaveURL(sharedUrl);
    await openedLink.close();
    await expect(page.locator("#text-input")).toHaveValue("");
    const copyText = textItem.getByRole("button", { name: "复制文本" });
    await copyText.click();
    await expect(copyText).toHaveClass(/copy-confirmed/);
    await expect(page.locator("#copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    const filename = `qa-${viewport.width}-${"long-name-".repeat(16)}.txt`;
    const imageName = `preview-${viewport.width}.png`;
    const imageBase64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 768;
      const context = canvas.getContext("2d");
      context.fillStyle = "#0071e3";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(256, 192, 512, 384);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#file-input").setInputFiles([
      { name: filename, mimeType: "text/plain", buffer: Buffer.from("browser file contents") },
      { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      { name: imageName, mimeType: "image/png", buffer: Buffer.from(imageBase64, "base64") },
    ]);
    await expect(page.locator("#notice")).toHaveText("上传完成");
    const file = page.locator(".history-item").filter({ hasText: filename });
    await expect(file).toHaveCount(1);
    const image = page.locator(".history-item").filter({ hasText: imageName });
    const thumbnail = image.locator(".file-thumbnail");
    await image.scrollIntoViewIfNeeded();
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((node) => node.naturalWidth)).toBe(512);
    await expect(image.locator(".lucide-image")).toHaveClass(/lucide-image/);
    expect(await thumbnail.getAttribute("src")).toMatch(/^\/previews\/[a-f0-9-]+$/);
    await thumbnail.evaluate((node) => { node.dataset.testIdentity = "preserved"; });
    let repeatedPreviewRequests = 0;
    const countPreviewRequest = (request) => {
      if (new URL(request.url()).pathname.startsWith("/previews/")) repeatedPreviewRequests++;
    };
    page.on("request", countPreviewRequest);
    await page.getByRole("button", { name: "刷新历史" }).click();
    await expect(page.locator("#notice")).toHaveText("已刷新");
    await expect(thumbnail).toHaveAttribute("data-test-identity", "preserved");
    expect(repeatedPreviewRequests).toBe(0);
    page.off("request", countPreviewRequest);
    let unexpectedDownloads = 0;
    let unexpectedPopups = 0;
    const countUnexpectedDownload = () => { unexpectedDownloads++; };
    const countUnexpectedPopup = () => { unexpectedPopups++; };
    page.on("download", countUnexpectedDownload);
    page.on("popup", countUnexpectedPopup);
    await image.locator(".item-actions").getByRole("button", { name: `预览图片 ${imageName}` }).click();
    const imagePreviewDialog = page.locator("#image-preview-dialog");
    await expect(imagePreviewDialog).toBeVisible();
    await expect(imagePreviewDialog.locator("#image-preview-name")).toHaveText(imageName);
    const fullImage = imagePreviewDialog.locator("#image-preview-content");
    await expect(fullImage).toBeVisible();
    expect(await fullImage.getAttribute("src")).toMatch(/^\/images\/[a-f0-9-]+\/preview-\d+\.png$/);
    await expect.poll(() => fullImage.evaluate((node) => node.naturalWidth)).toBe(1024);
    const previewBounds = await imagePreviewDialog.locator(".image-preview-stage").boundingBox();
    const fullImageBounds = await fullImage.boundingBox();
    expect(fullImageBounds.width).toBeLessThanOrEqual(previewBounds.width + 1);
    expect(fullImageBounds.height).toBeLessThanOrEqual(previewBounds.height + 1);
    expect(unexpectedDownloads).toBe(0);
    expect(unexpectedPopups).toBe(0);
    await page.screenshot({ path: `test-results/image-preview-${viewport.width}.png` });
    await imagePreviewDialog.getByRole("button", { name: "关闭图片预览" }).click();
    await expect(imagePreviewDialog).toBeHidden();
    page.off("download", countUnexpectedDownload);
    page.off("popup", countUnexpectedPopup);
    const fileLink = file.getByRole("link", { name: `下载文件 ${filename}` });
    const fileUrl = await fileLink.getAttribute("href");
    const fileLinkUrl = new URL(fileUrl);
    expect(fileLinkUrl.pathname).toMatch(/^\/uploads\/[a-f0-9-]+\//);
    expect(decodeURIComponent(fileLinkUrl.pathname.split("/").at(-1))).toBe(filename);
    await expect(fileLink).not.toHaveAttribute("target", "_blank");
    await expect(image.getByRole("link", { name: `下载文件 ${imageName}` })).toBeVisible();
    const copyFileLink = file.getByRole("button", { name: "复制文件链接" });
    await copyFileLink.click();
    await expect(copyFileLink).toHaveClass(/copy-confirmed/);
    await expect(page.locator("#copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fileUrl);
    await file.getByRole("button", { name: "创建临时链接" }).click();
    const temporaryDialog = page.locator("#temporary-share-dialog");
    await expect(temporaryDialog).toBeVisible();
    await temporaryDialog.getByRole("spinbutton", { name: "有效时长（小时）" }).fill("2");
    await temporaryDialog.getByRole("button", { name: "创建链接" }).click();
    await expect(page.locator("#notice")).toHaveText("临时链接已创建");
    const temporaryLink = temporaryDialog.locator("#temporary-share-url");
    const temporaryUrl = await temporaryLink.getAttribute("href");
    const temporaryLinkUrl = new URL(temporaryUrl);
    expect(temporaryLinkUrl.pathname).toMatch(/^\/shared\/[a-f0-9]{64}\//);
    expect(decodeURIComponent(temporaryLinkUrl.pathname.split("/").at(-1))).toBe(filename);
    await expect(temporaryLink).not.toHaveAttribute("target", "_blank");
    await expect(temporaryLink).toHaveAttribute("download", filename);
    await expect(temporaryDialog.locator("#temporary-share-status")).toContainText("当前链接有效至");
    await expect.poll(() => temporaryDialog.locator("#temporary-share-qr").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    const copyTemporaryLink = temporaryDialog.getByRole("button", { name: "复制链接" });
    await copyTemporaryLink.click();
    await expect(temporaryDialog.locator("#temporary-share-notice")).toBeVisible();
    await expect(temporaryDialog.locator("#temporary-share-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(temporaryUrl);
    await page.screenshot({ path: `test-results/temporary-share-${viewport.width}.png` });
    const temporaryDownloadPromise = page.waitForEvent("download");
    await temporaryLink.click();
    const temporaryDownload = await temporaryDownloadPromise;
    expect(temporaryDownload.suggestedFilename()).toBe(filename);
    expect(await temporaryDownload.failure()).toBeNull();
    const guestContext = await browser.newContext();
    const publicDownload = await guestContext.request.get(temporaryUrl);
    expect(publicDownload.status()).toBe(200);
    expect(await publicDownload.text()).toBe("browser file contents");
    await temporaryDialog.getByRole("button", { name: "撤销链接" }).click();
    await expect(page.locator("#notice")).toHaveText("临时链接已撤销");
    expect((await guestContext.request.get(temporaryUrl)).status()).toBe(404);
    await guestContext.close();
    await temporaryDialog.getByRole("button", { name: "关闭" }).click();
    await expect(file.getByRole("button", { name: "创建临时链接" })).toBeVisible();
    await expect(file.locator(".file-link-qr canvas")).toHaveCount(0);
    await fileLink.hover();
    await expect(file.locator(".file-link-qr")).toBeVisible();
    await expect(file.locator(".file-link-qr")).toHaveCSS("opacity", "1");
    await expect.poll(() => file.locator(".file-link-qr canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    await page.screenshot({ path: `test-results/file-link-qr-${viewport.width}.png` });
    const downloadPromise = page.waitForEvent("download");
    await fileLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
    await page.locator("#refresh").focus();
    await page.locator("#history-title").hover();
    await expect(file.locator(".file-link-qr")).toBeHidden();
    await page.screenshot({ path: `test-results/share-${viewport.width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const scanContext = await browser.newContext({ viewport });
    const scanPage = await scanContext.newPage();
    await scanPage.goto(fileUrl);
    await expect(scanPage).toHaveURL(/\/login\?next=/);
    expect(new URL(scanPage.url()).searchParams.get("next")).toBe(new URL(fileUrl).pathname);
    await scanPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill(preview.username);
    await scanPage.locator("#login-view").getByLabel("密码", { exact: true }).fill(preview.password);
    const scannedDownloadPromise = scanPage.waitForEvent("download");
    await scanPage.getByRole("button", { name: "登录", exact: true }).click();
    const scannedDownload = await scannedDownloadPromise;
    expect(scannedDownload.suggestedFilename()).toBe(filename);
    expect(await scannedDownload.failure()).toBeNull();
    await expect(scanPage).toHaveURL(`${preview.url}/`);
    await scanContext.close();

    const siteQrButton = page.getByRole("button", { name: "访问二维码" });
    await siteQrButton.hover();
    await expect(page.locator("#site-link-popover")).toBeVisible();
    await expect(page.locator("#site-url-preview")).toHaveText(preview.url);
    await expect.poll(() => page.locator("#site-qr-preview").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    await page.screenshot({ path: `test-results/site-qr-hover-${viewport.width}.png` });
    await page.locator("#history-title").hover();
    await expect(page.locator("#site-link-popover")).toBeHidden();
    await siteQrButton.click();
    await expect(page.locator("#qr-dialog")).toBeVisible();
    expect(await page.locator("#qr-canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark > 100 && dark < canvas.width * canvas.height * 0.8;
    })).toBe(true);
    await page.locator("#copy-url").click();
    await expect(page.locator("#site-copy-notice")).toBeVisible();
    await expect(page.locator("#site-copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(preview.url);
    await page.screenshot({ path: `test-results/qr-${viewport.width}.png` });
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    await file.getByRole("button", { name: "删除记录" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(file).toHaveCount(0);
    await page.getByRole("button", { name: "清空历史" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("暂无分享记录")).toBeVisible();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page).toHaveURL(`${preview.url}/login`);
    expect((await context.request.get(`${preview.url}/api/history`)).status()).toBe(401);
    expect(errors).toEqual([]);
  });
}

async function loginContext(context) {
  const login = await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url }, data: { username: preview.username, password: preview.password },
  });
  expect(login.ok()).toBe(true);
  const session = await (await context.request.get(`${preview.url}/api/session`)).json();
  const headers = { Origin: preview.url, "X-CSRF-Token": session.csrfToken };
  await context.request.post(`${preview.url}/api/clear_history`, { headers });
  return headers;
}

test("administrator can create, edit, disable, enable and delete a user", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await page.getByRole("button", { name: "账户与设置" }).click();
  await page.getByRole("button", { name: "用户管理" }).click();
  await expect(page.locator("#account-dialog")).toBeVisible();

  await page.locator("#user-name").fill("ui-member");
  await page.locator("#user-password").fill("UiMemberPass123!");
  await page.getByRole("button", { name: "添加用户" }).click();
  let row = page.locator(".user-row").filter({ hasText: "ui-member" });
  await expect(row).toContainText("用户 · 已启用");
  await page.screenshot({ path: "test-results/users-1280.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#account-dialog")).toBeVisible();
  expect(await page.locator("#account-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/users-390.png" });

  await row.getByRole("button", { name: "编辑用户" }).click();
  await page.locator("#user-name").fill("ui-member-edited");
  await page.getByLabel("新密码（留空则不修改）").fill("ChangedPass456!");
  await page.getByRole("button", { name: "保存修改" }).click();
  row = page.locator(".user-row").filter({ hasText: "ui-member-edited" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "禁用用户" }).click();
  await expect(row).toContainText("已禁用");
  await row.getByRole("button", { name: "启用用户" }).click();
  await expect(row).toContainText("已启用");

  await row.getByRole("button", { name: "删除用户" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(row).toHaveCount(0);
});

test("sole administrator cannot see delete account button, but normal user or multiple admins can", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await page.getByRole("button", { name: "账户与设置" }).click();
  await expect(page.locator("#delete-account-open")).toBeHidden();
  await expect(page.locator("#account-danger")).toBeHidden();

  await page.getByRole("button", { name: "用户管理" }).click();
  await page.locator("#user-name").fill("second-admin");
  await page.locator("#user-password").fill("SecondAdminPass123!");
  await page.locator("#user-role").selectOption("admin");
  await page.getByRole("button", { name: "添加用户" }).click();
  await expect(page.locator(".user-row").filter({ hasText: "second-admin" })).toBeVisible();

  await page.getByRole("button", { name: "个人设置" }).click();
  await expect(page.locator("#delete-account-open")).toBeVisible();
  await expect(page.locator("#account-danger")).toBeVisible();

  await page.getByRole("button", { name: "用户管理" }).click();
  const secondAdminRow = page.locator(".user-row").filter({ hasText: "second-admin" });
  await secondAdminRow.getByRole("button", { name: "删除用户" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(secondAdminRow).toHaveCount(0);

  await page.getByRole("button", { name: "个人设置" }).click();
  await expect(page.locator("#delete-account-open")).toBeHidden();
  await expect(page.locator("#account-danger")).toBeHidden();
});

test("registration, recovery, password change and self-deletion work end to end", async ({ page, context, browser }) => {
  const adminHeaders = await loginContext(context);
  await page.goto(preview.url);
  await page.getByRole("button", { name: "账户与设置" }).click();
  await page.getByRole("button", { name: "用户管理" }).click();
  await page.getByLabel("自助注册").check();
  await expect(page.locator("#notice")).toHaveText("已开放自助注册");
  await expect(page.getByLabel("自助注册")).toBeChecked();
  await page.locator("#account-dialog").getByRole("button", { name: "关闭" }).click();

  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${preview.url}/register`);
  await expect(memberPage).toHaveTitle("注册 | EasyDrop");
  const registerView = memberPage.locator("#register-view");
  await registerView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await registerView.getByLabel("密码", { exact: true }).fill("UiSelfService123!");
  await registerView.getByLabel("确认密码").fill("UiSelfService123!");
  await registerView.getByRole("button", { name: "提交注册" }).click();
  await expect(registerView.getByText("注册已提交，等待管理员启用。")).toBeVisible();
  const registrationCode = await memberPage.locator("#registration-recovery-code").textContent();
  expect(registrationCode).toMatch(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  await memberPage.screenshot({ path: "test-results/registration-1280.png", fullPage: true });

  const row = page.locator(".user-row").filter({ hasText: "ui-self-service" });
  await page.getByRole("button", { name: "账户与设置" }).click();
  await page.getByRole("button", { name: "用户管理" }).click();
  await expect(row).toContainText("待启用");
  await row.getByRole("button", { name: "启用用户" }).click();
  await expect(row).toContainText("已启用");

  await memberPage.goto(`${preview.url}/login`);
  const loginView = memberPage.locator("#login-view");
  await loginView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await loginView.getByLabel("密码", { exact: true }).fill("UiSelfService123!");
  await loginView.getByRole("button", { name: "登录", exact: true }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/`);

  await memberPage.getByRole("button", { name: "账户与设置" }).click();
  const accountDialog = memberPage.locator("#account-dialog");
  await expect(accountDialog).toBeVisible();
  await expect(accountDialog.locator("#account-username")).toHaveText("ui-self-service");
  const recoveryForm = accountDialog.locator("#recovery-form");
  await recoveryForm.getByLabel("当前密码").fill("UiSelfService123!");
  await recoveryForm.getByRole("button", { name: "生成恢复码" }).click();
  await expect(accountDialog.locator("#account-recovery-code")).toHaveText(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  const recoveryCode = await accountDialog.locator("#account-recovery-code").textContent();
  expect(recoveryCode).toMatch(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  await memberPage.setViewportSize({ width: 390, height: 844 });
  expect(await accountDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await memberPage.screenshot({ path: "test-results/account-390.png" });

  const resetContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const resetPage = await resetContext.newPage();
  await resetPage.goto(`${preview.url}/reset-password`);
  await expect(resetPage).toHaveTitle("重置密码 | EasyDrop");
  const resetView = resetPage.locator("#reset-view");
  await resetView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await resetView.getByLabel("恢复码").fill(recoveryCode);
  await resetView.getByLabel("新密码", { exact: true }).fill("UiRecoveredPass456!");
  await resetView.getByLabel("确认新密码").fill("UiRecoveredPass456!");
  await resetView.getByRole("button", { name: "重置密码" }).click();
  await expect(resetPage.locator("#notice")).toHaveText("密码已重置，请返回登录");
  await resetContext.close();

  await memberPage.reload();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);
  await memberPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await memberPage.locator("#login-view").getByLabel("密码", { exact: true }).fill("UiRecoveredPass456!");
  await memberPage.locator("#login-view").getByRole("button", { name: "登录", exact: true }).click();
  await memberPage.getByRole("button", { name: "账户与设置" }).click();
  const passwordForm = memberPage.locator("#password-form");
  await passwordForm.getByLabel("当前密码").fill("UiRecoveredPass456!");
  await passwordForm.getByLabel("新密码", { exact: true }).fill("UiChangedPass789!");
  await passwordForm.getByLabel("确认新密码").fill("UiChangedPass789!");
  await passwordForm.getByRole("button", { name: "修改密码" }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);

  await memberPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await memberPage.locator("#login-view").getByLabel("密码", { exact: true }).fill("UiChangedPass789!");
  await memberPage.locator("#login-view").getByRole("button", { name: "登录", exact: true }).click();
  await memberPage.getByRole("button", { name: "账户与设置" }).click();
  await memberPage.getByRole("button", { name: "注销账号" }).click();
  const deleteDialog = memberPage.locator("#delete-account-dialog");
  await deleteDialog.locator("#delete-account-username").fill("ui-self-service");
  await deleteDialog.getByLabel("当前密码").fill("UiChangedPass789!");
  await deleteDialog.getByRole("button", { name: "确认删除" }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);
  await memberContext.close();

  const closed = await context.request.patch(`${preview.url}/api/settings/registration`, {
    headers: adminHeaders,
    data: { enabled: false },
  });
  expect(closed.ok()).toBe(true);
});

test("temporary share ignores a stale response after switching files", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await page.locator("#file-input").setInputFiles([
    { name: "share-race-a.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "share-race-b.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  await expect(page.locator("#notice")).toHaveText("上传完成");
  const first = page.locator(".history-item").filter({ hasText: "share-race-a.txt" });
  const second = page.locator(".history-item").filter({ hasText: "share-race-b.txt" });
  let release;
  let responseReady;
  const hold = new Promise((resolve) => { release = resolve; });
  const reachedResponse = new Promise((resolve) => { responseReady = resolve; });
  let delayed = false;
  await page.route("**/api/history/*/share", async (route) => {
    if (!delayed && route.request().method() === "POST") {
      delayed = true;
      const response = await route.fetch();
      responseReady();
      await hold;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  try {
    await first.getByRole("button", { name: "创建临时链接" }).click();
    const dialog = page.locator("#temporary-share-dialog");
    await dialog.getByRole("button", { name: "创建链接" }).click();
    await reachedResponse;
    await dialog.getByRole("button", { name: "关闭" }).click();
    await second.getByRole("button", { name: "创建临时链接" }).click();
    await expect(dialog.locator("#temporary-share-file")).toHaveText("share-race-b.txt");
    release();
    await expect(dialog.getByRole("button", { name: "创建链接" })).toBeEnabled();
    await expect(dialog.locator("#temporary-share-file")).toHaveText("share-race-b.txt");
    await expect(dialog.locator("#temporary-share-result")).toBeHidden();
    await expect(dialog.locator("#temporary-share-status")).toHaveText("当前未启用临时访问");
  } finally {
    release?.();
  }
});

test("editing during submit cannot send a second request or erase new input", async ({ page, context }) => {
  await loginContext(context);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/text", async (route) => {
    requests++;
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.goto(preview.url);
  await expect(page.locator("#file-input")).toBeEnabled();
  await page.locator("#text-input").fill("first draft");
  await page.getByRole("button", { name: "分享文本", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.locator("#text-input").fill("next draft");
  await expect(page.getByRole("button", { name: "分享文本", exact: true })).toBeDisabled();
  release();
  await expect(page.locator(".item-text")).toHaveText("first draft");
  await expect(page.locator("#text-input")).toHaveValue("next draft");
  expect(requests).toBe(1);
});

test("lost upload response can be retried without duplicate history", async ({ page, context }) => {
  await loginContext(context);
  let interrupted = false;
  let completeReached;
  let releaseComplete;
  const reachedComplete = new Promise((resolve) => { completeReached = resolve; });
  const holdComplete = new Promise((resolve) => { releaseComplete = resolve; });
  await page.route("**/api/uploads/*/complete", async (route) => {
    if (!interrupted) {
      interrupted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      completeReached();
      await holdComplete;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto(preview.url);
  await expect(page.locator("#file-input")).toBeEnabled();
  await page.locator("#file-input").setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry") });
  try {
    await reachedComplete;
    await expect(page.locator("#upload-list .upload-row > .muted")).toHaveText("上传分片 1/1");
  } finally {
    releaseComplete();
  }
  await expect(page.locator("#notice")).toHaveText("1 个文件上传失败");
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await expect(page.locator("#notice")).toHaveText("上传完成");
  await expect(page.locator(".history-item").filter({ hasText: "retry.txt" })).toHaveCount(1);
});

test("multipart upload runs concurrently and resumes after pause and reload", async ({ page, context }) => {
  await loginContext(context);
  const path = new URL("../test-results/resume-large.bin", import.meta.url).pathname;
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await writeFile(path, Buffer.alloc(11 * 1024 * 1024, 0x5a));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response });
    } catch {
      // Pausing intentionally aborts the browser-side requests.
    } finally {
      active--;
    }
  });
  try {
    await page.goto(preview.url);
    await page.locator("#file-input").setInputFiles(path);
    await expect.poll(() => maxActive).toBeGreaterThan(1);
    await page.getByRole("button", { name: "暂停上传", exact: true }).click();
    release();
    await expect(page.locator("#notice")).toHaveText("上传已暂停");
    await page.unroute("**/api/uploads/*/parts/*");

    await page.reload();
    await page.locator("#file-input").setInputFiles(path);

    await expect(page.locator("#notice")).toHaveText("上传完成", { timeout: 30000 });
    await expect(page.locator(".history-item").filter({ hasText: "resume-large.bin" })).toHaveCount(1);
  } finally {
    release?.();
    await rm(path, { force: true });
  }
});

test("multiple files upload concurrently", async ({ page, context }) => {
  await loginContext(context);
  let release;
  let released = false;
  const hold = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  let active = 0;
  let maxActive = 0;
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response });
    } finally {
      active--;
    }
  });
  try {
    await page.goto(preview.url);
    await page.locator("#file-input").setInputFiles([
      { name: "parallel-a.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
      { name: "parallel-b.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
      { name: "parallel-c.txt", mimeType: "text/plain", buffer: Buffer.from("third") },
    ]);
    await expect.poll(() => maxActive).toBeGreaterThan(2);
    release();
    await expect(page.locator("#notice")).toHaveText("上传完成");
    await expect(page.locator(".history-item").filter({ hasText: "parallel-a.txt" })).toHaveCount(1);
    await expect(page.locator(".history-item").filter({ hasText: "parallel-b.txt" })).toHaveCount(1);
    await expect(page.locator(".history-item").filter({ hasText: "parallel-c.txt" })).toHaveCount(1);
    await expect(page.locator("#upload")).toBeHidden();
    await expect(page.locator("#upload-list > li")).toHaveCount(3);
    await expect(page.locator("#upload-list > li")).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator("#file-count")).toBeEmpty();
    await expect(page.locator(".history-item").filter({ hasText: "parallel-a.txt" })).toHaveCount(1);
  } finally {
    if (!released) release();
    await page.unroute("**/api/uploads/*/parts/*");
  }
});

test("history paginates ten newest records and polling preserves the current page", async ({ page, context }) => {
  const headers = await loginContext(context);
  for (let i = 0; i < 18; i++) {
    expect((await context.request.post(`${preview.url}/api/text`, { headers, data: { text: `history-${i}` } })).ok()).toBe(true);
  }
  await page.goto(preview.url);
  await expect(page.locator(".history-item")).toHaveCount(10);
  await expect(page.locator(".item-text").first()).toHaveText("history-17");
  await expect(page.locator(".item-text").last()).toHaveText("history-8");
  await expect(page.getByRole("button", { name: "上一页" })).toBeDisabled();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".history-item")).toHaveCount(8);
  await expect(page.locator("#history-page")).toHaveText("第2/2页");
  await expect(page.locator(".item-text").first()).toHaveText("history-7");
  await expect(page.locator(".item-text").last()).toHaveText("history-0");
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  const anchor = page.getByText("history-7", { exact: true });
  await anchor.scrollIntoViewIfNeeded();
  const anchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  let revisionRequests = 0;
  await page.route("**/api/revision", async (route) => {
    revisionRequests++;
    if (revisionRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Temporary polling failure." }),
      });
      return;
    }
    await route.continue();
  });
  const created = await context.request.post(`${preview.url}/api/text`, {
    headers, data: { text: "new from another device" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#notice")).toHaveText("Temporary polling failure.");
  await expect(page.locator("#notice")).toHaveText("分享历史已自动更新", { timeout: 12000 });
  await expect(page.locator("#history-page")).toHaveText("第2/2页");
  await expect(page.locator(".history-item")).toHaveCount(8);
  await expect(page.locator(".item-text").first()).toHaveText("history-7");
  expect(revisionRequests).toBeGreaterThanOrEqual(2);
  expect(Math.abs(await anchor.evaluate((node) => node.getBoundingClientRect().top) - anchorTop)).toBeLessThan(1);
  await page.getByRole("button", { name: "上一页" }).click();
  await expect(page.locator("#history-page")).toHaveText("第1/2页");
  await expect(page.locator(".history-item")).toHaveCount(10);
  await expect(page.locator(".item-text").first()).toHaveText("new from another device");
  const deleted = await context.request.delete(`${preview.url}/api/history/${id}`, { headers });
  expect(deleted.ok()).toBe(true);
  await expect(page.getByText("new from another device", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".history-item")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".history-item")).toHaveCount(8);
  await page.getByRole("checkbox", { name: "批量选择", exact: true }).check();
  await page.getByRole("button", { name: "删除所选 8 条记录", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator("#history-page")).toHaveText("第1/1页");
  await expect(page.locator("#history-count")).toHaveText("10");
  await expect(page.locator(".history-item")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
});

test("selected deletion, partial failure and transient notices", async ({ page, context }) => {
  await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url },
    data: { username: preview.username, password: preview.password },
  });
  let items = [1, 2, 3].map((id) => ({ id: String(id), type: "text", content: `batch-${id}`, created_at: 1700000000 }));
  let failSecond = true;
  let releaseSecond;
  const secondRequest = new Promise((resolve) => { releaseSecond = resolve; });
  const deleted = [];
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    await route.fulfill({
      response,
      json: { ...bootstrap, history: { items, total: items.length, totalPages: 1, nextCursor: null, revision: 1 } },
    });
  });
  await page.route("**/api/history**", async (route) => {
    if (route.request().method() === "DELETE") {
      const id = route.request().url().split("/").at(-1);
      if (id === "2" && failSecond) {
        await secondRequest;
        return route.fulfill({ status: 503, json: { message: "Please retry" } });
      }
      deleted.push(id);
      items = items.filter((item) => item.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    await route.fulfill({ json: { items, total: items.length, totalPages: 1, nextCursor: null, revision: 1 } });
  });
  await page.route("**/api/revision", (route) => route.fulfill({ json: { revision: 1 } }));
  await page.goto(preview.url);
  await expect(page.locator(".history-item")).toHaveCount(3);
  await expect(page.locator(".history > .section-heading .tools").getByLabel("批量选择", { exact: true })).toBeVisible();
  await page.getByLabel("批量选择", { exact: true }).check();
  await expect(page.locator("#history-title #selection-count")).toHaveText("已选 3 条");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: "test-results/selection-320.png", fullPage: true });
  await page.getByLabel("选择记录：batch-3", { exact: true }).uncheck();
  await page.getByRole("button", { name: "删除所选 2 条记录", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect.poll(() => deleted).toEqual(["1"]);
  await expect(page.locator("#notice")).toHaveText("正在删除…");
  await expect(page.locator(".history-item:visible")).toHaveCount(1);
  await expect(page.getByLabel("选择记录：batch-1", { exact: true })).toBeHidden();
  await expect(page.getByLabel("选择记录：batch-2", { exact: true })).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".history-item:visible")).toHaveCount(1);
  releaseSecond();
  await expect(page.locator("#notice")).toHaveText("Please retry");
  await expect(page.locator(".history-item")).toHaveCount(2);
  expect(deleted).toEqual(["1"]);
  await expect(page.getByLabel("选择记录：batch-2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("选择记录：batch-2", { exact: true })).toBeChecked();
  failSecond = false;
  await page.getByRole("button", { name: "删除所选 1 条记录", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator("#notice")).toHaveText("已删除 1 条记录");
  await expect(page.locator("#error-details")).toBeHidden();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator("#notice")).toBeEmpty({ timeout: 2500 });
  expect(deleted).toEqual(["1", "2"]);
  await expect(page.getByRole("button", { name: "清空历史", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除记录", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator(".history-item")).toHaveCount(0);
  await expect(page.locator("#notice")).toBeEmpty({ timeout: 2500 });
});

test("history filters constrain selection and dialogs ignore pasted files", async ({ page, context }) => {
  await loginContext(context);
  const items = [
    { id: "filter-text", type: "text", content: "filter text", created_at: 1700000002 },
    { id: "filter-file", type: "file", name: "filter.txt", size: 4, media_type: null, created_at: 1700000001 },
    { id: "filter-image", type: "file", name: "filter.png", size: 4, media_type: "image/png", created_at: 1700000000 },
  ];
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    await route.fulfill({ response, json: {
      ...bootstrap,
      history: { items, total: items.length, totalPages: 1, nextCursor: null, revision: 1 },
    } });
  });
  await page.goto(preview.url);
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await expect(page.locator(".history-item:visible")).toHaveCount(1);
  await page.getByLabel("批量选择", { exact: true }).check();
  await expect(page.getByLabel("选择记录：filter.png")).toBeChecked();
  await expect(page.getByLabel("选择记录：filter text")).not.toBeChecked();
  await expect(page.getByLabel("选择记录：filter.txt")).not.toBeChecked();
  await expect(page.locator("#selection-count")).toHaveText("已选 1 条");

  await page.getByRole("button", { name: "账户与设置" }).click();
  await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(["secret"], "dialog-paste.txt", { type: "text/plain" }));
    document.querySelector("#account-dialog").dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  await expect(page.locator("#upload-list > li")).toHaveCount(0);
});

test("pastes clipboard images and files even when the text field has focus", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await expect(page.locator("#file-input")).toBeEnabled();
  const pasteResult = await page.evaluate((pngBase64) => {
    const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "", { type: "image/png" }));
    clipboard.items.add(new File(["clipboard file"], "clipboard-note.txt", { type: "text/plain" }));
    const input = document.querySelector("#text-input");
    input.focus();
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    });
    return {
      prevented: !input.dispatchEvent(event),
      focused: document.activeElement === input,
    };
  }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");

  expect(pasteResult).toEqual({ prevented: true, focused: true });
  await expect(page.locator("#notice")).toHaveText("上传完成");
  const image = page.locator('.history-item[data-category="image"]');
  await expect(image).toHaveCount(1);
  await expect(image.locator(".item-name")).toHaveText(/^pasted-image-\d{14}-1\.png \(\d+ B\)$/);
  await expect(image.locator(".file-thumbnail")).toBeVisible();
  await expect(page.locator(".history-item").filter({ hasText: "clipboard-note.txt" })).toHaveCount(1);
  await expect(page.locator("#text-input")).toHaveValue("");
});


test("thumbnail upload does not block file parts", async ({ page, context }) => {
  await loginContext(context);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let partStarted = false;
  await page.route("**/api/uploads/*/preview", async (route) => {
    await hold;
    await route.continue();
  });
  page.on("request", (request) => {
    if (/\/api\/uploads\/[^/]+\/parts\//.test(request.url())) partStarted = true;
  });
  try {
    await page.goto(preview.url);
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 10;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#file-input").setInputFiles({
      name: "parallel-preview.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
    });
    await expect.poll(() => partStarted).toBe(true);
    release();
    await expect(page.locator("#notice")).toHaveText("上传完成");
  } finally {
    release();
    await page.unroute("**/api/uploads/*/preview");
  }
});


test("completed files appear in history while another upload is pending", async ({ page, context }) => {
  await loginContext(context);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    if (route.request().postDataBuffer()?.toString() === "slow upload") await hold;
    await route.continue();
  });
  try {
    await page.goto(preview.url);
    await page.locator("#file-input").setInputFiles([
      { name: "pending-upload.txt", mimeType: "text/plain", buffer: Buffer.from("slow upload") },
      { name: "finished-upload.txt", mimeType: "text/plain", buffer: Buffer.from("fast upload") },
    ]);
    await expect(page.locator(".history-item").filter({ hasText: "finished-upload.txt" })).toHaveCount(1);
    await expect(page.locator(".history-item").filter({ hasText: "pending-upload.txt" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "暂停上传", exact: true })).toBeVisible();
    release();
    await expect(page.locator("#notice")).toHaveText("上传完成");
    await expect(page.locator(".history-item").filter({ hasText: "pending-upload.txt" })).toHaveCount(1);
  } finally {
    release();
    await page.unroute("**/api/uploads/*/parts/*");
  }
});


test("thirteen records show the total count and two pages", async ({ page, context }) => {
  const headers = await loginContext(context);
  for (let i = 0; i < 13; i++) {
    expect((await context.request.post(`${preview.url}/api/text`, {
      headers, data: { text: `total-${i}` },
    })).ok()).toBe(true);
  }
  await page.goto(preview.url);
  await expect(page.locator("#history-count")).toHaveText("13");
  await expect(page.locator("#history-page")).toHaveText("第1/2页");
  await expect(page.locator(".history-item")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator("#history-count")).toHaveText("13");
  await expect(page.locator("#history-page")).toHaveText("第2/2页");
  await expect(page.locator(".history-item")).toHaveCount(3);
});


async function controlledPage(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function submitShareForm(page, { title = "", text = "", url = "", files = [], enctype = "multipart/form-data" } = {}) {
  await page.evaluate((payload) => {
    const form = document.createElement("form");
    form.method = "post";
    form.enctype = payload.enctype;
    form.action = "/share-target";
    for (const name of ["title", "text", "url"]) {
      if (!payload[name]) continue;
      const input = document.createElement("input");
      input.name = name;
      input.value = payload[name];
      form.append(input);
    }
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.name = "files";
    fileInput.multiple = true;
    form.append(fileInput);
    document.body.append(form);
    const transfer = new DataTransfer();
    for (const file of payload.files) transfer.items.add(new File([file.bytes], file.name, { type: file.type }));
    fileInput.files = transfer.files;
    form.submit();
  }, { title, text, url, files, enctype }).catch(() => undefined);
}

function trackContentWrites(page) {
  const writes = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(?:text|uploads)(?:\/|$)/.test(path)) writes.push(`${request.method()} ${path}`);
  });
  return writes;
}

async function writePendingShare(page, record) {
  await page.evaluate(async (value) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("easydrop-share-target", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("shares");
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("shares", "readwrite");
        transaction.objectStore("shares").put(value, "pending");
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
      request.onerror = () => reject(request.error);
    });
  }, record);
}

async function readPendingShare(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("easydrop-share-target", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("shares");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const transaction = db.transaction("shares", "readonly");
      const request = transaction.objectStore("shares").get("pending");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  });
}

test("share target stages text and files until separate user confirmations", async ({ page, context }) => {
  await loginContext(context);
  const writes = trackContentWrites(page);
  await page.goto(preview.url);
  await controlledPage(page);
  const shareResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/share-target" && response.request().method() === "POST");
  await submitShareForm(page, {
    title: "shared title",
    text: "shared body",
    url: "https://127.0.0.1:9/path",
    files: [
      { name: "alpha.txt", type: "text/plain", bytes: "alpha" },
      { name: "binary.bin", type: "", bytes: new Uint8Array([1, 2, 3]) },
    ],
  });
  const staged = await shareResponse;
  expect(staged.status()).toBe(303);
  expect(staged.headers()["location"]).toBe("/");
  expect(staged.headers()["cache-control"]).toBe("no-store");
  expect(staged.fromServiceWorker()).toBe(true);
  await expect(page).toHaveURL(`${preview.url}/`);
  expect(page.url()).toBe(`${preview.url}/`);
  await expect(page.locator("#text-input")).toHaveValue("shared title\nshared body\nhttps://127.0.0.1:9/path");
  await expect(page.locator("#notice")).toHaveText("已接收分享，请确认内容后点击「分享文本」或「继续上传」保存。");
  await expect(page.locator("#upload-list > li")).toHaveCount(2);
  expect(await page.locator("#upload-list > li .upload-name").allTextContents()).toEqual([
    expect.stringContaining("alpha.txt"),
    expect.stringContaining("binary.bin"),
  ]);
  await expect(page.locator("#upload")).toBeVisible();
  await expect(page.locator("#upload")).toHaveText("继续上传");
  await expect(page.locator(".history-item")).toHaveCount(0);
  expect(writes).toEqual([]);

  await page.locator("#text-form button[type=submit]").click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator(".history-item")).toContainText("shared body");
  expect(writes).toEqual(["POST /api/text"]);

  await page.locator("#upload").click();
  await expect(page.locator(".history-item")).toHaveCount(3);
  await expect(page.locator(".history-item").filter({ hasText: "alpha.txt" })).toHaveCount(1);
  await expect(page.locator(".history-item").filter({ hasText: "binary.bin" })).toHaveCount(1);
  expect(writes.filter((entry) => entry === "POST /api/text")).toHaveLength(1);
  expect(writes.some((entry) => entry.startsWith("POST /api/uploads"))).toBe(true);
  const alphaId = await page.locator(".history-item").filter({ hasText: "alpha.txt" }).getAttribute("data-id");
  const alpha = await context.request.get(`${preview.url}/uploads/${alphaId}/alpha.txt`);
  expect(alpha.status()).toBe(200);
  expect(await alpha.text()).toBe("alpha");
  const binaryId = await page.locator(".history-item").filter({ hasText: "binary.bin" }).getAttribute("data-id");
  const binary = await context.request.get(`${preview.url}/uploads/${binaryId}/binary.bin`);
  expect(binary.status()).toBe(200);
  expect([...new Uint8Array(await binary.body())]).toEqual([1, 2, 3]);
});

test("share target keeps oversized text editable instead of submitting it", async ({ page, context }) => {
  await loginContext(context);
  const writes = trackContentWrites(page);
  await page.goto(preview.url);
  await controlledPage(page);
  const oversized = "分享".repeat(40000);
  await submitShareForm(page, { text: oversized });
  await expect(page.locator("#text-input")).toHaveValue(oversized);
  await expect(page.locator("#text-form button[type=submit]")).toBeDisabled();
  await expect(page.locator("#notice")).toContainText("超过当前大小上限");
  expect(writes).toEqual([]);
});

test("share target allows file confirmation without submitting shared text", async ({ page, context }) => {
  await loginContext(context);
  const writes = trackContentWrites(page);
  await page.goto(preview.url);
  await controlledPage(page);
  await submitShareForm(page, { text: "keep me unsent", files: [{ name: "only.bin", type: "application/octet-stream", bytes: "payload" }] });
  await expect(page.locator("#text-input")).toHaveValue("keep me unsent");
  await page.locator("#upload").click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator(".history-item")).toContainText("only.bin");
  await expect(page.locator("#text-input")).toHaveValue("keep me unsent");
  expect(writes.some((entry) => entry === "POST /api/text")).toBe(false);
});

test("share target stages loopback cross-site form content without saving", async ({ page, context }) => {
  await loginContext(context);
  const writes = trackContentWrites(page);
  await page.goto(preview.url);
  await controlledPage(page);
  const attacker = new URL(preview.url);
  attacker.hostname = "localhost";
  await page.route(`${attacker.origin}/share`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<form id="planted" method="post" enctype="multipart/form-data" action="${preview.url}/share-target"><input name="text" value="planted text"></form>`,
  }));
  await page.goto(`${attacker.origin}/share`);
  await page.evaluate(() => document.getElementById("planted").submit()).catch(() => undefined);
  await expect(page.locator("#text-input")).toHaveValue("planted text");
  await expect(page.locator("#notice")).toContainText("已接收分享");
  await expect(page.locator(".history-item")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("share target survives sign-out and waits for confirmation after login", async ({ page, context }) => {
  const headers = await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  const writes = trackContentWrites(page);
  await context.request.post(`${preview.url}/api/logout`, { headers });
  await page.goto(`${preview.url}/login`);
  await submitShareForm(page, { text: "after login" });
  await expect(page).toHaveURL(`${preview.url}/login`);
  await expect(page.locator("#text-input")).toHaveCount(0);
  expect(writes).toEqual([]);

  await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url },
    data: { username: preview.username, password: preview.password },
  });
  await page.goto(preview.url);
  await expect(page.locator("#text-input")).toHaveValue("after login");
  await expect(page.locator("#notice")).toContainText("已接收分享");
  expect(writes).toEqual([]);
  await page.locator("#text-form button[type=submit]").click();
  await expect(page.locator(".history-item")).toHaveCount(1);
});

test("share target claims a slot only once across tabs and reloads", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  const second = await context.newPage();
  try {
    await second.goto(preview.url);
    await controlledPage(second);
    await writePendingShare(page, {
      state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000,
      title: "", text: "single claim", url: "", files: [],
    });
    await Promise.all([page.reload(), second.reload()]);
    await expect.poll(async () => (await page.locator("#text-input").inputValue()) + (await second.locator("#text-input").inputValue()))
      .toBe("single claim");
    await page.reload();
    await expect(page.locator("#text-input")).toHaveValue("");
  } finally {
    await second.close();
  }
});

test("share target reads the clock inside the storage transaction", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  const bundled = await build({
    entryPoints: ["web/share-target-store.js"], bundle: true, format: "iife",
    globalName: "easydropShareStore", target: "es2022", write: false,
  });
  await page.evaluate(bundled.outputFiles[0].text);
  const observed = await page.evaluate(async () => {
    const store = window.easydropShareStore;
    const now = Date.now();
    await store.savePendingShare({
      state: "pending", createdAt: now, expiresAt: now + 600000,
      title: "", text: "timing", url: "", files: [],
    });
    const realGet = IDBObjectStore.prototype.get;
    let getSucceeded = false;
    IDBObjectStore.prototype.get = function patchedGet(...args) {
      const request = realGet.apply(this, args);
      request.addEventListener("success", () => { if (args[0] === "pending") getSucceeded = true; });
      return request;
    };
    try {
      let clockReadAfterSuccess = null;
      const ready = await store.claimPendingShare(() => {
        clockReadAfterSuccess = getSucceeded;
        return Date.now();
      });
      await store.savePendingShare({
        state: "pending", createdAt: now, expiresAt: now + 600000,
        title: "", text: "late", url: "", files: [],
      });
      const expired = await store.claimPendingShare(() => Date.now() + 700000);
      return {
        clockReadAfterSuccess,
        readyStatus: ready.status,
        readyText: ready.text,
        expiredStatus: expired.status,
        expiredText: expired.text,
      };
    } finally {
      IDBObjectStore.prototype.get = realGet;
    }
  });
  expect(observed.clockReadAfterSuccess).toBe(true);
  expect(observed.readyStatus).toBe("ready");
  expect(observed.readyText).toBe("timing");
  expect(observed.expiredStatus).toBe("expired");
  expect(observed.expiredText).toBeUndefined();
});

test("share target reports expiry once and keeps an empty inbox silent", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  const writes = trackContentWrites(page);
  await writePendingShare(page, {
    state: "pending", createdAt: Date.now() - 700000, expiresAt: Date.now() - 100000,
    title: "", text: "expired share", url: "", files: [],
  });
  await page.reload();
  await expect(page.locator("#notice")).toHaveText("分享内容已过期（有效期为 10 分钟），请从来源应用重新分享。");
  await expect(page.locator("#text-input")).toHaveValue("");
  const tombstone = await readPendingShare(page);
  expect(tombstone).toMatchObject({ state: "expired", notified: true });
  expect(tombstone.text).toBeUndefined();
  await page.reload();
  await expect(page.locator("#notice")).toHaveText("");
  await expect(page.locator("#text-input")).toHaveValue("");
  expect(writes).toEqual([]);
});

test("share target reports expiry in English when the interface is English", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  await page.evaluate(() => localStorage.setItem("easydrop-language", "en"));
  await writePendingShare(page, {
    state: "pending", createdAt: Date.now() - 700000, expiresAt: Date.now() - 100000,
    title: "", text: "expired share", url: "", files: [],
  });
  await page.reload();
  await expect(page.locator("#notice")).toHaveText("This share expired after 10 minutes. Please share it again from the source app.");
  await expect(page.locator("#text-input")).toHaveValue("");
});

test("share target rejects unreadable and non-navigating submissions with the fallback page", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  await submitShareForm(page, { text: "plain text enctype", enctype: "text/plain" });
  await expect(page.locator("body")).toContainText("无法接收分享");
  await expect(page.locator("body")).toContainText("Unable to receive share");
  expect(await readPendingShare(page)).toBeNull();

  await page.goto(preview.url);
  await controlledPage(page);
  await submitShareForm(page);
  await expect(page.locator("body")).toContainText("无法接收分享");
  expect(await readPendingShare(page)).toBeNull();

  await page.goto(preview.url);
  await controlledPage(page);
  await page.evaluate(() => {
    const body = new FormData();
    body.append("text", "no-cors text");
    return fetch("/share-target", { method: "POST", mode: "no-cors", body }).catch(() => undefined);
  });
  expect(await readPendingShare(page)).toBeNull();
  await page.reload();
  await expect(page.locator("#text-input")).toHaveValue("");
});

test("share target explains direct visits instead of returning a JSON error", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  await writePendingShare(page, {
    state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000,
    title: "", text: "kept across a direct visit", url: "", files: [],
  });
  const direct = await page.goto(`${preview.url}/share-target`);
  expect(direct.status()).toBe(200);
  expect(direct.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator("body")).toContainText("无法接收分享");
  await expect(page.locator("body")).toContainText("Unable to receive share");
  await expect(page.locator('a[href="/"]')).toHaveCount(1);
  expect((await readPendingShare(page)).text).toBe("kept across a direct visit");
  await context.setOffline(true);
  try {
    await page.goto(`${preview.url}/share-target`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("无法接收分享");
    expect((await readPendingShare(page)).text).toBe("kept across a direct visit");
  } finally {
    await context.setOffline(false);
  }
});

test("share target shows the fallback page when local storage rejects the write", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await controlledPage(page);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => {
    self.__easydropPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException("quota", "QuotaExceededError"); };
  });
  try {
    await submitShareForm(page, { text: "quota share" });
    await expect(page.locator("body")).toContainText("无法接收分享");
    expect(await readPendingShare(page)).toBeNull();
  } finally {
    await worker.evaluate(() => {
      IDBObjectStore.prototype.put = self.__easydropPut;
      delete self.__easydropPut;
    }).catch(() => undefined);
  }
});

test("ordinary file selection still uploads without confirmation", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await page.locator("#file-input").setInputFiles([{ name: "direct.txt", mimeType: "text/plain", buffer: Buffer.from("direct") }]);
  await expect(page.locator(".history-item").filter({ hasText: "direct.txt" })).toHaveCount(1);
  await expect(page.locator("#notice")).toHaveText("上传完成");
});
