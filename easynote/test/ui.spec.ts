import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { testToken, testCsrf, testPassword, testUserId } from './runtime';

const origin = 'http://127.0.0.1:8792';
const headers = { Origin: origin, 'X-CSRF-Token': testCsrf };
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'easynote_dev', value: testToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
});
async function newNote(page: Page, title: string, content = '') {
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
  await page.getByRole('textbox', { name: '笔记正文' }).fill(content);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
}
async function disableOfflineLibrary(page: Page) {
  await page.locator('.account').click();
  const offline = page.getByRole('switch', { name: '离线笔记库' });
  await expect(offline).toHaveAttribute('aria-checked', 'true');
  const refreshed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/notes' && response.request().method() === 'GET');
  await offline.click();
  await refreshed;
  await expect(offline).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
}
async function openMobileNavigation(page: Page) {
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'EasyNote', exact: true })).toBeVisible();
  return dialog;
}
async function openFolder(page: Page, nameOrId: string | null) {
  let folders: import('../src/shared/types').Folder[] = [];
  await expect.poll(async () => {
    folders = (await (await page.request.get('/api/folders')).json()).folders;
    return nameOrId === null || folders.some((folder) => folder.id === nameOrId || folder.name === nameOrId);
  }).toBe(true);
  const path: import('../src/shared/types').Folder[] = [];
  let item = folders.find((folder) => folder.id === nameOrId || folder.name === nameOrId);
  expect(nameOrId === null || !!item).toBe(true);
  while (item && path.length < 5) {
    path.unshift(item);
    item = folders.find((folder) => folder.id === item!.parentId);
  }
  expect(item).toBeUndefined();
  // The root crumb is hidden while the list already shows the root level.
  const rootCrumb = page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true });
  if (await rootCrumb.count()) await rootCrumb.click();
  for (const folder of path) {
    const row = page.locator(`[data-folder-id="${folder.id}"]`);
    const more = page.getByRole('button', { name: '加载更多', exact: true });
    await expect.poll(async () => await row.count() > 0 || await more.isVisible()).toBe(true);
    while (await row.count() === 0) {
      const count = await page.locator('.list-scroll > [data-note-row], .list-scroll > [data-folder-id]').count();
      await more.click();
      await expect.poll(() => page.locator('.list-scroll > [data-note-row], .list-scroll > [data-folder-id]').count()).toBeGreaterThan(count);
    }
    await row.locator('.folder-open').click();
  }
}
async function folderAction(page: Page, nameOrId: string, action: string) {
  const folders = (await (await page.request.get('/api/folders')).json()).folders as import('../src/shared/types').Folder[];
  const folder = folders.find((item) => item.id === nameOrId || item.name === nameOrId)!;
  await openFolder(page, folder.parentId);
  await page.locator(`[data-folder-id="${folder.id}"] .folder-open`).press('Shift+F10');
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function createRootFolder(page: Page) {
  await openFolder(page, null);
  await page.locator('.list-create-action').click();
  await page.getByRole('menuitem', { name: '新建目录', exact: true }).click();
}
async function openMobileNoteActions(page: Page) {
  await page.getByRole('button', { name: '更多笔记操作', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '笔记操作', exact: true })).toBeVisible();
  return dialog;
}

test('adds and removes existing tags for the current note', async ({ page }) => {
  const tag = `已有标签-${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  expect((await page.request.post(`/api/notes/${id}`, {
    headers, data: { title: tag, content: '', tags: [tag], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByLabel('添加标签', { exact: true }).click();
  const existingTag = page.getByRole('checkbox', { name: tag });
  await existingTag.check();
  await expect(page.locator('.note-tag-name')).toHaveText(`#${tag}`);
  await existingTag.uncheck();
  await expect(page.locator('.note-tag-name')).toHaveCount(0);
  await page.getByPlaceholder('搜索或回车新建标签…').press('Escape');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
});

test('switches to English without mobile horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('does not render the login form while the initial session is loading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let delayed = true;
  await page.route('**/api/session', async (route) => {
    if (!delayed) { await route.continue(); return; }
    delayed = false;
    await gate;
    await route.continue();
  });
  const navigation = page.goto('/');
  await expect(page.getByRole('status')).toContainText('正在连接');
  await expect(page.getByRole('textbox', { name: '用户名' })).toBeHidden();
  release();
  await navigation;
  await expect(page.getByRole('main').getByRole('button', { name: '新建笔记', exact: true })).toBeVisible();
});

test('online startup requests the root note list and tags only once', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  let notes = 0;
  let tags = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/notes') notes++;
    else if (path === '/api/tags') tags++;
  });
  await page.reload();
  await expect(page.locator('.list-scroll')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect({ notes, tags }).toEqual({ notes: 1, tags: 1 });
});

test('cached startup remains usable while session verification and text sync are delayed', async ({ page }) => {
  await page.goto('/');
  const title = `启动缓存-${randomUUID()}`;
  await newNote(page, title, '本地正文');
  let releaseSession!: () => void;
  let releaseSync!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let sessions = 0;
  let syncStarted = false;
  await page.route('**/api/session', async (route) => {
    sessions++;
    await sessionGate;
    await route.continue();
  });
  await page.route('**/api/sync?*', async (route) => {
    syncStarted = true;
    await syncGate;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-note-row]').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('本地正文');
    await expect(page.getByText('离线', { exact: true })).toBeVisible();
    expect(sessions).toBe(1);
    expect(syncStarted).toBe(false);
    await page.getByRole('textbox', { name: '笔记标题' }).fill(`${title}-修改`);
    releaseSession();
    await expect.poll(() => syncStarted).toBe(true);
    await expect(row).toBeVisible();
    releaseSync();
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    expect(sessions).toBe(1);
  } finally { releaseSession(); releaseSync(); }
});

for (const switched of [false, true]) {
  test(`cached startup clears the old account after ${switched ? 'account switching' : 'session expiration'}`, async ({ page }) => {
    await page.goto('/');
    const title = `旧账号-${randomUUID()}`;
    await newNote(page, title, '旧账号正文');
    const session = await (await page.request.get('/api/session')).json();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/session', async (route) => {
      await gate;
      await route.fulfill({ json: {
        ...session, user: switched ? { ...session.user, id: randomUUID(), username: '切换账号' } : null,
        csrf: switched ? session.csrf : null,
      } });
    });
    // The replacement account must never receive the previous account's notes.
    await page.route('**/api/sync?*', (route) => route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } }));
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const row = page.locator('[data-note-row]').filter({ hasText: title });
      await expect(row).toBeVisible();
      release();
      await expect(row).toBeHidden();
      if (!switched) await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(async (userId) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open('easynote');
          request.onsuccess = () => resolve(request.result);
        });
        try {
          return await new Promise<boolean>((resolve) => {
            const request = db.transaction('meta').objectStore('meta').get(`session:${userId}`);
            request.onsuccess = () => resolve(request.result === undefined);
          });
        } finally { db.close(); }
      }, testUserId)).toBe(true);
    } finally { release(); }
  });
}

for (const cancel of [false, true]) {
  test(`first text sync renders notes while attachment caching ${cancel ? 'is cancelled' : 'is delayed'}`, async ({ page }) => {
    const id = randomUUID();
    const fileId = randomUUID();
    const title = `慢附件-${id}`;
    const uploaded = await page.request.put(`/api/files/${fileId}`, {
      headers: { ...headers, 'Content-Type': 'text/plain', 'X-Filename': 'slow.txt' }, data: '附件正文',
    });
    expect(uploaded.status()).toBe(201);
    expect((await page.request.post(`/api/notes/${id}`, {
      headers, data: { title, content: `[附件](/api/files/${fileId})`, tags: [], pinned: false,
        archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
    })).status()).toBe(201);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let downloading = false;
    await page.route(`**/api/files/${fileId}`, async (route) => {
      downloading = true;
      await gate;
      await route.continue();
    });
    try {
      await page.goto('/');
      await expect.poll(() => downloading).toBe(true);
      const row = page.locator('[data-note-row]').filter({ hasText: title });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
      if (cancel) {
        await disableOfflineLibrary(page);
        release();
        await expect.poll(() => page.evaluate(async (key) => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open('easynote');
            request.onsuccess = () => resolve(request.result);
          });
          try {
            return await new Promise<boolean>((resolve) => {
              const request = db.transaction('files').objectStore('files').get(key);
              request.onsuccess = () => resolve(request.result === undefined);
            });
          } finally { db.close(); }
        }, `${testUserId}:${fileId}`)).toBe(true);
      } else {
        const downloaded = page.waitForResponse((response) => response.url().endsWith(`/api/files/${fileId}`));
        release();
        await downloaded;
      }
    } finally { release(); }
  });
}

test('offline resources become ready while a page resource is still loading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/slow-page-resource', async (route) => {
    await gate;
    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const image = document.createElement('img');
      image.src = '/slow-page-resource';
      document.body.appendChild(image);
    }, { once: true });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect.poll(() => page.evaluate(async () => {
      const cache = await caches.open('easynote-pdf-v1');
      return (await cache.keys()).some((request) => request.url.endsWith('/fonts/NotoSansSC-Bold.otf'));
    }), { timeout: 15_000 }).toBe(true);
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
    await expect(page.getByText('离线 PDF 资源准备失败。', { exact: false })).toBeHidden();
  } finally { release(); }
});

test('PDF cache failures do not interrupt editing or enabling offline notes, but export reports missing resources', async ({ page, context }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/fonts/NotoSansSC-')) return Promise.resolve(new Response('Unavailable', { status: 503 }));
      return original(input, init);
    }) as typeof fetch;
  });
  const warning = () => page.waitForEvent('console', {
    predicate: (message) => message.text().includes('Offline PDF resources could not be cached.'),
  });
  const initialFailure = warning();
  await page.goto('/');
  await initialFailure;
  await newNote(page, `PDF缓存失败-${randomUUID().slice(0, 6)}`, '缓存失败时仍能编辑保存');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await disableOfflineLibrary(page);
  await page.locator('.account').click();
  const offline = page.getByRole('switch', { name: '离线笔记库' });
  const retried = warning();
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'true');
  await retried;
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: '笔记正文' }).fill('重新开启离线笔记后继续保存');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: '导出当前笔记为 PDF' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.pdf-preview-error')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '导出 PDF', exact: true })).toBeDisabled();
});

test('delayed service worker control does not show a PDF timeout while editing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
  });
  await page.goto('/');
  await newNote(page, `后台等待-${randomUUID().slice(0, 6)}`, '正常编辑');
  await page.clock.install();
  await page.clock.runFor(21_000);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(navigator.serviceWorker, 'controller');
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
  });
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('easynote-pdf-v1');
    return !!await cache.match('/fonts/NotoSansSC-Regular.otf');
  })).toBe(true);
});

test('PWA metadata, install action, app-shell cache and API exclusion work', async ({ page, context }) => {
  await page.goto('/');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toContain('manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'EasyNote', start_url: '/', scope: '/', display: 'standalone',
    theme_color: '#0071e3', background_color: '#ffffff',
  });
  expect(manifest).not.toHaveProperty('share_target');
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', type: 'image/png', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', type: 'image/png', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  for (const path of ['/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png', '/apple-touch-icon.png']) {
    const icon = await page.request.get(path);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/png');
  }
  const worker = await page.request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('javascript');
  expect(await worker.text()).toContain('easynote-pdf-v1');
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/')))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cachedUrls.some((url) => new URL(url).pathname === '/index.html')).toBe(true);
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);

  await page.evaluate(() => {
    const state = window as typeof window & { installPrompted?: boolean };
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = async () => { state.installPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });
  await page.locator('.account').click();
  await page.getByRole('button', { name: '安装 EasyNote' }).click();
  expect(await page.evaluate(() => (window as typeof window & { installPrompted?: boolean }).installPrompted)).toBe(true);
  await expect(page.getByRole('button', { name: '安装 EasyNote' })).toBeHidden();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'EasyNote' })).toBeVisible();
  await context.setOffline(false);
});

test('offline library is enabled by default and an explicit opt-out persists', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  const offline = page.getByRole('switch', { name: '离线笔记库' });
  await expect(offline).toHaveAttribute('aria-checked', 'true');
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.reload();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'false');
});

test('task center opens the source note at the unfinished task', async ({ page }) => {
  const title = `任务中心-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n\n- [x] 已完成\n- [ ] 精准定位\n\n结尾');
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('精准定位', { exact: true })).toBeVisible();
  await dialog.getByRole('button').filter({ hasText: '精准定位' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('定位：');
  await expect.poll(() => editor.locator('.cm-line').allTextContents()).toContain('定位：- [ ] 精准定位');
});

test('online task center loads cursor pages on demand, including empty pages, without duplicate tasks', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  const firstId = randomUUID(), secondId = randomUUID();
  const first = { noteId: firstId, noteTitle: '第一页', text: '第一项分页待办', line: 1, offset: 0, archived: false };
  const second = { ...first, noteId: secondId, noteTitle: '第二页', text: '第二项分页待办' };
  const cursors = [`2:${firstId}`, `1:${secondId}`];
  const requests: Array<string | null> = [];
  await page.route('**/api/tasks?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    requests.push(cursor);
    const body = cursor === null ? { tasks: [], nextCursor: cursors[0] }
      : cursor === cursors[0] ? { tasks: [first], nextCursor: cursors[1] }
      : { tasks: [first, second], nextCursor: null };
    await route.fulfill({ json: body });
  });
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const more = dialog.getByRole('button', { name: '加载更多', exact: true });
  await expect(more).toBeEnabled();
  await expect(dialog.getByText('没有未完成的待办事项')).toHaveCount(0);
  expect(requests).toEqual([null]);
  await more.click();
  await expect(dialog.getByText(first.text, { exact: true })).toBeVisible();
  await expect(dialog.getByText(second.text, { exact: true })).toHaveCount(0);
  expect(requests).toEqual([null, cursors[0]]);
  await more.click();
  await expect(dialog.getByText(second.text, { exact: true })).toBeVisible();
  await expect(dialog.getByText(first.text, { exact: true })).toHaveCount(1);
  await expect(more).toHaveCount(0);
  expect(requests).toEqual([null, ...cursors]);
});

for (const hint of [true, false]) {
  test(`task center includes unsynced drafts when navigator.onLine is ${hint}`, async ({ page }) => {
    await page.addInitScript((online) => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    }, hint);
    const task = `本机待办-${randomUUID().slice(0, 8)}`;
    await page.goto('/');
    await newNote(page, task, '原始正文');
    await expect(page.getByRole('button', { name: '同步并更新历史版本', exact: true })).toBeEnabled();
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'PUT') await route.abort('failed');
      else await route.continue();
    });
    let taskRequests = 0;
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/tasks') taskRequests++; });
    await page.getByRole('textbox', { name: '笔记正文' }).fill(`- [ ] ${task}`);
    await expect(page.getByRole('alert')).toContainText('Failed to fetch');
    await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '任务中心', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(task, { exact: true }).first()).toBeVisible();
    expect(taskRequests).toBe(0);
  });
}

test('mobile note list exposes the task center and opens a task source', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `移动任务-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n\n- [ ] 移动端待办\n\n结尾');
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('移动端待办', { exact: true })).toBeVisible();
  const task = dialog.getByRole('button').filter({ hasText: '移动端待办' });
  const alignment = await task.evaluate((button) => {
    const copy = button.querySelector<HTMLElement>('.task-center-copy')!;
    const arrow = button.querySelector<SVGElement>('svg')!;
    const buttonBox = button.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const arrowBox = arrow.getBoundingClientRect();
    return {
      leftGap: copyBox.left - buttonBox.left,
      rightGap: buttonBox.right - arrowBox.right,
      copyWidth: copyBox.width,
    };
  });
  expect(alignment.leftGap).toBeLessThan(16);
  expect(alignment.rightGap).toBeLessThan(16);
  expect(alignment.copyWidth).toBeGreaterThan(200);
  await dialog.screenshot({ path: 'test-results/mobile-task-center.png' });
  await task.click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a note share can be created, extended and cancelled from share management', async ({ page, browser }) => {
  await page.addInitScript(() => {
    let copiedText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => { copiedText = value; },
        readText: async () => copiedText,
      },
    });
  });
  const title = `安全分享-${randomUUID().slice(0, 6)}`;
  const bottomMarker = `分享页尾-${randomUUID().slice(0, 6)}`;
  const content = ['[TOC]', '公开导读段落', '## 公开目录标题', '公开正文', ...Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段内容`), bottomMarker].join('\n\n');
  await page.goto('/');
  await newNote(page, title, content);
  expect(await page.getByRole('navigation', { name: '笔记分类' }).getByRole('button').allTextContents())
    .toEqual(['全部笔记', '任务中心', '归档', '分享', '回收站']);
  await page.getByRole('button', { name: '只读分享', exact: true }).click();
  await expect(page.getByLabel('有效期').locator('option[value="permanent"]')).toHaveText('永久');
  await page.getByLabel('有效期').selectOption('24');
  await page.getByRole('button', { name: '创建链接' }).click();
  const url = await page.getByLabel('只读分享链接').inputValue();
  expect(url).toMatch(/\/shared\/[a-f0-9]{64}$/);
  const sharingDialog = page.locator('dialog[open]');
  const creationNotice = sharingDialog.locator('.dialog-feedback-anchor > .toast');
  await expect(creationNotice).toHaveText('只读分享链接已创建');
  expect(await creationNotice.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);
  const copyButton = sharingDialog.locator('.share-url button');
  const inputWidth = await page.getByLabel('只读分享链接').evaluate((element) => element.getBoundingClientRect().width);
  await copyButton.click();
  await expect(copyButton).toHaveText('已复制');
  await expect(copyButton).toHaveClass(/copy-confirmed/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  expect(await page.getByLabel('只读分享链接').evaluate((element) => element.getBoundingClientRect().width)).toBe(inputWidth);
  await expect(page.locator('.toast')).not.toHaveText('分享链接已复制');
  await sharingDialog.screenshot({ path: 'test-results/share-copy-feedback.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await sharingDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await sharingDialog.screenshot({ path: 'test-results/share-copy-feedback-320.png' });

  const anonymous = await browser.newContext({ viewport: { width: 900, height: 500 } });
  const shared = await anonymous.newPage();
  await shared.goto(url);
  await expect(shared.getByRole('heading', { name: title })).toBeVisible();
  await expect(shared.getByText('公开正文', { exact: true })).toBeVisible();
  await expect(shared.getByText('只读分享', { exact: true })).toBeVisible();
  const scroll = shared.locator('.shared-page');
  // The contents directive also renders on read-only share pages.
  const sharedContents = shared.locator('.shared-document nav.note-toc');
  await expect(sharedContents.getByRole('link', { name: '公开目录标题' })).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(shared.getByText(bottomMarker, { exact: true })).toBeVisible();
  // Dispatch the click so Playwright does not scroll the link into view first. The heading
  // starts off-screen above and must land near the top; a bare `#` navigation would instead
  // jump to the page top and leave the heading well below the viewport edge.
  const sharedHeading = shared.locator('.markdown h2').filter({ hasText: '公开目录标题' });
  await expect.poll(() => sharedHeading.evaluate((element) => element.getBoundingClientRect().top < 0)).toBe(true);
  await sharedContents.getByRole('link', { name: '公开目录标题' }).dispatchEvent('click');
  await expect.poll(() => sharedHeading.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top >= 0 && top < 120;
  })).toBe(true);
  await anonymous.close();

  await sharingDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表', exact: true }).click();
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '分享', exact: true }).click();
  const manager = page.getByRole('dialog');
  await expect(manager.getByRole('heading', { name: '分享管理', exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: title, exact: true })).toBeVisible();
  await manager.getByLabel(`${title} 延期时长`).selectOption('24');
  await manager.getByRole('button', { name: `延期 ${title}`, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('分享有效期已延长');
  expect(await manager.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await manager.screenshot({ path: 'test-results/mobile-share-management.png' });
  await manager.getByRole('button', { name: `取消分享 ${title}`, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('分享已取消');
  await expect(manager.getByText('暂无正在分享的笔记', { exact: true })).toBeVisible();
  expect((await page.request.get(url.replace('/shared/', '/api/public/shares/'))).status()).toBe(404);
});

test('success feedback expires after two seconds and restarts while failures stay dismissible', async ({ page }) => {
  await page.addInitScript(() => {
    let copiedText = '';
    (window as typeof window & { copyWrites: number }).copyWrites = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copiedText = value;
          (window as typeof window & { copyWrites: number }).copyWrites++;
        },
        readText: async () => copiedText,
      },
    });
  });
  await page.goto('/');
  await newNote(page, `反馈计时-${randomUUID().slice(0, 6)}`, '反馈计时正文');
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  await page.getByRole('button', { name: '只读分享', exact: true }).click();
  const sharingDialog = page.locator('dialog[open]');
  const notice = sharingDialog.locator('.dialog-feedback-anchor > .toast');

  await page.getByRole('button', { name: '创建链接', exact: true }).click();
  await expect(notice).toHaveText('只读分享链接已创建');
  await page.clock.runFor(1_999);
  await expect(notice).toBeVisible();
  await page.clock.runFor(1);
  await expect(notice).toHaveCount(0);

  await sharingDialog.getByRole('button', { name: '替换链接', exact: true }).click();
  await expect(notice).toHaveText('只读分享链接已创建');
  await page.clock.runFor(1_000);
  await sharingDialog.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(notice).toHaveText('分享链接已撤销');
  await page.clock.runFor(999);
  await expect(notice).toBeVisible();
  await page.clock.runFor(1);
  await expect(notice).toBeVisible();
  await page.clock.runFor(999);
  await expect(notice).toBeVisible();
  await page.clock.runFor(1);
  await expect(notice).toHaveCount(0);

  await sharingDialog.getByRole('button', { name: '创建链接', exact: true }).click();
  await expect(notice).toHaveText('只读分享链接已创建');
  await page.clock.runFor(2_000);
  await expect(notice).toHaveCount(0);
  const copyButton = sharingDialog.locator('.share-url button');
  await copyButton.click();
  await expect(copyButton).toHaveText('已复制');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { copyWrites: number }).copyWrites)).toBe(1);
  await page.clock.runFor(1_000);
  await copyButton.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { copyWrites: number }).copyWrites)).toBe(2);
  await page.clock.runFor(999);
  await expect(copyButton).toHaveText('已复制');
  await page.clock.runFor(1);
  await expect(copyButton).toHaveText('已复制');
  await page.clock.runFor(999);
  await expect(copyButton).toHaveText('已复制');
  await page.clock.runFor(1);
  await expect(copyButton).toHaveText('复制');

  await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/api/notes/*/share', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'share failed' } }),
      });
    } else await route.continue();
  });
  await sharingDialog.getByRole('button', { name: '替换链接', exact: true }).click();
  const failure = sharingDialog.locator('.dialog-feedback-anchor > [role="alert"]');
  await expect(failure).toContainText('share failed');
  await page.clock.runFor(10_000);
  await expect(failure).toBeVisible();
  expect(await sharingDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await failure.getByRole('button', { name: '关闭错误', exact: true }).click();
  await expect(failure).toHaveCount(0);
});

test('dialog errors remain visible above the backdrop on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '管理标签', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('输入新标签名称…').fill('无效,标签');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const alert = dialog.locator('.dialog-feedback-anchor > [role="alert"]');
  await expect(alert).toContainText('标签必须为 1-40 个字符，且不能包含逗号。');
  expect(await alert.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(alert).toBeVisible();
  await dialog.screenshot({ path: 'test-results/mobile-dialog-error-feedback.png' });
});

test('an external PWA launch restores the session through the same-origin bootstrap request', async ({ page }) => {
  await page.route('https://launcher.example.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<a href="${origin}/">Open EasyNote</a>`,
  }));
  await page.goto('https://launcher.example.test/');
  await page.getByRole('link', { name: 'Open EasyNote' }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator('.account')).toContainText('tester');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeHidden();
});

test('AI integration tokens can be created once, listed and revoked', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByLabel('名称').fill('桌面 AI');
  await page.getByLabel('有效期').selectOption('permanent');
  await page.getByRole('button', { name: '创建令牌' }).click();
  await expect(page.getByText('令牌仅显示一次')).toBeVisible();
  await expect(page.locator('.token-secret > code').first()).toHaveText(/^enai_[a-f0-9]{64}$/);
  await expect(page.locator('.token-secret > code').nth(1)).toContainText('[mcp_servers.easynote]');
  await expect(page.getByText('桌面 AI', { exact: true })).toBeVisible();
  await expect(page.getByText('读取和写入 · 永久有效', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-ai-access.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-ai-access.png', fullPage: true });
  await page.locator('.token-row').filter({ hasText: '桌面 AI' }).getByRole('button', { name: '桌面 AI', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('桌面 AI', { exact: true })).toBeHidden();
});

test('administrator user management creates and removes an isolated tenant', async ({ page }) => {
  const username = `ui-user-${randomUUID().slice(0, 7)}`;
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('button', { name: '管理用户', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('tester（当前）', { exact: true })).toBeVisible();
  await dialog.getByLabel('新用户用户名').fill(username);
  await dialog.getByLabel('新用户密码').fill('UI-Managed-Password-482!');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog.getByText(username, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: `删除用户 ${username}` }).click();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(dialog.getByText(username, { exact: true })).toBeHidden();
});

test('create, autosave, reload, edit Markdown and preview safely', async ({ page }) => {
  const title = `读书记录-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/easynote-icon.svg');
  const icon = await page.request.get('/easynote-icon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
  expect(await icon.text()).toContain('fill="#0071e3"');
  await newNote(page, title, '# 本周阅读\n\n记录一些值得留下的想法。\n\n- 保持简单\n- 定期整理\n\n<script>alert(1)</script>');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const automaticHistory = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(automaticHistory.versions).toHaveLength(0);
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  const history = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(history.versions).toHaveLength(1);
  await page.reload();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('本周阅读');
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('heading', { name: '本周阅读' })).toBeVisible();
  await expect(page.locator('.markdown script')).toHaveCount(0);
  const documentLayout = () => page.locator('.document').evaluate((element) => {
    const container = element.parentElement!;
    const style = getComputedStyle(container);
    const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const documentBox = element.getBoundingClientRect();
    const containerBox = container.getBoundingClientRect();
    return {
      availableWidth,
      leftGap: documentBox.left - containerBox.left - parseFloat(style.paddingLeft),
      width: documentBox.width,
      widthRatio: documentBox.width / availableWidth,
    };
  });
  const mediumLayout = await documentLayout();
  expect(Math.abs(mediumLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(mediumLayout.widthRatio).toBeCloseTo(1, 2);
  await page.setViewportSize({ width: 2000, height: 960 });
  const readableLayout = await documentLayout();
  expect(Math.abs(readableLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(readableLayout.width).toBeCloseTo(900, 0);
  await page.getByRole('button', { name: '使用宽屏' }).click();
  await expect(page.getByRole('button', { name: '使用阅读宽度' })).toHaveAttribute('aria-pressed', 'true');
  const wideLayout = await documentLayout();
  expect(wideLayout.width).toBeCloseTo(1080, 0);
  expect(await page.evaluate(() => localStorage.getItem('easynote-document-width'))).toBe('wide');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('footnotes, lazy code highlighting and precise source switching work', async ({ page }) => {
  const content = [
    '## 起点',
    '',
    '开头段落。',
    '',
    '```javascript',
    'const answer = 42;',
    '```',
    '',
    '## 目标',
    '',
    '精准目标段落[^detail]',
    '',
    '[^detail]: 脚注正文。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, `阅读增强-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '阅读模式' }).click();

  const preview = page.locator('.document .markdown');
  await expect(preview.locator('a[data-footnote-ref="1"]')).toHaveText('[1]');
  await expect(preview.locator('[data-footnote-id="1"]')).toContainText('脚注正文。');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-keyword')).toHaveText('const');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-number')).toHaveText('42');

  await preview.locator('p[data-source-line]').filter({ hasText: '精准目标段落' }).dblclick();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('定位：');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：精准目标段落[^detail]');

  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: '阅读模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+e');
  await expect(editor).toBeFocused();
  await page.keyboard.type('继续');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：继续精准目标段落[^detail]');
});

test('a note contents directive builds a clickable table of contents', async ({ page }) => {
  const filler = Array.from({ length: 30 }, (_, index) =>
    `补充段落 ${index + 1}：正文需要足够长，才能检验目录跳转是否真的滚动了预览。`).join('\n\n');
  const content = [
    '[TOC]',
    '',
    '开头说明段落，其中提到了 [TOC] 的写法。',
    '',
    '# 第一章',
    '',
    filler,
    '',
    '### 1.1 小节',
    '',
    '小节正文。',
    '',
    '## 回到二级',
    '',
    '二级正文。',
    '',
    '> ## 引用里的标题',
    '',
    '```md',
    '[TOC]',
    '```',
  ].join('\n');
  await page.goto('/');
  await newNote(page, `目录-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '阅读模式' }).click();

  const preview = page.locator('.document .markdown');
  const contents = preview.locator('nav.note-toc');
  await expect(contents).toHaveCount(1);
  await expect(contents).toHaveAttribute('aria-label', '笔记目录');
  await expect(contents.getByRole('link')).toHaveText(['第一章', '1.1 小节', '回到二级']);
  // 跳级标题（一级 → 三级 → 二级）合并进同一个子列表，缩进结构保持连续。
  await expect(contents.locator('ol > li > ol')).toHaveCount(1);
  await expect(contents.locator('ol > li > ol > li')).toHaveCount(2);
  await expect(contents.locator('ol').first()).toHaveCSS('list-style-type', 'none');
  await expect(contents.locator('ol > li > ol')).toHaveCSS('list-style-type', 'none');
  await expect(contents.locator('ol > li > ol')).toHaveCSS('padding-left', '18px');
  // 引用块里的标题不算正文标题；代码块与行内提到的 [TOC] 保持原样。
  await expect(preview.locator('blockquote h2')).toHaveText('引用里的标题');
  await expect(preview.locator('pre code')).toContainText('[TOC]');
  await expect(preview.locator('p').filter({ hasText: '开头说明段落' })).toContainText('[TOC]');
  await page.locator('.document-scroll').evaluate((element) => element.scrollTo(0, 0));
  await expect(contents).toBeInViewport();
  await page.screenshot({ path: 'test-results/note-toc.png' });

  // 搜索命中 [TOC] 指令文本时目录块仍然生成：目录注入必须先于搜索高亮。
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('toc');
  await expect(contents).toHaveCount(1);
  await expect(contents.getByRole('link')).toHaveText(['第一章', '1.1 小节', '回到二级']);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('');
  await expect(contents).toHaveCount(1);

  await page.locator('.document-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const heading = preview.getByRole('heading', { name: '第一章', exact: true });
  await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().top < 0)).toBe(true);
  await contents.getByRole('link', { name: '第一章' }).click();
  await expect.poll(() => heading.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight;
  })).toBe(true);

  await page.getByRole('textbox', { name: '笔记标题' }).press('Meta+p');
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('region', { name: 'PDF 分页预览' })
    .getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  const template = page.locator('.print-document');
  await expect(template.locator('nav.note-toc')).toHaveCount(1);
  await expect(template.locator('a[data-toc-target]')).toHaveCount(3);
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '导出 PDF' }).click();
  const pdf = await readFile((await (await downloadPromise).path())!);
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  // 目录文字确实写进 PDF：每个标题在导出的文本里出现两次（目录一次、正文一次）。
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfDocument = await getDocument({ data: new Uint8Array(pdf) }).promise;
  let pdfText = '';
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const textContent = await (await pdfDocument.getPage(pageNumber)).getTextContent();
    pdfText += textContent.items.map((item) => 'str' in item ? item.str : '').join('');
  }
  await pdfDocument.destroy();
  expect(pdfText.split('第一章').length - 1).toBe(2);
  expect(pdfText.split('回到二级').length - 1).toBe(2);
});

test('an empty contents directive reports that there are no headings', async ({ page }) => {
  await page.goto('/');
  // 空标题（`## ` 渲染为 <h2></h2>）不进入目录，也不能借用笔记级文案。
  await newNote(page, `空目录-${randomUUID().slice(0, 6)}`, '[TOC]\n\n## \n\n只有正文，没有标题。');
  await page.getByRole('button', { name: '阅读模式' }).click();
  const contents = page.locator('.document .markdown nav.note-toc');
  await expect(contents.locator('.note-toc-empty')).toHaveText('没有标题');
  await expect(contents.getByRole('link')).toHaveCount(0);
  await expect(contents).not.toContainText('未命名笔记');
});

test('restoring a content version preserves the current pin state', async ({ page }) => {
  const id = randomUUID();
  const title = `版本置顶-${id.slice(0, 6)}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '旧正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(), createVersion: true,
    },
  });
  expect(created.status()).toBe(201);
  const updated = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 1, operationId: randomUUID(), createVersion: false,
    },
  });
  expect(updated.status()).toBe(200);
  const pinned = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: true, archived: false,
      deletedAt: null, revision: 2, operationId: randomUUID(), createVersion: false,
    },
  });
  expect(pinned.status()).toBe(200);

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '取消置顶' })).toBeVisible();
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const history = page.getByRole('dialog');
  await expect(history.getByText('修订 3', { exact: false })).toBeHidden();
  await history.getByRole('button').filter({ hasText: '修订 1' }).click();
  await history.getByRole('button', { name: '恢复此版本' }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/notes/${id}`);
    return (await response.json()).note;
  }).toMatchObject({ content: '旧正文', pinned: true, revision: 4 });
  const versions = await (await page.request.get(`${origin}/api/notes/${id}/versions`)).json();
  expect(versions.versions.map((version: { revision: number }) => version.revision)).toEqual([3, 1]);
  expect(versions.versions[0].content).toBe('新正文');
});

test('Mermaid flowcharts, mindmaps and sanitized HTML blocks render safely', async ({ page }) => {
  let externalRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'example.com') externalRequests++;
  });
  const example = await readFile(new URL('../examples/mermaid-html-demo.md', import.meta.url), 'utf8');
  const unsafeHtml = [
    '<section style="position:fixed" onclick="window.htmlBlockExecuted=true">',
    '  <h2>安全清洗测试</h2>',
    '  <a href="javascript:alert(1)">危险链接</a>',
    '  <img src="https://example.com/tracker.png" onerror="window.htmlBlockExecuted=true">',
    '  <script>window.htmlBlockExecuted=true</script>',
    '</section>',
  ].join('\n');
  const styledDiagram = [
    '```mermaid',
    'graph TD',
    '  subgraph people[个人及出资方]',
    '    founder([Founder])',
    '  end',
    '  subgraph company[企业架构]',
    '    operator[有限责任公司]',
    '    pool{有限合伙企业}',
    '  end',
    '  founder ==>|出资| pool',
    '  operator -.->|管理| pool',
    '  classDef company fill:#e1f5fe,stroke:#01579b,stroke-width:2px',
    '  classDef pool fill:#ffecb3,stroke:#ff8f00,stroke-width:2px',
    '  class operator company',
    '  class pool pool',
    '```',
  ].join('\n');
  const shapedMindmap = [
    '```mermaid',
    'mindmap',
    '  root((Root))',
    '    square[Square]',
    '    rounded(Rounded)',
    '    circle((Circle))',
    '    bang))Bang((',
    '    cloud)Cloud(',
    '    hexagon{{Hexagon}}',
    '```',
  ].join('\n');
  const content = `${example}\n\n${styledDiagram}\n\n${shapedMindmap}\n\n${unsafeHtml}`;
  await page.goto('/');
  await newNote(page, `图表与HTML-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '阅读模式' }).click();

  const diagrams = page.locator('.mermaid-diagram svg');
  await expect(diagrams).toHaveCount(4, { timeout: 15000 });
  const sizes = await diagrams.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, nodes: element.querySelectorAll('path, rect, circle, text').length };
  }));
  expect(sizes.every((size) => size.width > 80 && size.height > 40 && size.nodes > 2)).toBe(true);
  // Pele renders with links/images disabled, so no diagram may reference an
  // external resource; and DOMPurify must keep the SVG accessibility role.
  expect(await diagrams.evaluateAll((elements) =>
    elements.flatMap((element) => [...element.querySelectorAll('[href], [xlink\\:href], image')])
      .map((node) => node.getAttribute('href') ?? node.getAttribute('xlink:href') ?? 'image')
  )).toEqual([]);
  await expect(diagrams.first()).toHaveAttribute('role', 'graphics-document document');
  const scrollMetrics = await page.locator('.mermaid-diagram').evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      svgWidth: element.querySelector('svg')!.getBoundingClientRect().width,
      viewBoxWidth: element.querySelector('svg')!.viewBox.baseVal.width,
    }))
  );
  expect(scrollMetrics.every(({ clientWidth, scrollWidth, svgWidth, viewBoxWidth }) =>
    scrollWidth <= clientWidth + 1
    && Math.abs(svgWidth - Math.min(clientWidth, Math.ceil(viewBoxWidth))) <= 1
  )).toBe(true);
  const mindmapRootAlignment = await diagrams.nth(1).evaluate((svg) => {
    const rootNode = svg.querySelector<SVGGElement>('.pele-node.pele-root');
    const label = rootNode?.querySelector<SVGGraphicsElement>('text');
    const root = rootNode?.querySelector<SVGGraphicsElement>('circle, rect, polygon, ellipse');
    if (!label || !root) return null;
    const labelBox = label.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    return {
      x: Math.abs(labelBox.x + labelBox.width / 2 - (rootBox.x + rootBox.width / 2)),
      y: Math.abs(labelBox.y + labelBox.height / 2 - (rootBox.y + rootBox.height / 2)),
    };
  });
  expect(mindmapRootAlignment).not.toBeNull();
  expect(mindmapRootAlignment!.x).toBeLessThanOrEqual(2);
  expect(mindmapRootAlignment!.y).toBeLessThanOrEqual(2);
  const mindmapLabelAlignments = await diagrams.nth(1).evaluate((svg) =>
    [...svg.querySelectorAll<SVGGElement>('.pele-node')].map((node) => {
      const label = node.querySelector<SVGGraphicsElement>('text');
      const shape = node.querySelector<SVGGraphicsElement>('circle, rect, polygon, ellipse');
      if (!label || !shape) return null;
      const labelBox = label.getBoundingClientRect();
      const shapeBox = shape.getBoundingClientRect();
      return {
        x: Math.abs(labelBox.x + labelBox.width / 2 - (shapeBox.x + shapeBox.width / 2)),
        y: Math.abs(labelBox.y + labelBox.height / 2 - (shapeBox.y + shapeBox.height / 2)),
      };
    }).filter((entry): entry is { x: number; y: number } => entry !== null)
  );
  expect(mindmapLabelAlignments.length).toBeGreaterThan(0);
  expect(mindmapLabelAlignments.every(({ x, y }) => x <= 2 && y <= 2)).toBe(true);
  // Pele renders shape-less mindmap leaves ("Markdown", "HTML Block") as
  // `.pele-shape-text` nodes with no background shape, so the check above skips
  // them. Their label is drawn at the node frame origin (x=0, text-anchor=middle),
  // so assert both leaves exist and stay centred on that origin.
  const mindmapTextLeafAlignments = await diagrams.nth(1).evaluate((svg) =>
    ['Markdown', 'HTML Block'].map((text) => {
      const node = [...svg.querySelectorAll<SVGGElement>('.pele-node')]
        .find((candidate) => candidate.querySelector('text')?.textContent?.trim() === text);
      const label = node?.querySelector<SVGGraphicsElement>('text');
      const frame = node?.getScreenCTM();
      if (!label || !frame) return null;
      const labelBox = label.getBoundingClientRect();
      return {
        text,
        x: Math.abs(labelBox.x + labelBox.width / 2 - frame.e),
        y: Math.abs(labelBox.y + labelBox.height / 2 - frame.f),
      };
    })
  );
  expect(mindmapTextLeafAlignments).not.toContain(null);
  expect(mindmapTextLeafAlignments.every((entry) => entry !== null && entry.x <= 2 && entry.y <= 2)).toBe(true);
  const shapedMindmapAnchors = await diagrams.nth(3).evaluate((svg) =>
    [...svg.querySelectorAll<SVGGElement>('.pele-node')].map((node) => ({
      label: node.querySelector('text')?.textContent?.trim() ?? '',
      anchor: getComputedStyle(node.querySelector('text')!).textAnchor,
    }))
  );
  expect(shapedMindmapAnchors).toHaveLength(7);
  expect(shapedMindmapAnchors.every(({ label, anchor }) => label && anchor === 'middle')).toBe(true);
  const styled = diagrams.nth(2);
  await expect(styled).toHaveClass(/pele-flowchart/);
  expect(await styled.locator('.pele-node.company rect').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(225, 245, 254)');
  expect(await styled.locator('.pele-node.pool polygon').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(255, 236, 179)');
  // Light theme maps --pele-surface-alt to --hover (#e8e8ed); the old
  // expectation pinned Pele's built-in fallback (#e6e6e6).
  expect(await styled.locator('.pele-cluster rect').first().evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(232, 232, 237)');
  expect(await styled.locator('.pele-node').first().evaluate((element) => getComputedStyle(element).filter))
    .toBe('none');
  await expect(page.getByRole('heading', { name: 'HTML Block' })).toBeVisible();
  await expect(page.getByText('这是一段由 HTML 渲染的内容', { exact: false })).toBeVisible();
  const section = page.locator('.markdown section').filter({ hasText: '安全清洗测试' });
  await expect(section).not.toHaveAttribute('style');
  await expect(section).not.toHaveAttribute('onclick');
  await expect(page.locator('.markdown script, .markdown iframe, .markdown form')).toHaveCount(0);
  await expect(page.locator('.markdown img')).toHaveCount(0);
  await expect(page.locator('.blocked-image')).toHaveText('[外部图片未加载]');
  await expect(page.locator('.markdown a').filter({ hasText: '危险链接' })).not.toHaveAttribute('href');
  expect(await page.evaluate(() => Boolean((window as typeof window & { htmlBlockExecuted?: boolean }).htmlBlockExecuted))).toBe(false);
  expect(externalRequests).toBe(0);
  await page.screenshot({ path: 'test-results/desktop-diagrams-html.png', fullPage: true });
  await page.locator('.account').click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.mermaid-diagram svg')).toHaveCount(4, { timeout: 15000 });
  // Dark theme maps --pele-surface to --elevated (#2c2c2e).
  expect(await page.locator('.mermaid-diagram svg .pele-node rect').first().evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(44, 44, 46)');
  await page.screenshot({ path: 'test-results/desktop-diagrams-dark.png', fullPage: true });
});

test('a broken diagram renders an inline error instead of failing the preview', async ({ page }) => {
  const content = [
    '```mermaid', 'flowchart LR', ' A --> B', '```', '',
    '```mermaid', 'not a diagram at all', '```', '',
    '```mermaid', 'flowchart LR', ' B --> C', '```', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, `图表错误-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '阅读模式' }).click();

  await expect(page.locator('.document .mermaid-diagram svg')).toHaveCount(2, { timeout: 15000 });
  const errors = page.locator('.document .mermaid-error');
  await expect(errors).toHaveCount(1);
  await expect(errors).toHaveText(/图表无法渲染/);
  await expect(page.locator('.document [data-mermaid-source]')).toHaveCount(0);
});

test('Mermaid diagrams can be saved as standalone SVG and PNG images', async ({ page }) => {
  const title = `图表/导出:${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, [
    '```mermaid',
    'flowchart LR',
    '  A[原始图表] --> B[保存图片]',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  Solo',
    '```',
  ].join('\n'));
  await page.getByRole('button', { name: '阅读模式' }).click();

  const diagram = page.locator('.document .mermaid-diagram').first();
  const narrowDiagram = page.locator('.document .mermaid-diagram').nth(1);
  await expect(page.locator('.document .mermaid-diagram svg')).toHaveCount(2, { timeout: 15_000 });
  const svgButton = diagram.getByRole('button', { name: '将图表另存为 SVG' });
  const pngButton = diagram.getByRole('button', { name: '将图表另存为 PNG' });
  await expect(svgButton).toBeVisible();
  await expect(pngButton).toBeVisible();
  await diagram.hover();
  await expect(diagram.locator('.diagram-export-actions')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/mermaid-save-actions.png' });

  const svgDownloadPromise = page.waitForEvent('download');
  await svgButton.click();
  const svgDownload = await svgDownloadPromise;
  expect(svgDownload.suggestedFilename()).toContain('-diagram-1.svg');
  expect(svgDownload.suggestedFilename()).not.toMatch(/[\\/:]/);
  const svg = await readFile((await svgDownload.path())!, 'utf8');
  expect(svg).toMatch(/^<svg\b/);
  expect(svg).toContain('http://www.w3.org/2000/svg');
  expect(svg).toContain('--pele-bg:');
  const svgStyle = /<svg\b[^>]*\bstyle="([^"]*)"/.exec(svg)?.[1] ?? '';
  expect(svgStyle).not.toMatch(/--pele-[a-z-]+:\s*var\(/);
  expect(svg).toContain('原始图表');
  expect(svg).not.toMatch(/<image\b/);

  const pngDownloadPromise = page.waitForEvent('download');
  await pngButton.click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toContain('-diagram-1.png');
  await pngDownload.saveAs('test-results/mermaid-diagram-export.png');
  const png = await readFile('test-results/mermaid-diagram-export.png');
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.length).toBeGreaterThan(1_000);

  // A valid single-node diagram is only ~64px wide; its controls must stay inside the page.
  await narrowDiagram.hover();
  const narrowBox = (await narrowDiagram.boundingBox())!;
  const narrowActions = (await narrowDiagram.locator('.diagram-export-actions').boundingBox())!;
  expect(narrowActions.x).toBeGreaterThanOrEqual(narrowBox.x);
  expect(narrowActions.x + narrowActions.width).toBeLessThanOrEqual(narrowBox.x + narrowBox.width + 1);

  // Touch layouts place full-size controls below the diagram instead of relying on hover.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowControls = narrowDiagram.locator('.diagram-export-actions');
  await expect(narrowControls).toHaveCSS('opacity', '1');
  await expect(narrowControls).toHaveCSS('position', 'static');
  const narrowButton = narrowDiagram.getByRole('button', { name: '将图表另存为 PNG' });
  const narrowButtonBox = (await narrowButton.boundingBox())!;
  expect(narrowButtonBox.width).toBeGreaterThanOrEqual(44);
  expect(narrowButtonBox.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'test-results/mermaid-save-actions-mobile.png' });

  // Encoding errors are visible and do not leave the export button stuck disabled.
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback) { callback(null); };
  });
  await narrowButton.click();
  await expect(narrowDiagram.getByRole('alert')).toContainText('图表图片保存失败');
  await expect(narrowButton).toBeEnabled();
});

test('the preview renders at most 20 diagrams and reports the rest as errors', async ({ page }) => {
  const content = [...Array(21)].flatMap((_, index) => [
    '```mermaid', 'flowchart LR', ` N${index}[节点${index}] --> M${index}[节点${index}]`, '```', '',
  ]).join('\n');
  await page.goto('/');
  await newNote(page, `图表上限-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '阅读模式' }).click();

  await expect(page.locator('.document .mermaid-diagram svg')).toHaveCount(20, { timeout: 30000 });
  const errors = page.locator('.document .mermaid-error');
  await expect(errors).toHaveCount(1);
  await expect(errors).toHaveText(/20 个/);
});

test('new note reopens the existing completely blank note', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const first = await (await page.request.get('/api/notes/blank')).json();
  expect(first.note?.id).toBeTruthy();

  await page.reload();
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill('复用空白笔记');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const reused = await (await page.request.get(`/api/notes/${first.note.id}`)).json();
  expect(reused.note.title).toBe('复用空白笔记');
  expect((await (await page.request.get('/api/notes/blank')).json()).note).toBeNull();
});

test('a recovered empty local draft merges into the existing cloud blank note', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'POST') await route.abort();
    else await route.continue();
  });
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await page.unroute('**/api/notes/*');

  const cloudId = randomUUID();
  const created = await page.request.post(`${origin}/api/notes/${cloudId}`, {
    headers,
    data: {
      title: '', content: '', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes/blank')).json()).note.id).toBe(cloudId);
  const draftKeys = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('easynote');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
  });
  expect(draftKeys).toEqual([]);
});

test('unsaved local draft survives refresh and syncs only after explicit retry', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  const title = `草稿恢复-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '云端版本');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fetch();
      await route.abort('failed');
    }
    else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('网络失败之后的本地草稿');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/notes/*');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('网络失败之后的本地草稿');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const history = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(history.versions).toHaveLength(1);
});

test('non-overlapping edits from two devices merge automatically', async ({ page }) => {
  const title = `自动合并-${randomUUID().slice(0, 6)}`;
  const baseContent = '# 记录\n\n云端段落\n\n保持不变\n\n本机段落\n';
  await page.goto('/');
  await newNote(page, title, baseContent);
  const list = await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`);
  const note = (await list.json()).notes[0];
  await page.getByRole('textbox', { name: '笔记正文' })
    .fill('# 记录\n\n云端段落\n\n保持不变\n\n本机更新的段落\n');
  const remote = await page.request.put(`/api/notes/${note.id}`, {
    headers,
    data: {
      title,
      content: '# 记录\n\n云端更新的段落\n\n保持不变\n\n本机段落\n',
      tags: [],
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: note.revision,
      operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '检测到版本冲突' })).toBeHidden();
  await expect.poll(async () =>
    (await (await page.request.get(`/api/notes/${note.id}`)).json()).note.content,
  ).toBe('# 记录\n\n云端更新的段落\n\n保持不变\n\n本机更新的段落\n');
});

test('overlapping remote edits remain visible and can be preserved as a copy', async ({ page }) => {
  const title = `双端编辑-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '初始内容');
  const list = await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`);
  const note = (await list.json()).notes[0];
  await page.getByRole('textbox', { name: '笔记正文' }).fill('当前设备的内容');
  const remote = await page.request.put(`/api/notes/${note.id}`, {
    headers, data: { title, content: '另一台设备的内容', tags: [], pinned: false, archived: false, deletedAt: null, revision: note.revision, operationId: randomUUID() },
  });
  expect(remote.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '检测到版本冲突' })).toBeVisible();
  const conflict = page.getByRole('dialog');
  await expect(conflict.getByText('当前设备的内容', { exact: true })).toBeVisible();
  await expect(conflict.getByText('另一台设备的内容', { exact: true })).toBeVisible();
  await conflict.screenshot({ path: 'test-results/desktop-conflict-resolution.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-conflict-resolution.png', fullPage: true });
  await conflict.getByRole('button', { name: '另存副本' }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(`${title} (冲突副本)`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const original = await (await page.request.get(`/api/notes/${note.id}`)).json();
  expect(original.note.content).toBe('另一台设备的内容');
});

test('two clients receive create, trash and purge changes without waiting for polling', async ({ page, browser }) => {
  const otherContext = await browser.newContext();
  await otherContext.addCookies([{
    name: 'easynote_dev',
    value: testToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  const other = await otherContext.newPage();
  try {
    const firstSocket = page.waitForEvent('websocket');
    const secondSocket = other.waitForEvent('websocket');
    await Promise.all([page.goto('/'), other.goto('/')]);
    await Promise.all([firstSocket, secondSocket]);

    const title = `实时同步-${randomUUID().slice(0, 6)}`;
    await newNote(page, title, '由第一台设备创建');
    await expect(other.getByRole('button').filter({ hasText: title })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '移入回收站' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '移入回收站' }).click();
    await expect(other.getByRole('button').filter({ hasText: title })).toBeHidden({ timeout: 5000 });

    await other.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(other.getByRole('button').filter({ hasText: title })).toBeVisible();
    const trash = await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(title)}`)).json();
    const purged = await page.request.delete(`${origin}/api/notes/${trash.notes[0].id}`, {
      headers,
      data: { revision: trash.notes[0].revision },
    });
    expect(purged.status()).toBe(200);
    await expect(other.getByRole('button').filter({ hasText: title })).toBeHidden({ timeout: 5000 });
  } finally {
    await otherContext.close();
  }
});

test('images render, export includes bytes, and import creates a readable copy', async ({ page }) => {
  const title = `图片备份-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  const untitledId = randomUUID();
  const untitled = await page.request.post(`${origin}/api/notes/${untitledId}`, {
    headers,
    data: {
      title: '', content: '没有标题的导出笔记', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(untitled.status()).toBe(201);
  await newNote(page, title, '## 工作记录\n\n一张保存在私有空间的图片。');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: '笔记截图.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.locator('.markdown img')).toBeVisible();
  await expect.poll(() => page.locator('.markdown img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: 'test-results/desktop-image.png', fullPage: true });
  await page.getByRole('main').getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);
  await page.locator('.account').click();
  await page.getByText('查看导入格式示例', { exact: true }).click();
  await expect(page.getByText('请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。', { exact: true })).toBeVisible();
  await expect(page.locator('.import-guide pre').first()).toContainText('示例笔记.md');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"format": "easynote"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"path": "notes/示例笔记.md"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"archived": false');
  await page.screenshot({ path: 'test-results/import-guide.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']));
  expect(manifest.version).toBe(3);
  expect(manifest.notes.find((entry: { title: string }) => entry.title === title)).toMatchObject({
    path: `notes/${title}.md`,
    pinned: false, archived: true, deletedAt: null, position: expect.any(Number),
  });
  expect(manifest.notes.find((entry: { id: string }) => entry.id === untitledId).path)
    .toBe('notes/未命名.md');
  expect(new Set(manifest.notes.map((entry: { path: string }) => entry.path.toLocaleLowerCase('en-US'))).size)
    .toBe(manifest.notes.length);
  await expect(page.getByText('备份已下载', { exact: true })).toBeVisible();
  await page.locator('input[accept=".zip,.md,.markdown,.txt"]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: await readFile(path!) });
  await expect(page.locator('.toast')).toContainText('未导入：', { timeout: 30000 });
  await expect(page.locator('.toast')).toContainText('笔记已存在');
  const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
  expect(result.notes.length).toBe(1);

  const standaloneTitle = `正文标题-${randomUUID().slice(0, 6)}`;
  const standaloneContent = `# ${standaloneTitle}\n\n标题来自正文，而不是文件名。`;
  const importInput = page.locator('input[accept=".zip,.md,.markdown,.txt"]');
  const standaloneFile = {
    name: `${randomUUID()}.md`, mimeType: 'text/markdown', buffer: Buffer.from(standaloneContent),
  };
  let duplicateLookups = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/notes/duplicates') duplicateLookups++;
  });
  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  expect(duplicateLookups).toBe(1);
  await expect.poll(async () => {
    const notes = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
    return notes.notes.some((note: { title: string }) => note.title === standaloneTitle);
  }).toBe(true);

  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  expect(duplicateLookups).toBe(1);
  const duplicates = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
  expect(duplicates.notes.filter((note: { title: string }) => note.title === standaloneTitle)).toHaveLength(1);

  const emptyFile = { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.from('') };
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  expect(duplicateLookups).toBe(2);
  const blank = await (await page.request.get('/api/notes/blank')).json();
  expect(blank.note?.id).toBeTruthy();
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  expect(duplicateLookups).toBe(2);
  expect((await (await page.request.get('/api/notes/blank')).json()).note.id).toBe(blank.note.id);
});

test('generic Obsidian ZIP imports frontmatter and rewrites wiki links', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const linkedTitle = `关联笔记-${marker}`;
  const mainTitle = `入口笔记-${marker}`;
  const archive = zipSync({
    [`Vault/${linkedTitle}.md`]: strToU8(`# ${linkedTitle}\n\n被链接内容`),
    [`Vault/${mainTitle}.md`]: strToU8(`---\ntags: [迁移, Obsidian]\n---\n# ${mainTitle}\n\n参见 [[${linkedTitle}]]`),
  });
  const existingId = randomUUID();
  expect((await page.request.post(`${origin}/api/notes/${existingId}`, {
    headers,
    data: {
      title: linkedTitle, content: `# ${linkedTitle}\n\n被链接内容`, tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);
  await page.goto('/');
  await page.locator('.account').click();
  await page.locator('input[accept=".zip,.md,.markdown,.txt"]').setInputFiles({
    name: 'obsidian.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(archive),
  });
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇，跳过 1 篇重复笔记');
  const linked = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(linkedTitle)}`)).json()).notes
    .find((item: { title: string }) => item.title === linkedTitle);
  const main = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(mainTitle)}`)).json()).notes
    .find((item: { title: string }) => item.title === mainTitle);
  expect(linked.id).toBe(existingId);
  expect(main.tags).toEqual(['迁移', 'Obsidian']);
  const imported = (await (await page.request.get(`/api/notes/${main.id}`)).json()).note;
  expect(imported.content).toContain(`[[${linked.id}|${linkedTitle}]]`);
});

test('mobile navigation, pin, archive, trash and restore remain usable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const title = `手机笔记-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '手机上的简短记录');
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.locator('.note-row-meta time').first()).toBeVisible();
  await page.getByRole('button').filter({ hasText: title }).click();
  let actions = await openMobileNoteActions(page);
  const syncVersion = actions.getByRole('button', { name: '同步并更新历史版本', exact: true });
  await expect(syncVersion).toBeVisible();
  expect(await syncVersion.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  await actions.screenshot({ path: 'test-results/mobile-note-actions.png' });
  await actions.getByRole('button', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '归档', exact: true }).click();
  actions = await openMobileNoteActions(page);
  await expect(actions.getByRole('button', { name: '取消归档', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  let navigation = await openMobileNavigation(page);
  expect(await navigation.getByRole('navigation', { name: '移动端笔记分类' }).getByRole('button').allTextContents())
    .toEqual(['全部笔记', '任务中心', '归档', '分享', '回收站']);
  await expect(navigation.getByRole('button', { name: '同步全部', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '同步并更新历史版本', exact: true })).toHaveCount(0);
  await navigation.screenshot({ path: 'test-results/mobile-navigation.png' });
  await navigation.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '取消归档', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已移入回收站');
  await expect(page.locator('.trash-banner')).toBeHidden();
  const back = page.getByRole('button', { name: '返回笔记列表' });
  if (await back.isVisible()) await back.click();
  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.locator('.trash-banner').getByText('已移入回收站', { exact: true })).toBeVisible();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '恢复笔记', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button', { name: '打开导航菜单', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-list.png', fullPage: true });
});

test('pinning reorders the mobile list immediately and search toggles closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const marker = `即时排序-${randomUUID().slice(0, 6)}`;
  const titles = [`${marker}-一`, `${marker}-二`];
  for (const title of titles) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content: '用于验证置顶即时重排', tags: [], pinned: false,
        archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  const search = page.locator('.search-field input[aria-label="搜索笔记"]');
  await search.fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(2);
  const originalSecond = await rows.nth(1).locator('.note-row-title span').innerText();

  await rows.nth(1).click();
  let actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '置顶', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(rows.nth(0).locator('.note-row-title span')).toHaveText(originalSecond);

  await rows.nth(0).click();
  actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '取消置顶', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(rows.filter({ hasText: originalSecond }).locator('.note-row-title svg')).toHaveCount(0);

  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await search.blur();
  await expect(search).toBeHidden();
  await expect(search).toHaveValue('');
});

test('mobile list syncs all notes without creating history while note sync creates a version', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `移动同步-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '区分列表同步和单篇笔记同步');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const noteId = listed.notes[0].id;

  await page.getByRole('button', { name: '返回笔记列表' }).click();
  let navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '同步全部', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已同步，内容为最新');
  expect((await (await page.request.get(`/api/notes/${noteId}/versions`)).json()).versions).toHaveLength(0);

  await page.getByRole('button').filter({ hasText: title }).click();
  const actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  expect((await (await page.request.get(`/api/notes/${noteId}/versions`)).json()).versions).toHaveLength(1);
});

test('mobile bulk selection supports select all and exit while settings owns the version', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const marker = `移动批量-${randomUUID().slice(0, 6)}`;
  for (let index = 0; index < 2; index++) {
    expect((await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title: `${marker}-${index}`,
        content: `测试正文 ${index}`,
        tags: [],
        pinned: false,
        archived: false,
        deletedAt: null,
        revision: 0,
        operationId: randomUUID(),
      },
    })).status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button', { name: '搜索笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(2);
  let navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '批量选择', exact: true }).click();

  const toolbar = page.locator('.bulk-toolbar');
  await toolbar.getByRole('button', { name: '全选', exact: true }).click();
  await expect(toolbar).toContainText('已选 2 篇');
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/mobile-bulk-selection.png', fullPage: true });
  await toolbar.getByRole('button', { name: '取消全选', exact: true }).click();
  await expect(toolbar).toContainText('已选 0 篇');
  await toolbar.getByRole('button', { name: '退出批量选择', exact: true }).click();
  await expect(toolbar).toBeHidden();

  navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const version = page.getByText(/^EasyNote \d+\.\d+\.\d+$/);
  await version.scrollIntoViewIfNeeded();
  await expect(version).toBeVisible();
  await expect(page.locator('.list-footer')).not.toContainText('EasyNote');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-settings-version.png', fullPage: true });
});

for (const language of ['zh', 'en']) {
  test(`bulk toolbar fits narrow lists and mobile in ${language} with both themes`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('easynote-language', value), language);
    const marker = `bulk-layout-${randomUUID().slice(0, 8)}`;
    for (let index = 0; index < 2; index++) {
      expect((await page.request.post(`/api/notes/${randomUUID()}`, {
        headers, data: { title: `${marker}-${index}`, content: `layout ${index}`, tags: [],
          pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
      })).status()).toBe(201);
    }
    await page.goto('/');
    await page.locator('.search-field input').fill(marker);
    await expect(page.locator('[data-note-row]')).toHaveCount(2);
    await page.locator('.list-bulk-action').click();
    const toolbar = page.locator('.bulk-toolbar');
    for (const selected of [false, true]) {
      if (selected) await toolbar.locator('.bulk-toolbar-selection button').first().click();
      await expect(toolbar.locator('.bulk-toolbar-actions button:disabled')).toHaveCount(selected ? 0 : 4);
      for (const width of [220, 300, 320, 390]) {
        const mobile = width === 320 || width === 390;
        await page.setViewportSize({ width: mobile ? width : 1440, height: 900 });
        if (!mobile) {
          const separator = page.locator('.note-list-resizer');
          if (width === 220) await separator.press('Home');
          else await separator.dblclick();
        }
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          const layout = await toolbar.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const buttons = [...element.querySelectorAll('button')];
            const actions = [...element.querySelectorAll('.bulk-toolbar-actions button')].map((button) => button.getBoundingClientRect());
            return {
              contained: buttons.every((button) => {
                const rect = button.getBoundingClientRect();
                return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && button.scrollWidth <= button.clientWidth + 1;
              }),
              singleLine: buttons.every((button) => [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()).every((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return range.getClientRects().length === 1;
              })),
              balanced: Math.abs(actions[0].top - actions[1].top) < 1 && Math.abs(actions[2].top - actions[3].top) < 1 &&
                actions[2].top > actions[0].bottom && actions.every((rect) => Math.abs(rect.width - actions[0].width) < 1),
              minHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
            };
          });
          expect(layout.contained, `${width}px ${theme} contained`).toBe(true);
          expect(layout.singleLine, `${width}px ${theme} single line`).toBe(true);
          expect(layout.balanced, `${width}px ${theme} balanced rows`).toBe(true);
          expect(layout.minHeight).toBeGreaterThanOrEqual(mobile ? 44 : 28);
          if (width === 300 || width === 320) {
            await toolbar.screenshot({ path: `test-results/bulk-toolbar-${language}-${width}-${theme}-${selected ? 'selected' : 'empty'}.png`, animations: 'disabled' });
          }
        }
      }
    }
  });
}

test('search highlights title and a matching excerpt from deep in the note', async ({ page }) => {
  const marker = `高亮词-${randomUUID().slice(0, 6)}`;
  const title = `${marker} 标题`;
  const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
    headers,
    data: {
      title,
      content: `${'前置内容'.repeat(60)}![${marker} 图表](https://example.com/chart.png)\n\n正文再次出现 ${marker}`,
      tags: [],
      pinned: false,
      archived: false,
      deletedAt: null,
      revision: 0,
      operationId: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const row = page.locator('[data-note-row]').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator('.note-row-title mark.search-highlight')).toHaveText(marker);
  await expect(row.locator('.note-excerpt mark.search-highlight')).toHaveCount(2);
  await row.click();
  await expect(page.locator('.cm-search-highlight')).toHaveCount(2);
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.locator('.markdown mark.search-highlight')).toHaveText(marker);
});

test('deleting a note opens its next visible note or returns to all notes', async ({ page }) => {
  const marker = `删除跳转-${randomUUID().slice(0, 6)}`;
  for (let index = 0; index < 3; index++) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title: `${marker}-${index}`,
        content: `正文 ${index}`,
        tags: [],
        pinned: false,
        archived: false,
        deletedAt: null,
        revision: 0,
        operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(3);
  const nextTitle = await rows.nth(2).locator('.note-row-title span').innerText();
  await rows.nth(1).click();
  await page.getByRole('main').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(nextTitle);

  await page.getByRole('main').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading', { name: '你的笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toHaveValue('');

  const trashed = (await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(marker)}`)).json()).notes;
  for (const item of trashed as Array<{ id: string; revision: number }>) {
    expect((await page.request.delete(`${origin}/api/notes/${item.id}`, {
      headers,
      data: { revision: item.revision },
    })).status()).toBe(200);
  }
});

test('single and batch deletion persist and appear in trash', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const titles = [`单篇删除-${marker}`, `批量删除一-${marker}`, `批量删除二-${marker}`];
  for (const title of titles) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content: `${title}正文`, tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: titles[0] }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已移入回收站');

  await page.getByRole('navigation', { name: '笔记分类' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: titles[1] }).click();
  await page.getByRole('button').filter({ hasText: titles[2] }).click();
  await page.locator('.bulk-toolbar').getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByRole('heading', { name: '将 2 篇笔记移入回收站？' })).toBeVisible();
  await confirmation.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已将 2 篇笔记移入回收站');

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  for (const title of titles) await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  for (const title of titles) await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  const trash = await (await page.request.get(`/api/notes?view=trash&q=${encodeURIComponent(marker)}`)).json();
  expect(trash.notes.map((item: { title: string }) => item.title).sort()).toEqual([...titles].sort());
  for (const item of trash.notes as Array<{ id: string; revision: number }>) {
    const purged = await page.request.delete(`${origin}/api/notes/${item.id}`, {
      headers,
      data: { revision: item.revision },
    });
    expect(purged.status()).toBe(200);
  }
});

test('all notes in trash can be permanently deleted after confirmation', async ({ page }) => {
  await page.goto('/');
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const created = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const trashed = await page.request.put(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: Date.now(), revision: 1, operationId: randomUUID(),
      },
    });
    expect(trashed.status()).toBe(200);
  }

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部永久删除', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部永久删除', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '永久删除全部笔记？' })).toBeVisible();
  await expect(dialog).toContainText('此操作无法撤销');
  await dialog.getByRole('button', { name: '全部永久删除', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已永久删除 2 篇笔记');
  await expect(page.getByText('暂无笔记', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes?view=trash')).json()).notes).toHaveLength(0);
  await page.screenshot({ path: 'test-results/desktop-empty-trash.png', fullPage: true });
});

test('tags are scoped to the current note category and preserve it when selected', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const title = `归档标签-${marker}`;
  const archiveTag = `归档-${marker}`;
  expect((await page.request.post(`/api/notes/${randomUUID()}`, {
    headers, data: {
      title, content: '用于验证归档标签筛选', tags: [archiveTag, `公共-${marker}`],
      pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  })).status()).toBe(201);
  await page.goto('/');
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await page.getByRole('main').getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?view=archive&tag=${encodeURIComponent(archiveTag)}`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);

  await page.getByRole('navigation', { name: '笔记分类' }).getByRole('button', { name: '归档', exact: true }).click();
  const tagNav = page.getByRole('navigation', { name: '标签' });
  const tagButton = tagNav.getByRole('button', { name: archiveTag, exact: true });
  await expect(tagButton).toBeVisible();
  await expect(tagButton.locator('.tag-prefix')).toHaveText('#');
  await expect(tagButton.locator('.tag-prefix')).toHaveAttribute('aria-hidden', 'true');
  await tagButton.click();
  await expect(page.getByRole('heading', { name: `归档笔记 · #${archiveTag}` })).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-archive-tags.png', fullPage: true });

  await page.getByRole('navigation', { name: '笔记分类' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(tagNav.getByRole('button', { name: archiveTag, exact: true })).toBeHidden();
});

test('note list width is adjustable, persistent, and both footers align', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `布局测试-${randomUUID().slice(0, 6)}`, '检查可调整的笔记列表。');
  const list = page.locator('.note-list');
  const separator = page.getByRole('separator', { name: '调整笔记列表宽度' });
  const initial = await list.boundingBox();
  const handle = await separator.boundingBox();
  expect(initial).not.toBeNull();
  expect(handle).not.toBeNull();
  expect(initial!.width).toBeCloseTo(300, 0);
  await expect(separator).toHaveAttribute('aria-valuemin', '220');
  await expect(separator).toHaveAttribute('aria-valuemax', '440');
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 140);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 84, handle!.y + 140, { steps: 5 });
  await page.mouse.up();
  const resized = await list.boundingBox();
  expect(resized!.width).toBeGreaterThan(initial!.width + 70);
  expect(await separator.getAttribute('aria-valuenow')).toBe(String(Math.round(resized!.width)));
  const footers = await page.evaluate(() => {
    const sidebarFooter = document.querySelector('.sidebar-bottom')!.getBoundingClientRect();
    const listFooter = document.querySelector('.list-footer')!.getBoundingClientRect();
    const documentFooter = document.querySelector('.document-footer')!.getBoundingClientRect();
    return {
      sidebarTop: sidebarFooter.top, sidebarHeight: sidebarFooter.height,
      listTop: listFooter.top, documentTop: documentFooter.top,
      listHeight: listFooter.height, documentHeight: documentFooter.height,
    };
  });
  expect(Math.abs(footers.sidebarTop - footers.listTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listTop - footers.documentTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.sidebarHeight - footers.listHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listHeight - footers.documentHeight)).toBeLessThanOrEqual(1);
  expect(footers.sidebarHeight).toBeCloseTo(32, 0);
  expect(footers.listHeight).toBeCloseTo(32, 0);
  expect(footers.documentHeight).toBeCloseTo(32, 0);
  await page.screenshot({ path: 'test-results/desktop-resized.png', fullPage: true });
  await page.getByRole('button', { name: '收起侧栏' }).click();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await page.reload();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '300');
});

for (const expired of [false, true]) {
  test(`typing during a save preserves the draft without restarting the ${expired ? 'expired' : 'pending'} debounce`, async ({ page }) => {
    const title = `连续输入-${randomUUID().slice(0, 6)}`;
    await page.goto('/');
    await newNote(page, title, '初始正文');
    const { config: { autosaveMs } } = await (await page.request.get('/api/session')).json();
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    let release: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'PUT' && first) {
        first = false;
        const result = await route.fetch();
        reportStarted!();
        await delayed;
        await route.fulfill({ response: result });
      } else await route.continue();
    });
    await page.getByRole('textbox', { name: '笔记正文' }).fill('第一段修改');
    await page.clock.runFor(autosaveMs);
    await started;
    await page.getByRole('textbox', { name: '笔记正文' }).fill('请求期间继续输入，完整保留第二段修改');
    const elapsed = expired ? autosaveMs + 50 : autosaveMs / 2;
    await page.clock.runFor(elapsed);
    release!();
    await expect(page.locator('.save-status')).toHaveText('本机草稿');
    await page.clock.runFor(expired ? 1 : autosaveMs - elapsed);
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button').filter({ hasText: title }).click();
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('完整保留第二段修改');
  });
}

test('a stalled save times out and remains retryable without reloading', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `超时恢复-${randomUUID().slice(0, 6)}`, '已保存内容');
  await page.clock.install();
  await page.evaluate(() => {
    const state = window as typeof window & { stalledPuts: number };
    state.stalledPuts = 0;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return original(input, init);
      state.stalledPuts++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('等待超时的本地草稿');
  await page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { stalledPuts: number }).stalledPuts)).toBe(1);
  await page.clock.runFor(31_000);
  await expect(page.getByRole('alert')).toContainText('Request timed out after 30 seconds.');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '同步并更新历史版本', exact: true })).toBeEnabled();
});

test('incremental polling preserves pagination while refreshing a selected note', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const prefix = `分页同步-${marker}`;
  const targetId = randomUUID();
  const targetTitle = `${prefix}-目标`;
  for (let index = 0; index < 55; index++) {
    const id = index === 54 ? targetId : randomUUID();
    const response = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: index === 54 ? targetTitle : `${prefix}-${index}`,
        content: '初始内容', tags: [], pinned: false, archived: false, deletedAt: null,
        revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/');
  // Other tests share this server; paginate only this test's notes.
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(prefix);
  await expect(page.locator('.note-row')).toHaveCount(50);
  await expect(page.locator('.note-row').first()).toHaveAttribute('aria-label', /.+，.+/);
  await expect(page.locator('.note-row').first().locator('.note-excerpt')).toHaveAttribute('aria-hidden', 'true');
  let loadMore = page.getByRole('button', { name: '加载更多' });
  await loadMore.click();
  await expect(page.locator('.note-row')).toHaveCount(55);
  await disableOfflineLibrary(page);
  loadMore = page.getByRole('button', { name: '加载更多' });
  await loadMore.click();
  await expect(loadMore).toBeHidden();
  const loadedRows = await page.locator('.note-row').count();
  await page.getByRole('button').filter({ hasText: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await page.route('**/api/sync?**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Temporary failure.' } }),
  }));
  const failedPoll = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/sync' && response.status() === 503);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await failedPoll;
  await expect(page.getByRole('alert')).toContainText('后台同步失败，将自动重试。');
  await page.unroute('**/api/sync?**');
  const remote = await page.request.put(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '另一台设备更新后的内容', tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 1, operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('另一台设备更新后的内容');
  expect(await page.locator('.note-row').count()).toBe(loadedRows);
  await expect(page.getByRole('alert')).toBeHidden();
});

test('an expired session returns to login without a page reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await page.route('**/api/sync?**', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Please sign in.' } }),
  }));
  const sync = page.locator('.note-list').getByRole('button', { name: '同步全部', exact: true });
  await sync.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByText('登录已过期，请重新登录。', { exact: true })).toBeVisible();
});

test('a second tab cannot overwrite this browser profile local drafts', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.close();
  await expect(other.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await other.close();
});

test('a second tab can take over the editor lock when clicking reopen', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: '重新打开' }).click();
  await expect(other.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(page.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新打开' }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await other.close();
});

test('a foreground installed PWA takes over from a browser tab', async ({ page, context }) => {
  await page.goto('/');
  await newNote(page, `接管-${randomUUID().slice(0, 6)}`, '接管前保存的内容');
  const app = await context.newPage();
  await app.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = original(query);
      if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
  });
  await app.goto('/');
  await expect(app.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(page.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新打开' }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(app.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await app.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(app.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await expect(page.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await app.close();
});

test('mobile browser back returns to the list and forward restores the note', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const title = `返回手势-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '返回列表后保留的正文');
  const initialLength = await page.evaluate(() => history.length);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('返回列表后保留的正文');
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect.poll(() => page.evaluate(() => history.state?.easynoteMobileNote ?? null)).toBeNull();
  await page.locator('.note-row').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(initialLength);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorX)).toBe('none');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
});

test('dark theme persists and the narrow mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await newNote(page, '窄屏排版', '深色主题下的笔记');
  await page.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('command palette, cursor-position image insertion and private attachments work', async ({ page }) => {
  const title = `快捷插入-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n结尾');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.press('ArrowLeft');
  await editor.press('ArrowLeft');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '光标图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toMatch(/开头\n!\[光标图片\.png\]\(\/api\/images\/[0-9a-f-]{36}\)\n\n结尾/);

  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles({
    name: '资料.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  });
  await expect(page.getByText('附件已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('link', { name: '资料.pdf' })).toHaveAttribute('href', /\/api\/files\/[0-9a-f-]{36}$/);

  await page.keyboard.press('Meta+o');
  const palette = page.getByRole('dialog');
  await expect(palette.getByRole('heading', { name: '快速跳转' })).toBeVisible();
  await palette.getByLabel('快速跳转搜索').fill(title);
  await expect(palette.getByRole('button', { name: title, exact: true })).toBeVisible();
  await palette.getByRole('button', { name: title, exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await page.keyboard.press('Meta+s');
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
});

test('editing shortcuts and keyboard navigation work without pointer input', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `键盘操作-${randomUUID().slice(0, 6)}`, '格式文本');
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  await editor.press('Meta+a');
  await editor.press('Meta+b');
  await expect(editor).toContainText('**格式文本**');
  await editor.press('Meta+b');
  await expect(editor).toContainText('格式文本');
  await expect(editor).not.toContainText('**');
  await editor.press('Meta+a');
  await editor.press('Meta+i');
  await expect(editor).toContainText('*格式文本*');
  await editor.press('Meta+z');
  await expect(editor).toHaveText('格式文本');
  await editor.press('Meta+Shift+z');
  await expect(editor).toHaveText('*格式文本*');

  await editor.press('Meta+e');
  await expect(page.getByRole('button', { name: '阅读模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+e');
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '笔记正文' }).press('Meta+/');
  const shortcuts = page.getByRole('dialog');
  await expect(shortcuts.getByRole('heading', { name: '快捷键' })).toBeVisible();
  // Opening a dialog must not leave the default focus on the header close button.
  await expect(shortcuts.getByRole('button', { name: '关闭' })).not.toBeFocused();
  await expect(shortcuts).toContainText('Cmd/Ctrl+P');
  await expect(shortcuts).toContainText('Cmd/Ctrl+K');
  await expect(shortcuts).toContainText('Cmd/Ctrl+O');
  await expect(shortcuts).toContainText('Cmd/Ctrl+Enter');
  // The help documents the current edit/read pair, not the removed preview mode.
  await expect(shortcuts).toContainText('编辑 / 阅读');
  await expect(shortcuts).not.toContainText('编辑 / 预览');
  await shortcuts.getByRole('button', { name: '关闭' }).click();

  await page.keyboard.press('Control+k');
  const globalSearch = page.getByRole('textbox', { name: '搜索笔记' });
  await expect(globalSearch).toBeFocused();
  await expect(globalSearch).toHaveValue('');

  await page.keyboard.press('Meta+o');
  const palette = page.getByRole('dialog');
  const commandSearch = palette.getByLabel('快速跳转搜索');
  await expect(commandSearch).toBeFocused();
  await page.keyboard.type('设置');
  await expect(commandSearch).toHaveValue('设置');
  await commandSearch.press('ArrowDown');
  await expect(palette.getByRole('button', { name: '打开设置' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(`第二篇-${randomUUID().slice(0, 6)}`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const rows = page.locator('.note-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await rows.first().focus();
  await rows.first().press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press('Home');
  await expect(rows.first()).toBeFocused();
});

test('tablet navigation opens with shortcuts and the Quick Open command', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 960 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  const navigation = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'EasyNote', exact: true }) });
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.press(`${modifier}+\\`);
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('button', { name: '全部笔记', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
  }
  await page.keyboard.press('Control+o');
  const palette = page.getByRole('dialog');
  await palette.getByLabel('快速跳转搜索').fill('切换导航侧栏');
  await palette.getByRole('button', { name: /切换导航侧栏/ }).click();
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: '归档', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page.locator('.list-heading h1')).toHaveText('归档笔记');
});

for (const width of [1440, 390]) {
  test(`global search shortcuts focus and select the query from the editor at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/');
    const title = `全局快捷搜索-${randomUUID()}`;
    await newNote(page, title, '搜索正文');
    await page.getByRole('textbox', { name: '笔记正文' }).press('Control+k');
    const search = page.getByRole('textbox', { name: '搜索笔记', exact: true });
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await search.fill(title);
    await expect(page.locator('[data-note-row]').filter({ hasText: title })).toBeVisible();
    await search.press('Tab');
    await page.keyboard.press('Meta+k');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue(title);
    expect(await search.evaluate((input: HTMLInputElement) =>
      [input.selectionStart, input.selectionEnd])).toEqual([0, title.length]);
    await search.press('Escape');
    await page.keyboard.press('Control+Shift+F');
    await expect(search).toBeFocused();
    await page.keyboard.press('Control+\\');
    if (width === 390) {
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'EasyNote', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    } else await expect(page.locator('.app-shell')).toHaveClass(/sidebar-hidden/);
    await page.locator(`[data-note-row]`).filter({ hasText: title }).click();
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('搜索正文');
    await page.keyboard.press('Meta+o');
    const palette = page.getByRole('dialog');
    await palette.getByLabel('快速跳转搜索').fill('搜索');
    await palette.getByRole('button', { name: /搜索笔记/ }).click();
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('搜索');
  });
}

for (const modifier of ['Control', 'Meta']) {
  test(`app shortcuts work inside the editor without changing text with ${modifier}`, async ({ page }) => {
    const folder = await seedOrderFolder(page);
    await page.goto('/');
    await openFolder(page, folder.folderId);
    const title = `快捷键正文保护-${randomUUID()}`;
    const content = '## 标题\n保留这一行正文';
    await newNote(page, title, content);
    const editor = page.getByRole('textbox', { name: '笔记正文' });
    await editor.press('Home');
    await editor.press(`${modifier}+o`);
    const palette = page.getByRole('dialog');
    await expect(palette.getByRole('heading', { name: '快速跳转' })).toBeVisible();
    await expect(palette.getByRole('button', { name: /新建笔记/ })).toContainText('Cmd/Ctrl+Enter');
    await expect(palette.getByRole('button', { name: /搜索笔记/ })).toContainText('Cmd/Ctrl+K');
    await page.keyboard.press('Escape');

    await editor.press(`${modifier}+.`);
    await expect(page.getByRole('complementary', { name: '笔记导航' })).toBeVisible();
    await editor.press(`${modifier}+.`);
    await expect(page.getByRole('complementary', { name: '笔记导航' })).toBeHidden();
    await editor.press(`${modifier}+Shift+k`);
    await expect(page.getByRole('dialog').getByRole('heading', { name: '插入内部链接' })).toBeVisible();
    await page.keyboard.press('Escape');
    // The heading block is not the active block here, so its markers are hidden in live preview; read the
    // source in source mode and keep the original assertion untouched.
    await page.getByRole('button', { name: '源码模式' }).click();
    await expect(editor).toHaveText(content.replace('\n', ''));

    await editor.press(`${modifier}+Shift+l`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await editor.press(`${modifier}+Shift+l`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await editor.press(`${modifier}+,`);
    const settings = page.getByRole('dialog');
    await expect(settings.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.keyboard.press(`${modifier}+Enter`);
    await page.keyboard.press(`${modifier}+k`);
    await expect(settings).toBeVisible();
    await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
    await page.keyboard.press('Escape');

    await editor.press(`${modifier}+Enter`);
    await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: '笔记标题' })).toBeFocused();
    await expect.poll(async () => (await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json()).notes[0]?.title).toBe(title);
    const original = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json()).notes[0];
    expect((await (await page.request.get(`/api/notes/${original.id}`)).json()).note.content).toBe(content);
    await page.getByRole('textbox', { name: '笔记标题' }).fill(`${title}-新建`);
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    const created = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(`${title}-新建`)}`)).json()).notes[0];
    expect(created.folderId).toBe(folder.folderId);
    expect((await (await page.request.get(`/api/notes/${created.id}`)).json()).note.content).toBe('');
  });
}

test('global shortcuts leave browser find, shifted shortcuts and input composition alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toBeVisible();
  const defaultsAllowed = await page.evaluate(() => [
    { key: 'f', ctrlKey: true },
    { key: 'f', metaKey: true },
    { key: 'O', ctrlKey: true, shiftKey: true },
    { key: 'k', metaKey: true, altKey: true },
    { key: 'k', ctrlKey: true, repeat: true },
    { key: 'k', metaKey: true, isComposing: true },
  ].map((keys) => window.dispatchEvent(new KeyboardEvent('keydown', { ...keys, cancelable: true }))));
  expect(defaultsAllowed).toEqual([true, true, true, true, true, true]);
});

test('save shortcut is blocked when there is no note or pending draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.list-scroll')).toHaveAttribute('aria-busy', 'false');
  const prevented = await page.evaluate(() => [
    { key: 's', ctrlKey: true },
    { key: 's', metaKey: true },
  ].map((keys) => !window.dispatchEvent(new KeyboardEvent('keydown', { ...keys, cancelable: true }))));
  expect(prevented).toEqual([true, true]);
});

test('shortcut help fits narrow screens in both languages', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开导航菜单', exact: true })).toBeVisible();
  for (const language of ['zh', 'en']) {
    await page.keyboard.press('Control+,');
    await page.getByRole('dialog').getByRole('combobox').first().selectOption(language);
    await expect(page.getByRole('button', { name: language === 'zh' ? '打开导航菜单' : 'Open navigation menu', exact: true })).toBeVisible();
    await page.keyboard.press('Control+/');
    const help = page.getByRole('dialog');
    await expect(help).toContainText('Cmd/Ctrl+K');
    await expect(help).toContainText('Cmd/Ctrl+O');
    expect(await help.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('Markdown todo items render and persist interactive checkbox changes', async ({ page }) => {
  const title = `待办事项-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '- [] 兼容简写\n- [x] 已完成\n- [ ] 标准待办');
  await page.getByRole('button', { name: '阅读模式' }).click();

  const compact = page.getByRole('checkbox', { name: '待办事项：兼容简写' });
  const completed = page.getByRole('checkbox', { name: '待办事项：已完成' });
  const standard = page.getByRole('checkbox', { name: '待办事项：标准待办' });
  await expect(compact).toBeEnabled();
  await expect(compact).not.toBeChecked();
  await expect(completed).toBeChecked();
  await expect(standard).not.toBeChecked();

  await compact.click();
  await completed.click();
  await expect(compact).toBeChecked();
  await expect(completed).not.toBeChecked();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-todo.png', fullPage: true });

  await page.getByRole('button', { name: '即时渲染模式' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toContainText('- [x] 兼容简写');
  await expect(editor).toContainText('- [ ] 已完成');
  await expect(editor).toContainText('- [ ] 标准待办');
});

test('preview task changes use source lines across code, quotes and ordered or nested lists', async ({ page }) => {
  const title = `待办定位-${randomUUID().slice(0, 8)}`;
  let content = [
    '```md', '- [ ] 围栏示例', '```', '',
    '    - [ ] 缩进示例', '',
    '> - [ ] 引用待办', '',
    '1. [ ] 有序待办', '',
    '- - [ ] 嵌套待办', '',
    '-\n  [ ] 续行待办', '',
    '>- [ ] 紧贴引用', '',
    '- \\[ ] 转义示例', '',
    '- [ ] 普通待办',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const { notes } = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  await expect(page.locator('.markdown input[type=checkbox]')).toHaveCount(6);
  for (const task of ['引用待办', '有序待办', '嵌套待办', '续行待办', '紧贴引用', '普通待办']) {
    await page.getByRole('checkbox', { name: `待办事项：${task}`, exact: true }).check();
    content = content.replace(`[ ] ${task}`, `[x] ${task}`);
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${notes[0].id}`)).json()).note.content).toBe(content);
  }
  await page.getByRole('checkbox', { name: '待办事项：引用待办', exact: true }).uncheck();
  content = content.replace('[x] 引用待办', '[ ] 引用待办');
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${notes[0].id}`)).json()).note.content).toBe(content);
});

for (const persistence of ['granted', 'denied', 'unsupported', 'failure', 'already-persistent']) {
  test(`local storage persistence ${persistence} is reported without blocking editing`, async ({ page }) => {
    await page.addInitScript((mode) => {
      Object.defineProperty(window, '__persistenceRequests', { value: 0, writable: true });
      if (mode === 'unsupported') {
        Object.defineProperty(navigator, 'storage', { value: undefined });
      } else {
        Object.defineProperty(navigator.storage, 'persisted', { value: async () => mode === 'already-persistent' });
        Object.defineProperty(navigator.storage, 'persist', { value: async () => {
          (window as unknown as { __persistenceRequests: number }).__persistenceRequests++;
          if (mode === 'failure') throw new Error('storage permission unavailable');
          return mode === 'granted';
        } });
      }
    }, persistence);
    await page.goto('/');
    await page.locator('.account').click();
    const persistent = persistence === 'granted' || persistence === 'already-persistent';
    await expect(page.getByText(persistent ? '持久保存已启用' : '未启用持久保存', { exact: true })).toBeVisible();
    await expect(page.getByText('浏览器可能清理本机数据，未同步草稿请及时导出。', { exact: true })).toHaveCount(persistent ? 0 : 1);
    expect(await page.evaluate(() => (window as unknown as { __persistenceRequests: number }).__persistenceRequests))
      .toBe(persistence === 'unsupported' || persistence === 'already-persistent' ? 0 : 1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await newNote(page, `存储保护-${randomUUID().slice(0, 8)}`, '持久化申请不影响保存');
  });
}

test('offline cold start renders previously unopened Mermaid diagrams and highlighted code', async ({ page, context }) => {
  const title = `离线渲染-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await newNote(page, title, [
    '```mermaid', 'flowchart LR', ' A[Offline] --> B[Ready]', '```', '',
    '```mermaid', 'sequenceDiagram', ' Alice->>Bob: Offline ready', '```', '',
    '```javascript', 'const answer = 42;', '```',
  ].join('\n'));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Keep the Service Worker cache while dropping incidental HTTP-cache coverage.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-note-row]').filter({ hasText: title }).click();
    await page.getByRole('button', { name: '阅读模式', exact: true }).click();
    await expect(page.locator('.document .mermaid-diagram svg')).toHaveCount(2);
    await expect(page.locator('.document code.hljs .hljs-keyword')).toHaveText('const');
    await expect(page.locator('.document .mermaid-error')).toHaveCount(0);
  } finally { await context.setOffline(false); }
});

test('desktop export configures and downloads a structured PDF', async ({ page }) => {
  const title = `PDF/导出:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 打印正文',
    '',
    '包含图表和私有图片。',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[准备] --> B[导出]',
    '```',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await page.getByLabel('添加标签', { exact: true }).click();
  const tagInput = page.getByPlaceholder('搜索或回车新建标签…');
  for (const tag of ['打印', '测试']) {
    await tagInput.fill(tag);
    await tagInput.press('Enter');
  }
  await tagInput.press('Escape');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '打印图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出当前笔记为 PDF' })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & { desktopShareCalled?: boolean };
    state.desktopShareCalled = false;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => { state.desktopShareCalled = true; },
    });
  });
  await page.getByRole('textbox', { name: '笔记标题' }).press('Meta+p');
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  await expect(exportDialog.getByLabel('PDF 文件名')).toHaveValue(title);
  await expect(exportDialog.getByLabel('PDF 纸张')).toHaveValue('A4');
  await expect(exportDialog.getByLabel('PDF 缩放')).toHaveValue('100');
  const preview = exportDialog.getByRole('region', { name: 'PDF 分页预览' });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  const portraitPreview = await preview.getByRole('img', { name: 'PDF 第 1 页' }).getAttribute('src');
  await exportDialog.getByRole('button', { name: '横向' }).click();
  await expect(preview).toHaveAttribute('aria-busy', 'true');
  await expect(preview).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).not.toHaveAttribute('src', portraitPreview!);
  await exportDialog.getByLabel('PDF 文件名').fill('重命名后的导出文件');
  const template = page.locator('.print-document');
  await expect(template).toContainText('包含图表和私有图片。');
  await expect(template).not.toContainText(title);
  await expect(template).not.toContainText('更新于');
  await expect(template).not.toContainText('#打印');
  await expect(template).not.toContainText(origin);
  await expect(template.locator('.mermaid-diagram svg')).toHaveCount(1);
  expect(await template.locator('img').evaluateAll((images: HTMLImageElement[]) =>
    images.length === 1 && images.every((item) => item.complete && item.naturalWidth > 0))).toBe(true);
  expect(await page.title()).toBe('EasyNote');
  await page.screenshot({ path: 'test-results/desktop-pdf-export.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('重命名后的导出文件.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const pdfBytes = await readFile(path!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
  expect(new TextDecoder('latin1').decode(pdfBytes)).toContain('/FontFile');
  expect(await page.evaluate(() =>
    (window as typeof window & { desktopShareCalled?: boolean }).desktopShareCalled)).toBe(false);
  await expect(exportDialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('PDF 已下载');
});

test('mobile browsers receive a real PDF through share or download', async ({ page }) => {
  const title = `移动/PDF:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 移动端导出',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[iOS] --> C[PDF]',
    '  B[Android] --> C',
    '```',
    '',
    ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段内容用于验证移动端 PDF 分页不会截断长笔记。`),
  ].join('\n\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await newNote(page, title, content);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '移动端图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & {
      mobileShare?: { name: string; type: string; size: number; header: string };
      printCalls?: number;
    };
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    });
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { mobile: true },
    });
    state.printCalls = 0;
    window.print = () => { state.printCalls = (state.printCalls ?? 0) + 1; };
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }: ShareData) => files?.[0]?.type === 'application/pdf',
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        const file = files![0];
        state.mobileShare = {
          name: file.name,
          type: file.type,
          size: file.size,
          header: await file.slice(0, 4).text(),
        };
      },
    });
  });

  const actions = await openMobileNoteActions(page);
  const exportButton = actions.locator('.mobile-pdf-action');
  await expect(exportButton).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await exportButton.click();
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  const preview = exportDialog.getByRole('region', { name: 'PDF 分页预览' });
  await expect(preview.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  expect(await preview.getByRole('img').count()).toBeGreaterThan(1);
  await page.screenshot({ path: 'test-results/mobile-pdf-export.png', fullPage: true });
  await exportDialog.getByRole('button', { name: '导出 PDF' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { mobileShare?: unknown }).mobileShare)).toBeTruthy();
  const shared = await page.evaluate(() =>
    (window as typeof window & { mobileShare?: { name: string; type: string; size: number; header: string } }).mobileShare);
  expect(shared).toMatchObject({
    name: expect.stringMatching(/^移动-PDF-.+\.pdf$/),
    type: 'application/pdf',
    header: '%PDF',
  });
  expect(shared!.size).toBeGreaterThan(1_000);
  expect(await page.evaluate(() => (window as typeof window & { printCalls?: number }).printCalls)).toBe(0);
  await expect(page.getByRole('status')).toHaveText('PDF 已交给系统保存');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  const fallbackActions = await openMobileNoteActions(page);
  await fallbackActions.locator('.mobile-pdf-action').click();
  await expect(page.getByRole('heading', { name: '导出为 PDF' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF 分页预览' })
    .getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^移动-PDF-.+\.pdf$/);
  await download.saveAs('test-results/mobile-note.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const pdfBytes = await readFile(path!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
  const pdfSource = new TextDecoder('latin1').decode(pdfBytes);
  const pageCount = pdfSource.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  const imageCount = pdfSource.match(/\/Subtype\s*\/Image\b/g)?.length ?? 0;
  expect(pageCount).toBeGreaterThan(1);
  expect(pdfSource).toContain('/FontFile');
  expect(imageCount).toBeLessThanOrEqual(3);
});

test('outline, stable internal links and backlinks navigate between notes', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const targetTitle = `知识目标-${marker}`;
  const sourceTitle = `知识来源-${marker}`;
  const targetId = randomUUID();
  await page.goto('/');
  const created = await page.request.post(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '## 目标章节\n\n目标内容', tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await newNote(page, sourceTitle, '## 来源章节\n\n引用目标');
  await page.getByRole('button', { name: '大纲与反向链接' }).click();
  const panel = page.getByRole('complementary', { name: '笔记导航' });
  await expect(panel.getByRole('button', { name: '来源章节' })).toBeVisible();

  await page.getByRole('button', { name: '插入内部链接' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('搜索链接目标').fill(targetTitle);
  await picker.getByRole('button', { name: targetTitle, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(/\[\[[0-9a-f-]{36}\|知识目标-/);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读模式' }).click();
  await page.getByRole('link', { name: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await expect(panel.getByRole('button', { name: sourceTitle, exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-knowledge-navigation.png', fullPage: true });
});

test('offline library opens a cached note before remote revalidation finishes', async ({ page }) => {
  const marker = randomUUID().slice(0, 7);
  const id = randomUUID();
  const title = `本地优先-${marker}`;
  const content = `无需等待网络-${marker}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content, tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  let release!: () => void;
  const remoteResponse = new Promise<void>((resolve) => { release = resolve; });
  let revalidating = false;
  await page.route(`**/api/notes/${id}`, async (route) => {
    revalidating = true;
    await remoteResponse;
    await route.continue();
  });

  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title, { timeout: 1000 });
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(content);
  expect(revalidating).toBe(true);
  const revalidated = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${id}`));
  release();
  await revalidated;
  await page.unroute(`**/api/notes/${id}`);
});

test('full offline library supports cold start, full-text search and note reading', async ({ page, context }) => {
  const marker = randomUUID().slice(0, 7);
  const title = `离线笔记-${marker}`;
  await page.goto('/');
  await newNote(page, title, `只有离线镜像中存在的检索词-${marker}`);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '离线图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    const paths = urls.map((url) => new URL(url).pathname);
    return {
      pdfmake: paths.some((path) => path.includes('/assets/pdfmake')),
      pdfjs: paths.some((path) => path.includes('/assets/pdfjs')),
      worker: paths.some((path) => path.includes('/assets/pdf.worker')),
      regularFont: paths.includes('/fonts/NotoSansSC-Regular.otf'),
      boldFont: paths.includes('/fonts/NotoSansSC-Bold.otf'),
    };
  }), { timeout: 20_000 }).toEqual({
    pdfmake: true,
    pdfjs: true,
    worker: true,
    regularFont: true,
    boldFont: true,
  });
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('离线', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(`检索词-${marker}`);
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(`检索词-${marker}`);
  await page.getByRole('button', { name: '阅读模式' }).click();
  const cachedImage = page.locator('.markdown img');
  await expect(cachedImage).toBeVisible();
  await expect.poll(() => cachedImage.evaluate((element: HTMLImageElement) =>
    element.src.startsWith('blob:') && element.complete && element.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially(`离线修改-${marker}`);
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-offline-library.png', fullPage: true });
  await context.setOffline(false);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toContain(`离线修改-${marker}`);
});

test('batch note actions and tag management preserve revisions', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const firstTitle = `批量一-${marker}`;
  const secondTitle = `批量二-${marker}`;
  const sourceTag = `来源-${marker}`;
  const addedTag = `批量-${marker}`;
  const renamedTag = `归并-${marker}`;
  await page.goto('/');
  for (const [title, content] of [[firstTitle, '第一篇'], [secondTitle, '第二篇']]) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content, tags: [sourceTag], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole('button').filter({ hasText: firstTitle })).toBeVisible();

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.getByRole('button', { name: '加标签' }).click();
  await page.getByRole('dialog').getByLabel('标签', { exact: true }).fill(addedTag);
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已为 2 篇笔记添加标签');

  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog');
  await manager.getByPlaceholder('输入新标签名称…').fill(renamedTag);
  await manager.getByRole('button', { name: '添加', exact: true }).click();
  await manager.getByRole('listitem').filter({ hasText: `#${sourceTag}` }).getByRole('button', { name: '合并', exact: true }).click();
  await manager.getByRole('combobox').selectOption(renamedTag);
  await manager.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`已将 #${sourceTag} 合并到 #${renamedTag}，更新了 2 篇笔记`);
  await manager.getByRole('button', { name: '完成', exact: true }).click();

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.locator('.bulk-toolbar').getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已归档 2 篇笔记');
  const archived = await (await page.request.get(`/api/notes?view=archive&q=${encodeURIComponent(marker)}`)).json();
  expect(archived.notes).toHaveLength(2);
  for (const summary of archived.notes) {
    const full = await (await page.request.get(`/api/notes/${summary.id}`)).json();
    expect(full.note.tags).toEqual(expect.arrayContaining([addedTag, renamedTag]));
    expect(full.note.tags).not.toContain(sourceTag);
    expect(full.note.revision).toBeGreaterThan(2);
  }
});


test('double-clicking a note opens an independent reader window', async ({ page }) => {
  const title = `双击独立阅读-${randomUUID().slice(0, 8)}`;
  const content = [
    '[TOC]',
    '',
    '# 阅读测试',
    '',
    '这是一篇用于独立窗口阅读的笔记内容。',
    '',
    '## 窗口末尾',
    '',
    ...Array.from({ length: 40 }, (_, index) => `独立窗口段落 ${index + 1}`),
    '',
    '- [ ] 待办任务 1',
  ].join('\n\n');
  const created = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
    headers, data: { title, content, tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID() },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');

  const noteRow = page.locator('.note-row').filter({ hasText: title }).first();
  await expect(noteRow).toBeVisible();

  const popupPromise = page.waitForEvent('popup');
  await noteRow.dblclick();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');

  await expect(popup.locator('.popout-reader-shell')).toBeVisible();
  await expect(popup.locator('.popout-reader-title')).toHaveText(title);
  await expect(popup.locator('.popout-note-heading')).toHaveText(title);
  await expect(popup.locator('.markdown h1')).toHaveText('阅读测试');
  await expect(popup.locator('.popout-reader-title-area')).toHaveCSS('font-size', '14px');
  await expect(popup.locator('link[rel="stylesheet"]')).toHaveCount(0);
  await expect(page.locator('.popout-pin-action')).toHaveCount(0);
  await expect(popup.locator('.popout-reader-actions button')).toHaveCount(2);
  const maxBtn = popup.locator('.popout-control-maximize');
  await expect(maxBtn).toBeVisible();
  await expect(maxBtn).toHaveAttribute('aria-label', '最大化');
  await maxBtn.click();
  await expect(maxBtn).toHaveAttribute('aria-label', '向下还原');
  await popup.locator('.popout-reader-title-area').dblclick();
  await expect(maxBtn).toHaveAttribute('aria-label', '最大化');

  await popup.getByRole('button', { name: '深色外观' }).click();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(popup.locator('.popout-control-close')).toHaveCount(0);

  // The contents directive and its in-window scrolling also work in the reader window.
  const popoutContents = popup.locator('.popout-reader-document nav.note-toc');
  await expect(popoutContents.getByRole('link')).toHaveText(['阅读测试', '窗口末尾']);
  await popup.locator('.popout-reader-content').evaluate((element) => element.scrollTo(0, element.scrollHeight));
  const popoutHeading = popup.locator('.markdown h2').filter({ hasText: '窗口末尾' });
  await expect.poll(() => popoutHeading.evaluate((element) => element.getBoundingClientRect().top < 0)).toBe(true);
  await popoutContents.getByRole('link', { name: '窗口末尾' }).dispatchEvent('click');
  await expect.poll(() => popoutHeading.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top >= 0 && top < 120;
  })).toBe(true);
  await popup.close();
});

test('double-click opens before loading an unloaded note and uses the loaded note', async ({ page }) => {
  const id = randomUUID();
  const title = `慢加载独立阅读-${id.slice(0, 8)}`;
  const content = '# 慢加载测试\n\n弹窗应先打开。';
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers, data: { title, content, tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID() },
  });
  expect(created.status()).toBe(201);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let noteRequests = 0;
  await page.route(`**/api/notes/${id}`, async (route) => {
    noteRequests++;
    await gate;
    await route.continue();
  });

  await page.goto('/');
  const noteRow = page.locator('.note-row').filter({ hasText: title }).first();
  await expect(noteRow).toBeVisible();

  const popupPromise = page.waitForEvent('popup');
  await noteRow.dblclick();
  const popup = await popupPromise;
  await expect.poll(() => noteRequests).toBe(1);
  release();
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.locator('.popout-note-heading')).toHaveText(title);
  await expect(popup.locator('.markdown')).toContainText('弹窗应先打开。');
  expect(noteRequests).toBe(1);
  await popup.close();
});

test('popout fallback uses the note returned by selection after a direct read failure', async ({ page }) => {
  await page.goto('/');
  await disableOfflineLibrary(page);
  const id = randomUUID();
  const title = `回退独立阅读-${id.slice(0, 8)}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers, data: { title, content: '回退读取内容', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID() },
  });
  expect(created.status()).toBe(201);
  let requests = 0;
  await page.route(`**/api/notes/${id}`, async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
      return;
    }
    await route.continue();
  });

  await page.reload();
  const noteRow = page.locator('.note-row').filter({ hasText: title }).first();
  await expect(noteRow).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await noteRow.dblclick();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.locator('.popout-note-heading')).toHaveText(title);
  expect(requests).toBeGreaterThanOrEqual(2);
  await popup.close();
});

test('single-click starts loading a note without waiting for a double-click timer', async ({ page }) => {
  const id = randomUUID();
  const title = `即时单击-${id.slice(0, 8)}`;
  await page.goto('/');
  await disableOfflineLibrary(page);
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers, data: { title, content: '即时打开', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID() },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.clock.install();
  const requested = page.waitForRequest((request) => request.url().endsWith(`/api/notes/${id}`));
  await page.locator('.note-row').filter({ hasText: title }).click();
  await requested;
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
});

test('popout keeps the latest draft when the main view switches notes', async ({ page }) => {
  const firstTitle = `窗口草稿-${randomUUID().slice(0, 8)}`;
  const secondTitle = `另一篇-${randomUUID().slice(0, 8)}`;
  for (const [title, content] of [[firstTitle, '- [ ] 待办\n\n旧正文'], [secondTitle, '另一篇正文']]) {
    const created = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers, data: { title, content, tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID() },
    });
    expect(created.status()).toBe(201);
  }
  await page.goto('/');
  await page.locator('.note-row').filter({ hasText: firstTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(firstTitle);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '独立窗口阅读' }).click();
  const popup = await popupPromise;
  await expect(popup.locator('.markdown')).toContainText('旧正文');

  await page.getByRole('textbox', { name: '笔记正文' }).fill('- [ ] 待办\n\n新正文');
  await expect(popup.locator('.markdown')).toContainText('新正文');
  await page.locator('.note-row').filter({ hasText: secondTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(secondTitle);
  await expect(popup.locator('.markdown')).toContainText('新正文');
  await popup.getByRole('checkbox', { name: '待办事项：待办' }).click();
  await expect(popup.locator('.markdown')).toContainText('新正文');
  await page.locator('.note-row').filter({ hasText: firstTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('新正文');
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('- [x] 待办');
  await popup.close();
});

test('draft export offers an explicit incomplete backup when an attachment is missing', async ({ page }) => {
  const missingId = randomUUID();
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(`抢救草稿-${randomUUID().slice(0, 8)}`);
  await page.getByRole('textbox', { name: '笔记正文' })
    .fill(`重要文本\n\n![缺失附件](/api/images/${missingId})`);
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (missingId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('easynote');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const drafts = await new Promise<Array<{ note: { content: string } }>>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return drafts.some((draft) => draft.note.content.includes(missingId));
  }, missingId)).toBe(true);
  await page.locator('.account').click();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('1 个附件未缓存');
    void dialog.accept();
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出草稿' }).click();
  const download = await downloadPromise;
  const archive = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']));
  expect(manifest.missingFileIds).toContain(missingId);
  expect(download.suggestedFilename()).toContain('partial');
  const markdown = strFromU8(archive[manifest.drafts[0].path]);
  expect(markdown).toContain('重要文本');
  expect(markdown).toContain(`../missing/${missingId}`);
});

test('a revoked offline session is removed as soon as the device reconnects', async ({ page, context }) => {
  await page.goto('/');
  const login = await page.request.post(`${origin}/api/login`, {
    headers: { Origin: origin },
    data: { username: 'tester', password: testPassword },
  });
  expect(login.status()).toBe(200);
  const liveSession = await login.json();
  await page.reload();
  await page.locator('.account').click();
  await expect(page.getByRole('switch', { name: '离线笔记库' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('离线', { exact: true })).toBeVisible();

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'easynote_dev');
  expect(sessionCookie).toBeTruthy();
  const revoked = await fetch(`${origin}/api/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: `${sessionCookie!.name}=${sessionCookie!.value}`,
      'X-CSRF-Token': liveSession.csrf,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(revoked.status).toBe(200);

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible({ timeout: 10_000 });
  const cachedAccount = await page.evaluate(async (userId) => {
    const request = indexedDB.open('easynote');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('meta');
      return await Promise.all([`session:${userId}`, 'last-user'].map((key) => new Promise((resolve, reject) => {
        const read = tx.objectStore('meta').get(key);
        read.onsuccess = () => resolve(read.result ?? null);
        read.onerror = () => reject(read.error);
      })));
    } finally { db.close(); }
  }, testUserId);
  expect(cachedAccount).toEqual([null, null]);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await context.setOffline(false);
});


// Keep browser connectivity hints separate from actual API reachability.
test('manual sync and polling work when the browser incorrectly reports offline', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  const title = `联网误判-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await newNote(page, title, '初始正文');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const note = (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note;
  await page.getByRole('textbox', { name: '笔记正文' }).fill('误报离线时手动保存');
  await page.getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存并记录历史版本');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const saved = (await (await page.request.get(`/api/notes/${note.id}`)).json()).note;
  expect(saved.content).toBe('误报离线时手动保存');
  expect((await page.request.put(`/api/notes/${note.id}`, {
    headers, data: { ...saved, content: '另一设备的新内容', operationId: randomUUID() },
  })).status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('另一设备的新内容');
});

for (const offlineLibrary of [true, false]) {
  for (const failure of ['network', 'server'] as const) {
    test(`a transient ${failure} save failure with offline library ${offlineLibrary} is retried with the same operation ID`, async ({ page }) => {
      const title = `断线补传-${failure}-${randomUUID().slice(0, 8)}`;
      await page.goto('/');
      if (!offlineLibrary) await disableOfflineLibrary(page);
      await newNote(page, title, '已保存正文');
      await expect(page.getByRole('button', { name: '同步并更新历史版本', exact: true })).toBeEnabled();
      const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
      const id = listed.notes[0].id;
      const operations: string[] = [];
      await page.route(`**/api/notes/${id}`, async (route) => {
        if (route.request().method() === 'PUT') {
          operations.push(route.request().postDataJSON().operationId);
          if (operations.length === 1) {
            if (failure === 'network') await route.abort('failed');
            else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Temporary outage' } }) });
            return;
          }
        }
        await route.continue();
      });
      await page.getByRole('textbox', { name: '笔记正文' }).fill('网络恢复后自动补传');
      const sync = page.getByRole('button', { name: '同步并更新历史版本', exact: true });
      await expect(page.getByRole('alert')).toContainText(failure === 'network' ? 'Failed to fetch' : 'Temporary outage');
      await expect(sync).toBeEnabled();
      await expect(page.locator('.list-footer').getByText('离线', { exact: true })).toHaveCount(failure === 'network' ? 1 : 0);
      expect(operations).toHaveLength(1);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(operations).toHaveLength(2);
      expect(operations[1]).toBe(operations[0]);
      expect((await (await page.request.get(`/api/notes/${id}`)).json()).note.content).toBe('网络恢复后自动补传');
    });
  }

  test(`polling distinguishes network failures from HTTP errors with offline library ${offlineLibrary}`, async ({ page }) => {
    await page.goto('/');
    await newNote(page, `轮询状态-${randomUUID().slice(0, 8)}`, '准备完成');
    await expect(page.getByRole('button', { name: '同步并更新历史版本', exact: true })).toBeEnabled();
    if (!offlineLibrary) await disableOfflineLibrary(page);
    const offline = page.locator('.list-footer').getByText('离线', { exact: true });
    let failure: 'network' | 'server' | 'invalid-json' | null = 'server';
    await page.route('**/api/sync?*', async (route) => {
      if (failure === 'network') await route.abort('failed');
      else if (failure === 'server') await route.fulfill({ status: 503, contentType: 'text/html', body: 'Temporary outage' });
      else if (failure === 'invalid-json') await route.fulfill({ status: 200, contentType: 'text/html', body: 'Invalid JSON' });
      else await route.continue();
    });
    for (const kind of ['server', 'invalid-json', 'network', 'server', null] as const) {
      failure = kind;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      if (kind) await expect(page.getByRole('alert')).toContainText(
        kind === 'network' ? 'Failed to fetch' : kind === 'server' ? 'Temporary outage' : 'Invalid JSON');
      else await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(offline).toHaveCount(kind === 'network' ? 1 : 0);
    }
  });
}

test('automatic save retries stop after two retries and manual sync can resume them', async ({ page }) => {
  const title = `重试上限-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await newNote(page, title, '已保存正文');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const id = listed.notes[0].id;
  let puts = 0;
  let available = false;
  let syncReads = 0;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/sync') syncReads++;
  });
  await page.route(`**/api/notes/${id}`, async (route) => {
    if (route.request().method() === 'PUT') {
      puts++;
      if (!available) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Temporary outage' } }) });
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('达到上限后仍保留的草稿');
  await page.getByRole('button', { name: '同步并更新历史版本', exact: true }).click();
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  for (let attempt = 2; attempt <= 3; attempt++) {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => puts).toBe(attempt);
    await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  }
  const previousReads = syncReads;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => syncReads).toBeGreaterThan(previousReads);
  expect(puts).toBe(3);
  available = true;
  await page.getByRole('button', { name: '同步全部', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  expect(puts).toBe(4);
  expect((await (await page.request.get(`/api/notes/${id}`)).json()).note.content).toBe('达到上限后仍保留的草稿');
});

for (const purged of [false, true]) {
  test(`a delayed note read cannot overwrite ${purged ? 'a purge tombstone' : 'a newer synchronized revision'}`, async ({ page }) => {
    const id = randomUUID();
    const title = `旧响应-${randomUUID().slice(0, 8)}`;
    const input = { title, content: 'v1', tags: [], pinned: false, archived: false, deletedAt: null };
    expect((await page.request.post(`/api/notes/${id}`, {
      headers, data: { ...input, revision: 0, operationId: randomUUID() },
    })).status()).toBe(201);
    let syncReads = 0;
    page.on('requestfinished', (request) => {
      if (new URL(request.url()).pathname === '/api/sync') syncReads++;
    });
    await page.goto('/');
    await expect.poll(() => syncReads).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-note-row]').filter({ hasText: title })).toBeVisible();
    let release!: () => void;
    let fetched!: () => void;
    let delivered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { fetched = resolve; });
    const finished = new Promise<void>((resolve) => { delivered = resolve; });
    await page.route(`**/api/notes/${id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      fetched();
      await gate;
      try { await route.fulfill({ response }); }
      finally { delivered(); }
    });
    await page.locator('[data-note-row]').filter({ hasText: title }).click();
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('v1');
    await started;
    expect((await page.request.put(`/api/notes/${id}`, {
      headers, data: { ...input, content: 'v2', deletedAt: purged ? Date.now() : null, revision: 1, operationId: randomUUID() },
    })).status()).toBe(200);
    if (purged) expect((await page.request.delete(`/api/notes/${id}`, { headers, data: { revision: 2 } })).status()).toBe(200);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const editor = page.getByRole('textbox', { name: '笔记正文' });
    if (purged) await expect(editor).toHaveCount(0);
    else await expect(editor).toContainText('v2');
    const mirrored = () => page.evaluate(async ({ userId, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('easynote');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const note = await new Promise<{ content: string } | undefined>((resolve, reject) => {
        const request = db.transaction('notes').objectStore('notes').get(`${userId}:${id}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return note?.content ?? null;
    }, { userId: testUserId, id });
    // Moving to trash hides the editor before the later purge is mirrored.
    await expect.poll(mirrored).toBe(purged ? null : 'v2');
    release();
    await finished;
    if (purged) await expect(editor).toHaveCount(0);
    else await expect(editor).toContainText('v2');
    expect(await mirrored()).toBe(purged ? null : 'v2');
  });
}

test('a cached offline session reconnects despite a false browser connectivity hint', async ({ page, context }) => {
  const title = `离线会话重连-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await newNote(page, title, '已保存正文');
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('离线', { exact: true })).toBeVisible();
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await page.getByRole('textbox', { name: '笔记正文' }).fill('缓存会话验证后补传');
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible({ timeout: 15_000 });
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  expect((await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content).toBe('缓存会话验证后补传');
});

test('math formulas render in preview, shared and popout readers, PDF and an offline cold start', async ({ page, context, browser }) => {
  const title = `数学公式-${randomUUID().slice(0, 8)}`;
  const content = await readFile(new URL('../examples/math-demo.md', import.meta.url), 'utf8');
  await page.goto('/');
  await newNote(page, title, content);
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  const preview = page.locator('.document .markdown');
  await expect(preview.locator('math')).toHaveCount(7);
  await expect(preview.locator('.math-display')).toHaveCount(2);
  await expect(preview.locator('code').first()).toHaveText('$x^2$');
  await expect(preview.locator('.mermaid-diagram svg')).toHaveCount(1);
  await expect(preview).toContainText('价格 $20 and $30');
  expect(await preview.locator('math').first().getAttribute('display')).toBeNull();
  await preview.screenshot({ path: 'test-results/markdown-math.png' });
  await page.getByRole('button', { name: '导出当前笔记为 PDF' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('img', { name: 'PDF 第 1 页' }).screenshot({ path: 'test-results/markdown-math-pdf.png' });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  expect((new TextDecoder('latin1').decode(bytes).match(/\/Subtype\s*\/Image\b/g) ?? []).length).toBeGreaterThanOrEqual(6);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('[data-note-row]').filter({ hasText: title }).dblclick();
  const popup = await popupPromise;
  await expect(popup.locator('.markdown math')).toHaveCount(7);
  await expect(popup.locator('.mermaid-diagram svg')).toHaveCount(1);
  await popup.close();
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const share = await page.request.post(`/api/notes/${listed.notes[0].id}/share`, { headers, data: { expiresInHours: 24 } });
  expect(share.ok()).toBe(true);
  const anonymous = await browser.newContext();
  try {
    const shared = await anonymous.newPage();
    await shared.goto((await share.json()).url);
    await expect(shared.locator('.shared-document math')).toHaveCount(7);
    await expect(shared.locator('.mermaid-diagram svg')).toHaveCount(1);
  } finally { await anonymous.close(); }
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  await expect(page.locator('.document .markdown math')).toHaveCount(7);
  await context.setOffline(false);
});

test('a large private image and inline math export together, with cached images used only after failure', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const title = `大图公式-${randomUUID().slice(0, 8)}`;
  await newNote(page, title);
  // This case is about image bytes and PDF export, so it reads and edits the Markdown source directly; the
  // switch happens in the scenario setup so no mode change can race the later fills.
  await page.getByRole('button', { name: '源码模式' }).click();
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 65536) {
      crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
    }
    for (let offset = 3; offset < pixels.data.length; offset += 4) pixels.data[offset] = 255;
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  });
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
  await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const imageMarkdown = (await editor.innerText()).match(/!\[[^\]]*\]\(\/api\/images\/[a-f0-9-]+\)/)![0];
  const imagePath = imageMarkdown.match(/\/api\/images\/[a-f0-9-]+/)![0];
  await editor.fill(`同一段落的公式 $x^2$ 与大图 ${imageMarkdown}，图片后的公式 $y^2$。`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('easynote'); request.onsuccess = () => resolve(request.result); });
    try {
      return await new Promise<boolean>((resolve) => { const request = db.transaction('files').objectStore('files').get(key); request.onsuccess = () => resolve(!!request.result); });
    } finally { db.close(); }
  }, `${testUserId}:${imagePath.split('/').pop()}`)).toBe(true);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); });
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  const image = page.locator('.document .markdown img');
  await expect(image).toHaveJSProperty('naturalWidth', 1024);
  await expect(image).toHaveAttribute('src', imagePath);
  await page.getByRole('button', { name: '即时渲染模式', exact: true }).click();
  await page.route(`**${imagePath}`, (route) => route.abort('failed'));
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect(image).toHaveJSProperty('naturalWidth', 1024);
  await expect(page.locator('.document .markdown math')).toHaveCount(2);
  await page.getByRole('button', { name: '导出当前笔记为 PDF' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const bytes = await readFile((await (await downloadPromise).path())!);
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  expect(bytes.length).toBeGreaterThan(100_000);
});

test('invalid or untrusted TeX stays safe without breaking other formulas', async ({ page }) => {
  const title = `公式安全-${randomUUID().slice(0, 8)}`;
  const content = String.raw`正确公式 $x^2$。

未知命令 $\notARealCommand{x}$。

危险链接 $\href{javascript:alert(1)}{click}$。

外部图片 $\includegraphics{https://example.invalid/private.png}$。

递归宏 $\def\a{\a}\a$。`;
  let externalRequests = 0;
  page.on('request', (request) => { if (request.url().includes('example.invalid')) externalRequests++; });
  await page.goto('/');
  await newNote(page, title, content);
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  const preview = page.locator('.document .markdown');
  await expect(preview.locator('math').first()).toBeVisible();
  await expect(preview.locator('[data-math-display]')).toHaveCount(0);
  await expect(preview.locator('.math-error')).toHaveCount(2);
  await expect(preview.locator('a, img, script, iframe')).toHaveCount(0);
  expect(externalRequests).toBe(0);
});

test('folders create nested notes and context menu copies edits moves and trashes them', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const top = `目录-${marker}`, child = `子目录-${marker}`, title = `笔记-${marker}`;
  await page.goto('/');
  await createRootFolder(page);
  await page.getByRole('textbox', { name: '目录名' }).fill(top);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await createRootFolder(page);
  await page.getByRole('textbox', { name: '目录名' }).fill(top);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('同一层已存在同名目录。');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await folderAction(page, top, '新建子目录');
  await page.getByRole('textbox', { name: '目录名' }).fill(child);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await openFolder(page, child);
  await newNote(page, title, '原始正文');
  const sourceId = await page.locator('.note-row').filter({ hasText: title }).first().getAttribute('data-note-id');
  const source = page.locator(`[data-note-id="${sourceId}"]`);
  const folderId = (await (await page.request.get(`/api/notes/${sourceId}`)).json()).note.folderId;
  expect(folderId).toBeTruthy();
  await page.getByRole('textbox', { name: '笔记正文' }).fill('尚未同步的完整正文');
  await source.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(`${title}（副本）`);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('尚未同步的完整正文');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const copy = page.locator('.note-row').filter({ hasText: `${title}（副本）` });
  const copyId = await copy.getAttribute('data-note-id');
  expect(copyId).not.toBe(sourceId);
  await source.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeFocused();
  await copy.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动笔记', exact: true }).click();
  const movedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/notes/${copyId}` && response.request().method() === 'PUT' && response.ok());
  await page.getByRole('dialog').getByRole('button', { name: '根目录', exact: true }).click();
  await movedResponse;
  await expect(copy).toHaveCount(0);
  const moved = (await (await page.request.get(`/api/notes/${copyId}`)).json()).note;
  expect(moved.folderId).toBeNull();
  expect(moved.content).toBe('尚未同步的完整正文');
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await page.reload();
  await openFolder(page, child);
  await source.focus();
  await source.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: '复制笔记' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '编辑笔记' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(source).toBeFocused();
  await source.click({ button: 'right' });
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '搜索笔记', exact: true })).toBeFocused();
  await source.click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeVisible();
  await source.click({ button: 'right' });
  await page.getByRole('textbox', { name: '笔记正文' }).click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toBeFocused();
  await source.click({ button: 'right' });
  const deletedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/notes/${sourceId}` && response.request().method() === 'PUT' && response.ok());
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await deletedResponse;
  await expect(source).toHaveCount(0);
  expect((await (await page.request.get(`/api/notes/${sourceId}`)).json()).note.deletedAt).not.toBeNull();
});

test('folders enforce the fifth level in UI and remain available offline and on mobile', async ({ page, context }) => {
  const marker = randomUUID().slice(0, 8);
  let parentId: string | null = null;
  for (let depth = 1; depth <= 5; depth++) {
    const id = randomUUID();
    expect((await page.request.post('/api/folders', { headers, data: { id, name: `${marker}-${depth}`, parentId } })).status()).toBe(201);
    parentId = id;
  }
  await page.goto('/');
  await openFolder(page, `${marker}-4`);
  const fifth = page.locator('.folder-list-entry').filter({ hasText: `${marker}-5` });
  await fifth.locator('.folder-open').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '新建子目录' })).toBeDisabled();
  await page.getByRole('menuitem', { name: '重命名目录' }).click();
  await page.getByRole('textbox', { name: '目录名' }).fill(`${marker}-renamed`);
  await page.getByRole('dialog').getByRole('button', { name: '重命名', exact: true }).click();
  await openFolder(page, `${marker}-renamed`);
  await newNote(page, `离线-${marker}`, '目录中的离线笔记');
  await page.reload();
  await openFolder(page, `${marker}-renamed`);
  await expect(page.getByRole('heading', { name: `${marker}-renamed`, exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await openFolder(page, `${marker}-renamed`);
  await expect(page.locator('.note-row').filter({ hasText: `离线-${marker}` })).toBeVisible();
  await page.locator('.list-create-action').click();
  await expect(page.getByRole('menuitem', { name: '新建目录', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = await openMobileNavigation(page);
  await navigation.getByRole('button', { name: '关闭', exact: true }).click();
  await openFolder(page, `${marker}-renamed`);
  await page.locator('.note-row').filter({ hasText: `离线-${marker}` }).click();
  const actions = await openMobileNoteActions(page);
  await expect(actions.getByRole('button', { name: '复制笔记', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '移动笔记', exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('folders move from the sidebar and tolerate picking the current parent', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const home = randomUUID(), guest = randomUUID();
  for (const [id, name] of [[home, `家-${marker}`], [guest, `客-${marker}`]] as const) {
    expect((await page.request.post('/api/folders', { headers, data: { id, name, parentId: null } })).status()).toBe(201);
  }
  await page.goto('/');
  const guestRow = page.locator('.folder-list-entry').filter({ hasText: `客-${marker}` });
  await guestRow.locator('.folder-open').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动目录' }).click();
  // The picker hides the moved folder itself, and picking the current parent closes silently.
  await expect(page.getByRole('dialog').getByRole('button', { name: `客-${marker}`, exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '根目录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await guestRow.locator('.folder-open').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动目录' }).click();
  await page.getByRole('dialog').getByRole('button', { name: `家-${marker}`, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const folders = (await (await page.request.get('/api/folders')).json()).folders;
  expect(folders.find((folder: { id: string }) => folder.id === guest).parentId).toBe(home);
});

test('the create menu creates root folders, child folders and notes with keyboard support', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.sidebar [data-folder-id], .sidebar .folder-row')).toHaveCount(0);
  const trigger = page.locator('.list-create-action');
  await expect(trigger).toBeEnabled();
  await expect(trigger).not.toHaveAttribute('data-tooltip', /./);
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '新建笔记', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('create-menu.png') });
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '新建目录', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.press('Enter');
  await page.getByRole('menuitem', { name: '新建目录', exact: true }).click();
  await page.getByRole('dialog').press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  const name = `创建-${randomUUID()}`;
  await createRootFolder(page);
  await page.getByRole('textbox', { name: '目录名' }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  const row = page.locator('[data-folder-id]').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row.locator('.folder-more')).toBeHidden();
  await expect(row.locator('.lucide-chevron-right')).toHaveCount(0);
  const folderButton = row.locator('.folder-open');
  await folderButton.focus();
  await folderButton.press('Shift+F10');
  await page.keyboard.press('Escape');
  await expect(folderButton).toBeFocused();
  await folderButton.press('Shift+F10');
  await page.getByRole('menuitem', { name: '重命名目录', exact: true }).click();
  await page.getByRole('dialog').press('Escape');
  await expect(folderButton).toBeFocused();
  await openFolder(page, name);
  const parent = (await (await page.request.get('/api/folders')).json()).folders.find((folder: { name: string }) => folder.name === name);
  await trigger.click();
  await page.getByRole('menuitem', { name: '新建目录', exact: true }).click();
  await page.getByRole('textbox', { name: '目录名' }).fill(`${name}-子`);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  const child = (await (await page.request.get('/api/folders')).json()).folders.find((folder: { name: string }) => folder.name === `${name}-子`);
  expect(child.parentId).toBe(parent.id);
  await trigger.click();
  await page.getByRole('menuitem', { name: '新建笔记', exact: true }).click();
  await expect(page.locator('.note-row.selected')).toBeVisible();
  const id = await page.locator('.note-row.selected').getAttribute('data-note-id');
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${id}`)).json()).note?.folderId).toBe(parent.id);
});

test('breadcrumbs navigate folder levels without a redundant back button on desktop and mobile', async ({ page }, testInfo) => {
  const marker = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) expect((await page.request.post('/api/folders', {
    headers, data: { id, name: `${marker}-${index}`, parentId: ids[index - 1] ?? null },
  })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await openFolder(page, ids[2]);
  await page.screenshot({ path: testInfo.outputPath('desktop-folder-navigation.png') });
  const path = page.getByRole('navigation', { name: '目录路径' });
  await expect(path).toHaveCSS('flex-direction', 'row');
  expect(await page.locator('.list-heading h1').innerText()).toBe(`${marker}-2`);
  expect(await path.getByRole('button').allTextContents()).toEqual(['全部笔记', ...ids.map((_, index) => `${marker}-${index}`)]);
  await expect(page.getByRole('button', { name: '返回上一级', exact: true })).toHaveCount(0);
  await path.getByRole('button', { name: `${marker}-1`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${marker}-1`, exact: true })).toBeVisible();
  await path.getByRole('button', { name: `${marker}-0`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${marker}-0`, exact: true })).toBeVisible();
  await path.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回上一级', exact: true })).toHaveCount(0);
  // The root level shows no second line repeating the All Notes title.
  await expect(path).toHaveCount(0);
  await expect(page.locator('.list-heading h1')).toHaveText('全部笔记');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeHidden();
  await expect(page.locator('.list-scroll')).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: testInfo.outputPath('mobile-folder-list.png') });
  await openFolder(page, ids[2]);
  await path.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await path.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '返回上一级', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('mobile-folder-navigation.png') });
  await path.getByRole('button', { name: `${marker}-1`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${marker}-1`, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await path.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记', exact: true })).toBeVisible();
});

test('mobile folder actions rename and delete folders while creation follows the current level', async ({ page }) => {
  const marker = randomUUID(), parent = randomUUID(), child = randomUUID();
  for (const [id, name, parentId] of [[parent, `${marker}-父`, null], [child, `${marker}-子`, parent]] as const) {
    expect((await page.request.post('/api/folders', { headers, data: { id, name, parentId } })).status()).toBe(201);
  }
  await page.goto('/');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.list-create-action')).toBeVisible();
  const navigation = await openMobileNavigation(page);
  await expect(navigation.locator('[data-folder-id], .folder-row')).toHaveCount(0);
  await navigation.getByRole('button', { name: '关闭', exact: true }).click();
  await openFolder(page, parent);
  const row = page.locator(`[data-folder-id="${child}"]`);
  await row.getByRole('button', { name: '目录操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名目录', exact: true }).click();
  await page.getByRole('textbox', { name: '目录名' }).fill(`${marker}-改名`);
  await page.getByRole('dialog').getByRole('button', { name: '重命名', exact: true }).click();
  await expect(row).toContainText(`${marker}-改名`);
  await row.getByRole('button', { name: '目录操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除目录', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.locator('.list-create-action').click();
  await page.getByRole('menuitem', { name: '新建目录', exact: true }).click();
  await page.getByRole('textbox', { name: '目录名' }).fill(`${marker}-新建`);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  const created = (await (await page.request.get('/api/folders')).json()).folders.find((folder: { name: string }) => folder.name === `${marker}-新建`);
  expect(created.parentId).toBe(parent);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('folders can move and delete an unsynced new draft with the offline library disabled', async ({ page }) => {
  const sourceFolder = randomUUID(), targetFolder = randomUUID();
  for (const id of [sourceFolder, targetFolder]) expect((await page.request.post('/api/folders', {
    headers, data: { id, name: id, parentId: null },
  })).status()).toBe(201);
  await page.goto('/');
  await disableOfflineLibrary(page);
  for (const operation of ['move', 'delete']) {
    await openFolder(page, sourceFolder);
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'POST') await route.abort();
      else await route.continue();
    });
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
    await expect(page.locator('.note-row.selected')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue('');
    const title = `${operation}-${randomUUID()}`;
    await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
    await page.getByRole('textbox', { name: '笔记正文' }).fill('保留新草稿正文');
    await expect(page.getByText(/^(仅保存在本机|待处理草稿)$/)).toBeVisible();
    const row = page.locator('.note-row').filter({ hasText: title });
    const id = await row.getAttribute('data-note-id');
    expect((await page.request.get(`/api/notes/${id}`)).status()).toBe(404);
    await page.unroute('**/api/notes/*');
    const savedResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/notes/${id}` && ['POST', 'PUT'].includes(response.request().method()) && response.ok());
    await row.click({ button: 'right' });
    if (operation === 'move') {
      await page.getByRole('menuitem', { name: '移动笔记' }).click();
      await page.getByRole('dialog').getByRole('button', { name: targetFolder, exact: true }).click();
    } else await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await savedResponse;
    await expect(row).toHaveCount(0);
    const saved = (await (await page.request.get(`/api/notes/${id}`)).json()).note;
    expect(saved.content).toBe('保留新草稿正文');
    if (operation === 'move') expect(saved.folderId).toBe(targetFolder);
    else expect(saved.deletedAt).not.toBeNull();
  }
});

test('folder notes keep their manual order through keyboard reordering and folder drops', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const home = randomUUID(), other = randomUUID();
  const homeName = `甲-${marker}`, otherName = `乙-${marker}`;
  for (const [id, name] of [[home, homeName], [other, otherName]]) {
    expect((await page.request.post('/api/folders', { headers, data: { id, name, parentId: null } })).status()).toBe(201);
  }
  for (const title of [`一-${marker}`, `二-${marker}`, `三-${marker}`]) {
    expect((await page.request.post(`${origin}/api/notes/${randomUUID()}`, { headers, data: {
      title, content: '顺序验证', tags: [], pinned: false, archived: false, deletedAt: null,
      folderId: home, revision: 0, operationId: randomUUID(),
    } })).status()).toBe(201);
  }

  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  await openFolder(page, homeName);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(3);
  const order = () => rows.locator('.note-row-title span').allInnerTexts();
  const before = await order();

  // Alt+Arrow reuses the drag reorder path: the focused row steps one slot down.
  const orderCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/notes/order')) orderCalls.push(request.postData() ?? '');
  });
  await rows.nth(0).press('Alt+ArrowDown');
  expect(orderCalls, orderCalls.join(' | ')).toHaveLength(1);
  await expect.poll(order).toEqual([before[1], before[0], before[2]]);
  const moving = rows.filter({ hasText: before[0] });
  await expect(moving).toBeFocused();
  await moving.press('Alt+ArrowDown');
  await expect.poll(order).toEqual([before[1], before[2], before[0]]);
  await expect(moving).toBeFocused();

  // The order is server-side, so it survives a reload instead of living in the list state.
  await page.reload();
  await openFolder(page, homeName);
  await expect.poll(order).toEqual([before[1], before[2], before[0]]);

  // Dropping a row on a folder row moves the note there and appends it.
  await rows.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动笔记', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: otherName, exact: true }).click();
  await expect(rows.filter({ hasText: before[1] })).toHaveCount(0);
  await openFolder(page, otherName);
  await expect(page.locator('[data-note-row]')).toHaveCount(1);
  await expect(page.locator('.note-row-title span')).toHaveText(before[1]);
});

test('manual folder pagination rebuilds after a remote reorder without losing or duplicating notes', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const folderId = randomUUID();
  const folderName = `分页目录-${marker}`;
  expect((await page.request.post('/api/folders', {
    headers, data: { id: folderId, name: folderName, parentId: null },
  })).status()).toBe(201);

  const allIds: string[] = [];
  for (let index = 0; index < 80; index++) {
    const id = randomUUID();
    allIds.push(id);
    const response = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `${marker}-${String(index).padStart(2, '0')}`,
        content: '分页顺序', tags: [], pinned: false, archived: false, deletedAt: null,
        folderId, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  // Establish a deterministic manual order matching allIds (first -> last) before the UI loads.
  expect((await page.request.patch(`${origin}/api/notes/order`, {
    headers, data: { ids: allIds },
  })).status()).toBe(200);

  await page.goto('/');
  await disableOfflineLibrary(page);
  await openFolder(page, folderName);
  await expect(page.locator('.note-row')).toHaveCount(50);
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();

  // Another device moves the first note to the end of the folder.
  expect((await page.request.patch(`${origin}/api/notes/order`, {
    headers, data: { ids: [allIds[0]], afterId: allIds[79] },
  })).status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // The rebuilt prefix must drop the moved note and admit the one that slid in from the boundary.
  await expect(page.locator('.note-row').filter({ hasText: `${marker}-00` })).toHaveCount(0);
  await expect(page.locator('.note-row').filter({ hasText: `${marker}-50` })).toHaveCount(1);
  await expect(page.locator('.note-row')).toHaveCount(50);

  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.locator('.note-row')).toHaveCount(80);
  const titles = await page.locator('.note-row .note-row-title span').allInnerTexts();
  const expected = allIds.map((_, index) => `${marker}-${String(index).padStart(2, '0')}`);
  expect(titles.length).toBe(80);
  expect(new Set(titles).size).toBe(80);
  expect([...titles].sort()).toEqual([...expected].sort());
  // The target lives beyond the first server page; placement uses its real ID.
  const moving = page.locator(`[data-note-id="${allIds[1]}"]`);
  const target = page.locator(`[data-note-id="${allIds[65]}"]`);
  await moving.scrollIntoViewIfNeeded();
  const sourceBox = (await moving.boundingBox())!;
  await page.mouse.move(sourceBox.x + 50, sourceBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 70, sourceBox.y + 20, { steps: 5 });
  // Start the native drag before scrolling to its offscreen target.
  await target.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const targetBox = (await target.boundingBox())!;
  await page.mouse.move(targetBox.x + 50, targetBox.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => {
    const first = (await (await page.request.get(`/api/notes?folder=${folderId}&sort=manual&limit=50`)).json()).notes;
    const second = (await (await page.request.get(`/api/notes?folder=${folderId}&sort=manual&offset=50&limit=50`)).json()).notes;
    const ordered = [...first, ...second].map((note: { id: string }) => note.id);
    return ordered[ordered.indexOf(allIds[65]) - 1];
  }).toBe(allIds[1]);
});

async function seedOrderFolder(page: Page, count = 3, parentId: string | null = null) {
  const folderId = randomUUID();
  expect((await page.request.post('/api/folders', { headers, data: { id: folderId, name: folderId, parentId } })).status()).toBe(201);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    ids.push(id);
    expect((await page.request.post(`/api/notes/${id}`, { headers, data: {
      title: `${folderId}-${index}`, content: '原始正文', tags: [], pinned: false, archived: false,
      deletedAt: null, folderId, revision: 0, operationId: randomUUID(),
    } })).status()).toBe(201);
  }
  if (ids.length) expect((await page.request.patch('/api/notes/order', { headers, data: { ids } })).status()).toBe(200);
  return { folderId, ids };
}
async function storedOrderNote(page: Page, id: string, store: 'notes' | 'drafts') {
  return page.evaluate(async ({ id, store, userId }) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('easynote');
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<import('../src/shared/types').Note | import('../src/client/drafts').Draft | undefined>((resolve) => {
        const request = db.transaction(store).objectStore(store).get(`${userId}:${id}`);
        request.onsuccess = () => resolve(request.result);
      });
    } finally { db.close(); }
  }, { id, store, userId: testUserId });
}

for (const width of [1440, 390]) {
  test(`cached folders switch without timers or a false empty state at width ${width}`, async ({ page, context }) => {
    const filled = await seedOrderFolder(page, 1);
    const empty = await seedOrderFolder(page, 0);
    await page.setViewportSize({ width, height: 960 });
    await page.clock.install();
    await page.goto('/');
    const list = page.locator('.list-scroll');
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(list.locator(`[data-folder-id="${filled.folderId}"]`)).toBeVisible();
    await context.setOffline(true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));

    await list.locator(`[data-folder-id="${filled.folderId}"] .folder-open`).click();
    await expect(list.locator(`[data-note-id="${filled.ids[0]}"]`)).toBeVisible();
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(list.getByText('暂无笔记', { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }).click();
    await list.locator(`[data-folder-id="${empty.folderId}"] .folder-open`).click();
    await expect(list.getByText('暂无笔记', { exact: true })).toBeVisible();
    await expect(list.locator('[data-note-row]')).toHaveCount(0);
  });
}

test('online folder switches start immediately and ignore an abandoned response while search stays debounced', async ({ page }, testInfo) => {
  const a = await seedOrderFolder(page, 1);
  const b = await seedOrderFolder(page, 1);
  await page.clock.install();
  await page.goto('/');
  await disableOfflineLibrary(page);
  const list = page.locator('.list-scroll');
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let finished!: () => void;
  const handled = new Promise<void>((resolve) => { finished = resolve; });
  await page.route('**/api/notes?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('folder') !== a.folderId) return route.continue();
    const response = await route.fetch();
    await held;
    try { await route.fulfill({ response }); } finally { finished(); }
  });
  const requested = page.waitForRequest((request) => new URL(request.url()).searchParams.get('folder') === a.folderId);
  await list.locator(`[data-folder-id="${a.folderId}"] .folder-open`).click();
  await requested;
  await expect(list).toHaveAttribute('aria-busy', 'true');
  await expect(list.getByRole('status', { name: '正在加载…' })).toBeVisible();
  await expect(list.getByText('暂无笔记', { exact: true })).toHaveCount(0);
  await list.screenshot({ path: testInfo.outputPath('folder-loading.png') });
  await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await list.locator(`[data-folder-id="${b.folderId}"] .folder-open`).click();
  await expect(list.locator(`[data-note-id="${b.ids[0]}"]`)).toBeVisible();
  release();
  await handled;
  await expect(list.locator(`[data-note-id="${a.ids[0]}"]`)).toHaveCount(0);
  await expect(list.locator(`[data-note-id="${b.ids[0]}"]`)).toBeVisible();

  const queries: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/notes' && url.searchParams.get('q')) queries.push(url.searchParams.get('q')!);
  });
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(a.folderId);
  await page.clock.runFor(199);
  expect(queries).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(() => queries).toEqual([a.folderId]);
  await expect(list.locator(`[data-note-id="${a.ids[0]}"]`)).toBeVisible();
  await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(list.locator(`[data-folder-id="${b.folderId}"]`)).toBeVisible();
});

test('a late save keeps the list in the newly selected cached folder', async ({ page }) => {
  const a = await seedOrderFolder(page, 1);
  const b = await seedOrderFolder(page, 1);
  await page.clock.install();
  await page.goto('/');
  await openFolder(page, a.folderId);
  await page.locator(`[data-note-id="${a.ids[0]}"]`).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toHaveText('原始正文');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/notes/${a.ids[0]}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const saving = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith(`/api/notes/${a.ids[0]}`));
  await editor.fill('切换时仍保留保存内容');
  await page.clock.runFor(500);
  await saving;
  await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.locator(`[data-folder-id="${b.folderId}"] .folder-open`).click();
  const list = page.locator('.list-scroll');
  await expect(list.locator(`[data-note-id="${b.ids[0]}"]`)).toBeVisible();
  release();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect(list.locator(`[data-note-id="${b.ids[0]}"]`)).toBeVisible();
  await expect(list.locator(`[data-note-id="${a.ids[0]}"]`)).toHaveCount(0);
  expect((await (await page.request.get(`/api/notes/${a.ids[0]}`)).json()).note.content).toBe('切换时仍保留保存内容');
});

for (const [enabled, endpoint, globalRetry = false] of [
  [false, '/api/notes'],
  [false, '/api/notes', true],
  [false, '/api/folders'],
  [false, '/api/sync/cursor'],
  [false, '/api/sync'],
  [false, '/api/tags'],
  [true, '/api/folders'],
  [true, '/api/sync'],
] as const) {
  test(`startup retry restores navigation after ${endpoint} fails with offline library ${enabled} via ${globalRetry ? 'global' : 'list'} retry`, async ({ page }) => {
    const folder = await seedOrderFolder(page, 1);
    const rootId = randomUUID();
    expect((await page.request.post(`/api/notes/${rootId}`, { headers, data: {
      title: `启动恢复-${rootId}`, content: '根层正文', tags: [], pinned: false, archived: false,
      deletedAt: null, folderId: null, revision: 0, operationId: randomUUID(),
    } })).status()).toBe(201);
    if (!enabled) {
      await page.goto('/');
      await disableOfflineLibrary(page);
    }
    let attempts = 0;
    const failures = endpoint === '/api/notes' ? 2 : 1;
    await page.route((url) => url.pathname === endpoint, (route) => {
      if (route.request().method() === 'GET' && attempts++ < failures) {
        return route.fulfill({ status: 500, json: { error: { message: 'test startup failure' } } });
      }
      return route.continue();
    });
    if (enabled) await page.goto('/');
    else await page.reload();
    const list = page.locator('.list-scroll');
    for (let attempt = 0; attempt < failures; attempt++) {
      await expect(list.getByText('笔记列表加载失败', { exact: true })).toBeVisible();
      await expect(list).toHaveAttribute('aria-busy', 'false');
      const feedback = globalRetry ? page.getByRole('alert') : list;
      await feedback.getByRole('button', { name: '重试', exact: true }).click();
    }
    await expect(list.locator(`[data-note-id="${rootId}"]`)).toBeVisible();
    await list.locator(`[data-folder-id="${folder.folderId}"] .folder-open`).click();
    await expect(list.locator(`[data-note-id="${folder.ids[0]}"]`)).toBeVisible();
    await page.getByRole('button', { name: '排序方式', exact: true }).click();
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(list.locator(`[data-note-id="${folder.ids[0]}"]`)).toBeVisible();
    await page.locator('.sidebar nav.folder-nav').getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.locator('.list-heading h1')).toHaveText('归档笔记');
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(list.locator(`[data-note-id="${folder.ids[0]}"]`)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(attempts).toBeGreaterThan(failures);
  });
}

test('online folder failures offer retry and empty folders appear only after a successful response', async ({ page }) => {
  const filled = await seedOrderFolder(page, 1);
  const empty = await seedOrderFolder(page, 0);
  await page.goto('/');
  await disableOfflineLibrary(page);
  let fail = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/notes?**', async (route) => {
    const folder = new URL(route.request().url()).searchParams.get('folder');
    if (folder === filled.folderId && fail) {
      fail = false;
      return route.fulfill({ status: 500, json: { error: { message: 'test list failure' } } });
    }
    if (folder === empty.folderId) await held;
    return route.continue();
  });
  const list = page.locator('.list-scroll');
  await list.locator(`[data-folder-id="${filled.folderId}"] .folder-open`).click();
  await expect(list.getByText('笔记列表加载失败', { exact: true })).toBeVisible();
  await expect(list.getByText('暂无笔记', { exact: true })).toHaveCount(0);
  await list.getByRole('button', { name: '重试', exact: true }).click();
  await expect(list.locator(`[data-note-id="${filled.ids[0]}"]`)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }).click();
  await list.locator(`[data-folder-id="${empty.folderId}"] .folder-open`).click();
  await expect(list).toHaveAttribute('aria-busy', 'true');
  await expect(list.getByText('暂无笔记', { exact: true })).toHaveCount(0);
  release();
  await expect(list.getByText('暂无笔记', { exact: true })).toBeVisible();
  await expect(list).toHaveAttribute('aria-busy', 'false');
});

for (const enabled of [true, false]) {
  test(`mixed folder browsing hides filed notes and searches globally with offline library ${enabled ? 'enabled' : 'disabled'}`, async ({ page, context }) => {
    const marker = `混排-${randomUUID()}`;
    const parent = randomUUID(), child = randomUUID();
    for (const [id, name, parentId] of [[parent, `${marker}-目录`, null], [child, `${marker}-子目录`, parent]] as const) {
      expect((await page.request.post('/api/folders', { headers, data: { id, name, parentId } })).status()).toBe(201);
    }
    const rootNote = randomUUID(), filedNote = randomUUID(), nestedNote = randomUUID();
    for (const [id, suffix, folderId] of [[rootNote, '根层', null], [filedNote, '已分类', parent], [nestedNote, '深层', child]] as const) {
      expect((await page.request.post(`/api/notes/${id}`, { headers, data: {
        title: `${marker}-${suffix}`, content: marker, tags: [], pinned: false, archived: false,
        deletedAt: null, folderId, revision: 0, operationId: randomUUID(),
      } })).status()).toBe(201);
    }
    await page.goto('/');
    if (!enabled) await disableOfflineLibrary(page);
    const list = page.locator('.list-scroll');
    const nav = page.locator('.sidebar nav.folder-nav');
    const parentRow = list.locator(`[data-folder-id="${parent}"]`);
    await expect(parentRow).toBeVisible();
    await expect(list.locator(`[data-note-id="${rootNote}"]`)).toBeVisible();
    await expect(list.locator(`[data-note-id="${filedNote}"]`)).toHaveCount(0);
    await expect(list.locator(`[data-note-id="${nestedNote}"]`)).toHaveCount(0);
    await expect(list.locator(`[data-folder-id="${child}"]`)).toHaveCount(0);
    await parentRow.click();
    await expect(list.locator(`[data-folder-id="${child}"]`)).toBeVisible();
    await expect(list.locator(`[data-note-id="${filedNote}"]`)).toBeVisible();
    await expect(list.locator(`[data-note-id="${nestedNote}"]`)).toHaveCount(0);
    const search = page.getByRole('textbox', { name: '搜索笔记', exact: true });
    await search.fill(marker);
    for (const id of [rootNote, filedNote, nestedNote]) await expect(list.locator(`[data-note-id="${id}"]`)).toBeVisible();
    await expect(list.locator('[data-folder-id]')).toHaveCount(0);
    await search.fill('');
    await nav.getByRole('button', { name: '全部笔记', exact: true }).click();
    await list.locator(`[data-note-id="${rootNote}"]`).dragTo(parentRow);
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${rootNote}`)).json()).note.folderId).toBe(parent);
    await expect(list.locator(`[data-note-id="${rootNote}"]`)).toHaveCount(0);
    await parentRow.click();
    await expect(list.locator(`[data-note-id="${rootNote}"]`)).toBeVisible();
    await list.locator(`[data-note-id="${rootNote}"]`).dragTo(nav.getByRole('button', { name: '全部笔记', exact: true }));
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${rootNote}`)).json()).note.folderId).toBeNull();
    await nav.getByRole('button', { name: '全部笔记', exact: true }).click();
    await expect(list.locator(`[data-note-id="${rootNote}"]`)).toBeVisible();
    if (enabled) {
      await context.setOffline(true);
      await page.reload();
      await expect(parentRow).toBeVisible();
      await expect(list.locator(`[data-note-id="${rootNote}"]`)).toBeVisible();
      await expect(list.locator(`[data-note-id="${filedNote}"]`)).toHaveCount(0);
      await parentRow.click();
      await expect(list.locator(`[data-note-id="${filedNote}"]`)).toBeVisible();
      await search.fill(marker);
      for (const id of [rootNote, filedNote, nestedNote]) await expect(list.locator(`[data-note-id="${id}"]`)).toBeVisible();
      await context.setOffline(false);
    }
  });
}

test('all notes is the only root entry on desktop and mobile and folder sort preferences are independent', async ({ page, context }) => {
  const a = await seedOrderFolder(page);
  const b = await seedOrderFolder(page);
  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  const sort = page.getByRole('button', { name: '排序方式', exact: true });
  await expect(sort).toBeVisible();
  const headerOrder = await page.locator('.list-heading > button').evaluateAll((nodes) => nodes
    .filter((node) => (node as HTMLElement).offsetParent !== null)
    .map((node) => node.getAttribute('class')));
  expect(headerOrder).toEqual([
    'icon-button list-command-action',
    'sort-toggle',
    'icon-button list-bulk-action',
    'icon-button list-sync-action',
    'icon-button list-create-action',
  ]);
  await expect(nav.getByRole('button', { name: '根目录', exact: true })).toHaveCount(0);
  const allNotes = nav.getByRole('button', { name: '全部笔记', exact: true });
  await allNotes.focus();
  await allNotes.press('Enter');
  await expect(sort).toHaveText('最近修改');
  await expect(page.locator(`.list-scroll [data-folder-id="${a.folderId}"]`)).toBeVisible();
  await expect(page.locator(`.list-scroll [data-folder-id="${b.folderId}"]`)).toBeVisible();
  await expect(page.locator(`[data-note-id="${a.ids[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-note-id="${b.ids[0]}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  const title = `未分类-${randomUUID()}`;
  await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const created = (await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json()).notes[0];
  expect(created.folderId).toBeNull();
  await openFolder(page, a.folderId);
  await sort.click();
  await expect(sort).toHaveText('最近修改');
  await openFolder(page, b.folderId);
  await expect(sort).toHaveText('手动排序');
  await openFolder(page, a.folderId);
  await expect(sort).toHaveText('最近修改');
  await page.reload();
  await openFolder(page, a.folderId);
  await expect(sort).toHaveText('最近修改');
  await openFolder(page, b.folderId);
  await expect(sort).toHaveText('手动排序');
  await context.setOffline(true);
  await expect(page.getByText('离线', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-note-id="${b.ids[0]}"]`)).toHaveAttribute('draggable', 'false');
  let orderCalls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/notes/order')) orderCalls++; });
  await page.locator(`[data-note-id="${b.ids[0]}"]`).press('Alt+ArrowDown');
  expect(orderCalls).toBe(0);
  expect(await page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')))).toEqual(b.ids);
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = await openMobileNavigation(page);
  await expect(navigation.getByRole('button', { name: '根目录', exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(page.locator('[data-note-row]').filter({ hasText: title })).toBeVisible();
  await context.setOffline(false);
});

test('all notes accepts folder drops back to the root level', async ({ page }) => {
  const marker = randomUUID();
  for (let index = 0; index < 32; index++) {
    expect((await page.request.post('/api/folders', {
      headers, data: { id: randomUUID(), name: `000-${index}-${marker}`, parentId: null },
    })).status()).toBe(201);
  }
  const parent = await seedOrderFolder(page, 0);
  const child = randomUUID();
  expect((await page.request.post('/api/folders', {
    headers, data: { id: child, name: child, parentId: parent.folderId },
  })).status()).toBe(201);
  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  await openFolder(page, parent.folderId);
  const source = page.locator(`[data-folder-id="${child}"] .folder-open`);
  const moved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/folders/${child}` && response.request().method() === 'PATCH' && response.ok());
  await source.dragTo(page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: '全部笔记', exact: true }));
  await moved;
  await expect.poll(async () => {
    const { folders } = await (await page.request.get('/api/folders')).json();
    return folders.find((folder: { id: string }) => folder.id === child)?.parentId;
  }).toBeNull();
  await page.reload();
  await expect(page.locator(`[data-folder-id="${child}"]`)).toBeVisible();
  await expect(nav.getByRole('button', { name: '根目录', exact: true })).toHaveCount(0);
});

test('folder search stays recent and forbids list sorting while allowing folder drops', async ({ page }) => {
  const a = await seedOrderFolder(page), b = await seedOrderFolder(page, 0);
  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  await openFolder(page, a.folderId);
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(a.folderId);
  await expect(page.getByRole('button', { name: '排序方式', exact: true })).toHaveCount(0);
  const recent = (await (await page.request.get(`/api/notes?folder=${a.folderId}&q=${a.folderId}`)).json()).notes.map((note: { id: string }) => note.id);
  const order = () => page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')));
  await expect.poll(order).toEqual(recent);
  let orderCalls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/notes/order')) orderCalls++; });
  const row = page.locator(`[data-note-id="${recent[0]}"]`);
  await row.press('Alt+ArrowDown');
  await row.dragTo(page.locator(`[data-note-id="${recent[1]}"]`));
  expect(orderCalls).toBe(0);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动笔记', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: b.folderId, exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${recent[0]}`)).json()).note.folderId).toBe(b.folderId);
});

test('folder keyboard ordering uses Chinese display order and retains focus at boundaries', async ({ page }) => {
  const { folderId: parent } = await seedOrderFolder(page, 0);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, name] of ['阿', '波', '张'].entries()) {
    expect((await page.request.post('/api/folders', { headers, data: { id: ids[index], name: `${name}-${parent}`, parentId: parent } })).status()).toBe(201);
  }
  await page.goto('/');
  await openFolder(page, parent);
  const names = () => page.locator('.folder-list-entry .note-row-title span').allTextContents();
  const zhang = page.locator('.folder-list-entry').getByRole('button', { name: `张-${parent}`, exact: true });
  await zhang.press('Alt+ArrowUp');
  await expect.poll(names).toEqual([`阿-${parent}`, `张-${parent}`, `波-${parent}`]);
  await expect(zhang).toBeFocused();
  await zhang.press('Alt+ArrowUp');
  await expect.poll(names).toEqual([`张-${parent}`, `阿-${parent}`, `波-${parent}`]);
  await expect(zhang).toBeFocused();
  const atBoundary = page.waitForTimeout(100);
  await zhang.press('Alt+ArrowUp');
  await atBoundary;
  await expect(zhang).toBeFocused();
  await page.reload();
  await openFolder(page, parent);
  await expect.poll(names).toEqual([`张-${parent}`, `阿-${parent}`, `波-${parent}`]);
});

test('multi-note folder drops append the entire stable selection including resident notes and root', async ({ page }) => {
  const a = await seedOrderFolder(page, 2), b = await seedOrderFolder(page, 3);
  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('原始正文');
  const wanted = new Set([a.ids[0], a.ids[1], b.ids[0]]);
  for (const id of wanted) await expect(page.locator(`[data-note-id="${id}"]`)).toBeVisible();
  await page.getByRole('button', { name: '批量选择', exact: true }).click();
  const selectedIds = (await page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')!))).filter((id) => wanted.has(id));
  for (const id of selectedIds) await page.locator(`[data-note-id="${id}"]`).click();
  const ordered = async (folder: string) => (await (await page.request.get(`/api/notes?folder=${folder}&sort=manual`)).json()).notes.map((note: { id: string }) => note.id);
  await page.locator('.bulk-toolbar').getByRole('button', { name: '移动笔记', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: b.folderId, exact: true }).click();
  await expect.poll(() => ordered(b.folderId)).toEqual([...b.ids.slice(1), ...selectedIds]);
  await openFolder(page, b.folderId);
  // Dropping a note in its current folder is still an append, even though no content save is needed.
  await page.locator(`[data-note-id="${b.ids[1]}"]`).dragTo(page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: b.folderId, exact: true }));
  await expect.poll(() => ordered(b.folderId)).toEqual([b.ids[2], ...selectedIds, b.ids[1]]);
  await page.locator(`[data-note-id="${b.ids[1]}"]`).dragTo(nav.getByRole('button', { name: '全部笔记', exact: true }));
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${b.ids[1]}`)).json()).note.folderId).toBeNull();
  await nav.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill(`${b.folderId}-1`);
  await expect(page.locator(`[data-note-id="${b.ids[1]}"]`)).toBeVisible();
});

for (const enabled of [true, false]) {
  test(`remote order updates current and pending drafts with offline library ${enabled ? 'enabled' : 'disabled'}`, async ({ page }) => {
    const { folderId, ids } = await seedOrderFolder(page);
    await page.goto('/');
    if (!enabled) await disableOfflineLibrary(page);
    await openFolder(page, folderId);
    await page.locator(`[data-note-id="${ids[0]}"]`).click();
    expect((await page.request.patch('/api/notes/order', { headers, data: { ids: [ids[0]] } })).status()).toBe(200);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const rowIds = () => page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')));
    await expect.poll(rowIds).toEqual([ids[1], ids[2], ids[0]]);
    await page.getByRole('textbox', { name: '笔记正文' }).fill('顺序同步后继续编辑');
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    await expect.poll(rowIds).toEqual([ids[1], ids[2], ids[0]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route(`**/api/notes/${ids[0]}`, async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      held = true;
      await gate;
      await route.continue();
    });
    try {
      await page.getByRole('textbox', { name: '笔记正文' }).fill('未保存草稿正文');
      await expect.poll(() => held).toBe(true);
      const before = await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft;
      expect((await page.request.patch('/api/notes/order', { headers, data: { ids: [ids[0]], beforeId: ids[1] } })).status()).toBe(200);
      const remote = (await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(async () => (await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft)?.note.position).toBe(remote.position);
      const after = await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft;
      expect(after).toEqual({ ...before, note: { ...before.note, position: remote.position } });
      await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('未保存草稿正文');
      await expect.poll(rowIds).toEqual(ids);
      release();
      await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
      await expect.poll(rowIds).toEqual(ids);
    } finally { release(); }
  });

  for (const newerDraft of [false, true]) {
    test(`late save response preserves newer position with ${newerDraft ? 'new' : 'same'} draft and offline library ${enabled ? 'enabled' : 'disabled'}`, async ({ page }) => {
      const { folderId, ids } = await seedOrderFolder(page);
      await page.goto('/');
      if (!enabled) await disableOfflineLibrary(page);
      await openFolder(page, folderId);
      await page.locator(`[data-note-id="${ids[0]}"]`).click();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      await page.route(`**/api/notes/${ids[0]}`, async (route) => {
        if (route.request().method() !== 'PUT' || held) { await route.continue(); return; }
        held = true;
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      });
      try {
        await page.getByRole('textbox', { name: '笔记正文' }).fill('已发出的保存正文');
        await expect.poll(() => held).toBe(true);
        // Wait until the server has saved, while its response remains delayed on this device.
        await expect.poll(async () => (await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note.content).toBe('已发出的保存正文');
        if (newerDraft) await page.getByRole('textbox', { name: '笔记正文' }).fill('保存期间的新草稿正文');
        let observedPosition: number | undefined;
        page.on('response', async (response) => {
          if (new URL(response.url()).pathname !== '/api/sync' || !response.ok()) return;
          const synced = await response.json().catch(() => ({ changes: [] }));
          const change = synced.changes.find((change: { noteId: string }) => change.noteId === ids[0]);
          if (change?.note) observedPosition = change.note.position;
        });
        expect((await page.request.patch('/api/notes/order', { headers, data: { ids: [ids[0]] } })).status()).toBe(200);
        const remote = (await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note;
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        const rowIds = () => page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')));
        // A draft keeps its revision until the delayed save is acknowledged.
        await expect.poll(() => observedPosition).toBe(remote.position);
        release();
        await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
        await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText(newerDraft ? '保存期间的新草稿正文' : '已发出的保存正文');
        await expect.poll(rowIds).toEqual([ids[1], ids[2], ids[0]]);
        if (enabled) await expect.poll(async () => (await storedOrderNote(page, ids[0], 'notes') as import('../src/shared/types').Note)?.position).toBe(remote.position);
        expect((await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note.content).toBe(newerDraft ? '保存期间的新草稿正文' : '已发出的保存正文');
        await page.getByRole('textbox', { name: '笔记正文' }).fill('响应后继续编辑');
        await expect.poll(async () => (await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft)?.note.position).toBe(remote.position);
        await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
        await expect.poll(rowIds).toEqual([ids[1], ids[2], ids[0]]);
      } finally { release(); }
    });
  }
}

test('a local reorder during save preserves the same operation draft and the acknowledged position', async ({ page }) => {
  const { folderId, ids } = await seedOrderFolder(page);
  await page.goto('/');
  await openFolder(page, folderId);
  await page.locator(`[data-note-id="${ids[0]}"]`).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route(`**/api/notes/${ids[0]}`, async (route) => {
    if (route.request().method() !== 'PUT' || held) { await route.continue(); return; }
    held = true;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('textbox', { name: '笔记正文' }).fill('保存与排序并行');
    await expect.poll(() => held).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note.content).toBe('保存与排序并行');
    const before = await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft;
    await page.locator(`[data-note-id="${ids[0]}"]`).press('Alt+ArrowDown');
    await expect.poll(async () => (await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft)?.note.position).not.toBe(before.note.position);
    const after = await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft;
    expect(after).toEqual({ ...before, note: { ...before.note, position: after.note.position } });
    release();
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    await expect.poll(async () => (await storedOrderNote(page, ids[0], 'notes') as import('../src/shared/types').Note)?.position).toBe(after.note.position);
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('保存与排序并行');
  } finally { release(); }
});

test('a partially failed group move never reorders the whole selection', async ({ page }) => {
  const a = await seedOrderFolder(page), b = await seedOrderFolder(page, 0);
  await page.goto('/');
  const nav = page.locator('.sidebar nav.folder-nav');
  await openFolder(page, a.folderId);
  await page.getByRole('button', { name: '批量选择', exact: true }).click();
  for (const id of a.ids) await page.locator(`[data-note-id="${id}"]`).click();
  let orderCalls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/notes/order')) orderCalls++; });
  await page.route(`**/api/notes/${a.ids[1]}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort(); else await route.continue();
  });
  await page.locator('.bulk-toolbar').getByRole('button', { name: '移动笔记', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: b.folderId, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('批量操作已处理 1 篇');
  expect(orderCalls).toBe(0);
  for (const [index, id] of a.ids.entries()) {
    const note = (await (await page.request.get(`/api/notes/${id}`)).json()).note;
    expect(note.folderId).toBe(index === 0 ? b.folderId : a.folderId);
    expect(note.content).toBe('原始正文');
  }
});

test('remote order in a failed draft survives an offline cold start', async ({ page, context }) => {
  const { folderId, ids } = await seedOrderFolder(page);
  await page.goto('/');
  await openFolder(page, folderId);
  await page.locator(`[data-note-id="${ids[0]}"]`).click();
  await page.route(`**/api/notes/${ids[0]}`, async (route) => {
    if (route.request().method() === 'PUT') await route.abort(); else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('冷启动保留正文');
  await expect(page.getByText(/^(仅保存在本机|待处理草稿)$/)).toBeVisible();
  expect((await page.request.patch('/api/notes/order', { headers, data: { ids: [ids[0]] } })).status()).toBe(200);
  const remote = (await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => (await storedOrderNote(page, ids[0], 'drafts') as import('../src/client/drafts').Draft)?.note.position).toBe(remote.position);
  await context.setOffline(true);
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openFolder(page, folderId);
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveText('冷启动保留正文');
  await expect.poll(() => page.locator('[data-note-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id'))))
    .toEqual([ids[1], ids[2], ids[0]]);
  await context.setOffline(false);
});

for (const mobile of [false, true]) {
  test(`note move success stays visible after closing the picker on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    const source = await seedOrderFolder(page, 1);
    const target = await seedOrderFolder(page, 0);
    const id = source.ids[0];
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await openFolder(page, source.folderId);
    const row = page.locator(`[data-note-id="${id}"]`);
    await row.click();
    if (mobile) {
      const actions = await openMobileNoteActions(page);
      await actions.getByRole('button', { name: '移动笔记', exact: true }).click();
    } else {
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '移动笔记', exact: true }).click();
    }
    const picker = page.getByRole('dialog');
    await expect(picker).toHaveClass('move-dialog');
    const layout = await picker.evaluate((dialog) => {
      const list = dialog.querySelector('.move-target-list')!;
      return {
        width: dialog.getBoundingClientRect().width,
        fullRows: [...list.querySelectorAll('button')].every((row) =>
          Math.abs(row.getBoundingClientRect().width - list.clientWidth) < 1),
        rowHeights: [...list.querySelectorAll('button')].map((row) => row.getBoundingClientRect().height),
      };
    });
    expect(layout.width).toBeLessThanOrEqual(380);
    expect(layout.fullRows).toBe(true);
    expect(layout.rowHeights.every((height) => height >= (mobile ? 44 : 40))).toBe(true);
    const targetRow = picker.getByRole('button', { name: target.folderId, exact: true });
    await targetRow.hover();
    await picker.screenshot({ path: testInfo.outputPath('move-picker.png') });
    const box = (await targetRow.boundingBox())!;
    await targetRow.click({ position: { x: box.width - 12, y: box.height / 2 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const notice = page.locator('.toast');
    await expect(notice).toHaveText('已移动 1 篇笔记');
    await expect(notice).toBeInViewport();
    const noticeBox = (await notice.boundingBox())!;
    expect(noticeBox.y).toBeLessThan(100);
    expect(Math.abs(noticeBox.x + noticeBox.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(1);
    expect(await notice.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return topmost === element || element.contains(topmost);
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('move-success.png') });
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${id}`)).json()).note.folderId).toBe(target.folderId);
  });
}

test('mobile move stays successful when the following list refresh fails', async ({ page }) => {
  const source = await seedOrderFolder(page, 1);
  const target = await seedOrderFolder(page, 0);
  const id = source.ids[0];
  await page.goto('/');
  await disableOfflineLibrary(page);
  await openFolder(page, source.folderId);
  await page.locator(`[data-note-id="${id}"]`).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '移动笔记', exact: true }).click();
  const picker = page.getByRole('dialog');
  let failRefresh = true;
  await page.route('**/api/notes?*', async (route) => {
    if (route.request().method() === 'GET' && failRefresh) {
      failRefresh = false;
      await route.abort();
    } else await route.continue();
  });
  const movedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/notes/${id}` && response.request().method() === 'PUT' && response.ok());
  await picker.getByRole('button', { name: target.folderId, exact: true }).click();
  await movedResponse;
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${id}`)).json()).note.folderId).toBe(target.folderId);
  await expect.soft(picker).toHaveCount(0);
  await expect.soft(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  const list = page.locator('.list-scroll');
  await expect(list.getByText('笔记列表加载失败', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: '重试', exact: true }).click();
  await expect(list.getByText('笔记列表加载失败', { exact: true })).toHaveCount(0);
  await expect(list).toHaveAttribute('aria-busy', 'false');
});

test('mobile move keeps the picker open and reports a failed save', async ({ page }) => {
  const source = await seedOrderFolder(page, 1);
  const target = await seedOrderFolder(page, 0);
  const id = source.ids[0];
  await page.goto('/');
  await disableOfflineLibrary(page);
  await openFolder(page, source.folderId);
  await page.locator(`[data-note-id="${id}"]`).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const actions = await openMobileNoteActions(page);
  await actions.getByRole('button', { name: '移动笔记', exact: true }).click();
  const picker = page.getByRole('dialog');
  await page.route(`**/api/notes/${id}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'move failed' } }),
      });
    } else await route.continue();
  });
  await picker.getByRole('button', { name: target.folderId, exact: true }).click();
  await expect(picker.getByRole('alert')).toContainText('批量操作已处理 0 篇');
  await expect.poll(async () => (await (await page.request.get(`/api/notes/${id}`)).json()).note.folderId).toBe(source.folderId);
});

test('native drag Escape cancels and edge rows keep scrolling without a folder tree', async ({ page }) => {
  const { folderId, ids } = await seedOrderFolder(page, 18);
  const child = await seedOrderFolder(page, 0, folderId);
  await page.goto('/');
  await openFolder(page, folderId);
  const target = page.locator(`[data-folder-id="${child.folderId}"]`);
  const source = (await page.locator(`[data-note-id="${ids[0]}"]`).boundingBox())!;
  const box = (await target.boundingBox())!;
  await page.mouse.move(source.x + 50, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(source.x + 65, source.y + 20, { steps: 5 });
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 10 });
  await expect(target).toHaveClass(/drop-inside/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(target).not.toHaveClass(/drop-inside/);
  expect((await (await page.request.get(`/api/notes/${ids[0]}`)).json()).note.folderId).toBe(folderId);
  const rows = page.locator('[data-note-row]');
  await expect(rows).toHaveCount(18);
  const list = page.locator('.list-scroll');
  const first = (await rows.first().boundingBox())!;
  const listBox = (await list.boundingBox())!;
  await page.mouse.move(first.x + 50, first.y + 20);
  await page.mouse.down();
  await page.mouse.move(first.x + 70, first.y + 20, { steps: 5 });
  await page.mouse.move(first.x + 40, listBox.y + listBox.height - 12, { steps: 10 });
  const before = await list.evaluate((element) => element.scrollTop);
  for (let index = 0; index < 8; index++) {
    await page.waitForTimeout(70);
    await page.mouse.move(first.x + 40 + index % 2, listBox.y + listBox.height - 12);
  }
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await (await page.request.get(`/api/notes?folder=${folderId}&sort=manual`)).json()).notes.map((note: { id: string }) => note.id)).toEqual(ids);
});

test('live preview is the default editing mode and keeps the Markdown source authoritative', async ({ page }) => {
  const title = `即时模式-${randomUUID().slice(0, 6)}`;
  const preferenceKey = `easynote-display-mode:v1:${testUserId}`;
  await page.goto('/');
  await newNote(page, title, '第一段正文\n\n第二段正文');
  const source = page.getByRole('button', { name: '源码模式' });
  const live = page.getByRole('button', { name: '即时渲染模式' });
  const read = page.getByRole('button', { name: '阅读模式' });
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(live).toHaveAttribute('aria-pressed', 'true');
  await expect(source).toHaveAttribute('aria-pressed', 'false');
  await expect(read).toHaveAttribute('aria-pressed', 'false');

  await editor.press('Control+End');
  await editor.pressSequentially('末尾');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await read.click();
  await expect(page.locator('.document .markdown')).toContainText('第二段正文末尾');
  await live.click();
  await expect(editor).toContainText('第二段正文末尾');
  await editor.pressSequentially('END');
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toBe('第一段正文\n\n第二段正文末尾END');
  await editor.press('Meta+z');
  await expect(editor).not.toContainText('END');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();

  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe('source');
  await page.reload();
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('第一段正文');

  await page.evaluate((key) => localStorage.setItem(key, 'unsupported'), preferenceKey);
  await page.reload();
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
});

test('live preview renders supported blocks and exposes their source on edit', async ({ page }) => {
  const title = `即时渲染-${randomUUID().slice(0, 6)}`;
  const content = [
    '# 标题一',
    '',
    '段落 **粗体** *斜体* ~~删除~~ `行内代码` [相对链接](/relative/path) 行内公式 $a^2$ 结尾。',
    '',
    '## 第二级',
    '',
    '- 无序项',
    '- [ ] 待办项',
    '',
    '> 引用一行',
    '',
    '| 列一 | 列二 |',
    '| :--: | --: |',
    '| 前缀 **粗体值** 后缀 | 值二 |',
    '',
    '```js',
    'const probe = 1;',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '$$',
    '\\frac{a}{b} + x^2',
    '$$',
    '',
    '$$x$$ TAIL',
    '',
    '前文 $$a',
    'b$$ 后文',
    '',
    '<https://auto.example/auto>',
    '',
    '---',
    '',
    '<details open>',
    '<summary>折叠标题</summary>',
    '',
    '折叠正文',
    '',
    '</details>',
    '',
    '结束段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  await expect(page.locator('.cm-live-heading.cm-live-h1')).toHaveText('标题一');
  await expect(page.locator('.cm-live-h2')).toHaveText('第二级');
  await expect(page.locator('.cm-live-strong')).toHaveText('粗体');
  await expect(page.locator('.cm-live-em')).toHaveText('斜体');
  await expect(page.locator('.cm-live-del')).toHaveText('删除');
  await expect(page.locator('.cm-live-inline-code')).toHaveText('行内代码');
  await expect(page.locator('a.cm-live-link', { hasText: '相对链接' })).toHaveAttribute('href', '/relative/path');
  await expect(page.locator('.cm-live-math.cm-live-math-display')).toHaveCount(1);
  await expect(page.locator('.cm-live-math-display math mfrac')).toHaveCount(1);
  await expect(page.locator('.cm-live-math-display math msup')).toHaveCount(1);
  await expect(page.locator('.cm-live-math:not(.cm-live-math-display) math msup')).toHaveCount(1);
  await expect(page.locator('.cm-live-table th')).toHaveText(['列一', '列二']);
  await expect(page.locator('.cm-live-table td')).toHaveText(['前缀 粗体值 后缀', '值二']);
  await expect(page.locator('.cm-live-table td strong')).toHaveText('粗体值');
  // Alignment from the delimiter row wins over the table's default left alignment.
  const alignments = await page.locator('.cm-live-table th').evaluateAll((cells) =>
    cells.map((cell) => getComputedStyle(cell).textAlign));
  expect(alignments).toEqual(['center', 'right']);
  // A Mermaid fence stays complete source in the editing surface: no hidden fence marks, no rendering.
  await expect(page.locator('.cm-line').filter({ hasText: '```mermaid' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: 'A --> B' })).toHaveCount(1);
  await expect(page.locator('.cm-live-code pre', { hasText: 'flowchart LR' })).toHaveCount(0);
  // A block formula keeps the text that follows its closing delimiter on the same line.
  await expect(page.locator('.cm-line').filter({ hasText: 'TAIL' })).toHaveCount(1);
  // A `$$` range that covers a line break stays source instead of being replaced from the view plugin.
  await expect(page.locator('.cm-line').filter({ hasText: 'b$$ 后文' })).toHaveCount(1);
  // An autolink keeps its URL text and its action; only the angle brackets disappear.
  const autolink = page.locator('a.cm-live-link', { hasText: 'https://auto.example/auto' });
  await expect(autolink).toHaveAttribute('href', 'https://auto.example/auto');
  await expect(page.locator('.cm-live-code pre')).toContainText('const probe = 1;');
  await expect(page.locator('.cm-live-code .hljs-keyword')).toHaveText('const');
  const tokenColors = await page.evaluate(() => {
    const code = document.querySelector('.cm-live-code code')!;
    const keyword = code.querySelector('.hljs-keyword')!;
    return [getComputedStyle(keyword).color, getComputedStyle(code).color];
  });
  expect(tokenColors[0]).not.toBe(tokenColors[1]);
  await expect(page.locator('.cm-live-rule hr')).toHaveCount(1);
  await expect(page.locator('.cm-live-details details')).toHaveAttribute('open', '');
  await expect(page.locator('.cm-live-details-body')).toContainText('折叠正文');
  await expect(page.locator('.cm-live-task')).toHaveCount(1);
  // The rendered heading is announced as a heading of the right level, not just styled.
  await expect(page.locator('.cm-line.cm-live-h1')).toHaveAttribute('role', 'heading');
  await expect(page.locator('.cm-line.cm-live-h1')).toHaveAttribute('aria-level', '1');

  // A block widget click exposes the whole structure as editable source.
  await page.locator('.cm-live-table td').first().click();
  await expect(page.locator('.cm-live-table')).toHaveCount(0);
  await expect(editor).toContainText('| 列一 | 列二 |');
  await page.locator('.cm-line').filter({ hasText: '结束段落。' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);

  await page.locator('.cm-live-code pre').click();
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await expect(editor).toContainText('```js');
  await page.locator('.cm-line').filter({ hasText: '结束段落。' }).click();

  await page.locator('.cm-live-details summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-live-details details')).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(page.locator('.cm-live-details details')).not.toHaveAttribute('open', '');

  await editor.press('Control+End');
  await editor.pressSequentially('附加');
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toBe(`${content}附加`);
});

test('live preview task checkboxes write the precise source line once per toggle', async ({ page }) => {
  const title = `即时待办-${randomUUID().slice(0, 6)}`;
  const content = [
    '- [ ] 普通',
    '- [] 简写',
    '1. [ ] 有序',
    '> - [ ] 引用',
    '- \\[ ] 转义',
    '- [ ] 最后',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  // The last task line holds the caret, so it shows its source; the other four, including the `- []` shorthand, render.
  await expect(page.locator('.cm-live-task')).toHaveCount(4);
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };

  await page.getByRole('checkbox', { name: '待办事项：普通', exact: true }).check();
  await expect.poll(stored).toBe([
    '- [x] 普通',
    '- [] 简写',
    '1. [ ] 有序',
    '> - [ ] 引用',
    '- \\[ ] 转义',
    '- [ ] 最后',
  ].join('\n'));

  await page.getByRole('checkbox', { name: '待办事项：引用', exact: true }).check();
  await expect.poll(stored).toBe([
    '- [x] 普通',
    '- [] 简写',
    '1. [ ] 有序',
    '> - [x] 引用',
    '- \\[ ] 转义',
    '- [ ] 最后',
  ].join('\n'));

  await editor.press('Meta+z');
  await expect.poll(stored).toBe([
    '- [x] 普通',
    '- [] 简写',
    '1. [ ] 有序',
    '> - [ ] 引用',
    '- \\[ ] 转义',
    '- [ ] 最后',
  ].join('\n'));
});

test('live preview resources stay safe and usable', async ({ page }) => {
  const targetTitle = `即时链接目标-${randomUUID().slice(0, 6)}`;
  const targetId = randomUUID();
  const created = await page.request.post(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '目标正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const external: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) external.push(url);
    await route.continue();
  });

  const title = `即时安全-${randomUUID().slice(0, 6)}`;
  const externalHost = 'external.invalid';
  const content = [
    '<script>window.__livePwned = 1</script>',
    '',
    `<img src="https://${externalHost}/pixel.png" onerror="window.__livePwned = 2">`,
    '',
    `[危险](javascript:alert(1)) [实体](java&#x73;cript:alert(2)) [外链](https://${externalHost}/page)`,
    '',
    `![外图](https://${externalHost}/image.png)`,
    '',
    `[混合斜杠](/\\${externalHost}/x) [反斜杠](\\\\${externalHost}/y) [同源相对](/relative/path)`,

    `[[${targetId}|目标标签]]`,
    '',
    '结尾正文。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await page.getByRole('textbox', { name: '笔记标题' }).click();
  await expect(page.locator('.cm-content script')).toHaveCount(0);
  await expect(page.locator('.cm-content img[src^="https"]')).toHaveCount(0);
  await expect(page.locator('.cm-content a[href^="javascript"]')).toHaveCount(0);
  await expect(page.locator('.cm-content a[href^="java"]')).toHaveCount(0);
  await expect(page.locator('a.cm-live-link', { hasText: '危险' })).toHaveCount(0);
  await expect(page.locator('a.cm-live-link', { hasText: '实体' })).toHaveCount(0);
  await expect(page.locator('a.cm-live-link', { hasText: '外链' })).toHaveAttribute('href', `https://${externalHost}/page`);
  // A mixed-slash target resolves to another origin in the browser, so it is not a same-site relative link.
  await expect(page.locator('a.cm-live-link', { hasText: '混合斜杠' })).toHaveCount(0);
  await expect(page.locator('a.cm-live-link', { hasText: '反斜杠' })).toHaveCount(0);
  await expect(page.locator('a.cm-live-link', { hasText: '同源相对' })).toHaveAttribute('href', '/relative/path');
  expect(await page.evaluate(() => (window as unknown as { __livePwned?: number }).__livePwned)).toBeUndefined();
  expect(external.filter((url) => url.includes(externalHost))).toEqual([]);

  await page.locator('a.cm-live-wikilink').click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await expect(editor).toContainText('目标正文');

  const imageNoteTitle = `即时图片-${randomUUID().slice(0, 6)}`;
  await newNote(page, imageNoteTitle, '图片段落');
  const shot = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: '即时图片.png', mimeType: 'image/png', buffer: shot });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const image = page.locator('.cm-live-inline-image img, .cm-live-image img');
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await image.click();
  const lightbox = page.getByRole('dialog');
  await expect(lightbox.getByRole('img', { name: '笔记图片' })).toBeVisible();
  await lightbox.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(image).toHaveCount(1);
});

test('live preview block content keeps link and attachment actions', async ({ page, context }) => {
  const fileId = randomUUID();
  const uploaded = await page.request.put(`${origin}/api/files/${fileId}`, {
    headers: { ...headers, 'Content-Type': 'text/plain', 'X-Filename': 'block.txt' }, data: '块内附件正文',
  });
  expect(uploaded.status()).toBe(201);
  // The action itself is what is asserted, so the window it would open is recorded instead of navigating.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  const target = `${origin}/autolink-target`;
  const title = `即时块内动作-${randomUUID().slice(0, 6)}`;
  const content = [
    '| 链接 | 附件 |',
    '| --- | --- |',
    `| <${target}> | [附件](/api/files/${fileId}) |`,
    '',
    '<details open>',
    '<summary>块内动作</summary>',
    '',
    `<${target}>`,
    '',
    `[正文附件](/api/files/${fileId})`,
    '',
    '</details>',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await page.locator('.cm-line').filter({ hasText: '结尾段落。' }).click();
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };

  // A mouse click on an autolink inside a table runs the link action; it must not be swallowed as "edit this
  // whole block" by the widget under the pointer.
  const tableLink = page.locator('.cm-live-table a.cm-live-link', { hasText: target });
  await expect(tableLink).toHaveAttribute('data-live-action', 'href');
  await tableLink.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([target]);
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
  await expect(page.locator('.cm-live-details > details')).toHaveCount(1);

  // A private attachment inside a rendered block goes through the same download entry, here from the keyboard.
  const tableFile = page.locator('.cm-live-table a.cm-live-link', { hasText: '附件' });
  await expect(tableFile).toHaveAttribute('data-live-action', 'file');
  const tableDownload = page.waitForEvent('download');
  await tableFile.focus();
  await page.keyboard.press('Enter');
  await tableDownload;
  await expect(page.locator('.cm-live-table')).toHaveCount(1);

  const bodyFile = page.locator('.cm-live-details-body a.cm-live-link', { hasText: '正文附件' });
  const bodyDownload = page.waitForEvent('download');
  await bodyFile.focus();
  await page.keyboard.press('Enter');
  await bodyDownload;
  await expect(page.locator('.cm-live-details > details')).toHaveCount(1);
  // The action never rewrote the document.
  expect(await stored()).toBe(content);
});

test('live preview drag stops at a remote change instead of keeping stale source offsets', async ({ page }) => {
  const title = `即时拖选同步-${randomUUID().slice(0, 6)}`;
  const id = randomUUID();
  const content = [
    '起始段落',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 值甲 | 值乙 |',
    '',
    '```js',
    'const drag = 1;',
    '```',
    '',
    '结尾段落',
  ].join('\n');
  expect((await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: { title, content, tags: [], pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(title);
  const row = page.locator('[data-note-row]').filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await row.click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await page.locator('.cm-line').filter({ hasText: '结尾段落' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  const cell = (await page.locator('.cm-live-table td').first().boundingBox())!;
  const code = (await page.locator('.cm-live-code pre').boundingBox())!;

  // A gesture that starts on the table and reaches the code block keeps both as source.
  await page.mouse.move(cell.x + 6, cell.y + 6);
  await page.mouse.down();
  await page.mouse.move(code.x + 20, code.y + 10, { steps: 10 });
  await expect(page.locator('.cm-live-code')).toHaveCount(0);

  // A remote update inserts text in front of the gesture while the pointer is still down. The anchor of the
  // gesture described the previous text, so it must not be dispatched again.
  const remote = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: `X${content}`, tags: [], pinned: false, archived: false, deletedAt: null, revision: 1,
      operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(editor).toContainText('X起始段落');
  const mapped = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  await page.mouse.move(code.x + 40, code.y + 40, { steps: 5 });
  await page.mouse.up();
  const afterMove = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(afterMove).toBe(mapped);
  // The note is unchanged apart from the remote text.
  const stored = async () => {
    const note = await (await page.request.get(`${origin}/api/notes/${id}`)).json();
    return note.note.content as string;
  };
  expect(await stored()).toBe(`X${content}`);

  // After that cancellation the keyboard still copies the plain Markdown: the table and the fence are only
  // hidden from the screen, so the selection's text carries their full source. The data is read from the event
  // itself, which needs no system clipboard permission.
  await page.evaluate(() => {
    const record = { copy: '', cut: '' };
    (window as unknown as { __clipboard: typeof record }).__clipboard = record;
    document.addEventListener('copy', (event) => {
      record.copy = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    });
    document.addEventListener('cut', (event) => {
      record.cut = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    });
  });
  await page.locator('.cm-line').filter({ hasText: '结尾段落' }).click();
  await editor.press('Meta+a');
  await editor.press('Meta+c');
  expect(await page.evaluate(() => (window as unknown as { __clipboard: { copy: string } }).__clipboard.copy))
    .toBe(`X${content}`);
  await editor.press('Meta+x');
  expect(await page.evaluate(() => (window as unknown as { __clipboard: { cut: string } }).__clipboard.cut))
    .toBe(`X${content}`);
  await expect.poll(stored).toBe('');
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(`X${content}`);
});

test('live preview falls back to source without losing the draft', async ({ page }) => {
  const title = `即时降级-${randomUUID().slice(0, 6)}`;
  const missingId = randomUUID();
  const content = `重要文本\n\n![缺失附件](/api/images/${missingId})\n\n尾部正文`;
  await page.goto('/');
  // A missing private attachment intentionally keeps the note as a local draft instead of a cloud save.
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.fill(content);
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-live-image')).toHaveCount(0);
  await expect(page.locator('.cm-line').filter({ hasText: `![缺失附件](/api/images/${missingId})` }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '图片加载失败' })).toBeVisible();
  await expect(page.getByRole('button', { name: '源码模式' })).toBeEnabled();
  await editor.press('Control+End');
  await editor.pressSequentially('继续编辑');
  // A missing attachment keeps the note as a local draft by design; the edit must still be kept in full.
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (marker) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('easynote');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const drafts = await new Promise<Array<{ note: { content: string } }>>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return drafts.some((draft) => draft.note.content.endsWith(`${marker}继续编辑`));
    } finally { db.close(); }
  }, '尾部正文')).toBe(true);
});

test('live preview keeps narrow screens and keyboard controls usable', async ({ page }) => {
  const title = `即时窄屏-${randomUUID().slice(0, 6)}`;
  const content = [
    '# 窄屏标题',
    '',
    '<details>',
    '<summary>折叠标题</summary>',
    '',
    '折叠正文',
    '',
    '</details>',
    '',
    '| 很长的列一 | 很长的列二 |',
    '| --- | --- |',
    '| 值一 | 值二 |',
    '',
    '结尾正文。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await page.evaluate(() => localStorage.setItem('easynote-theme', 'dark'));
  await page.reload();
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => {
      const scroller = document.querySelector('.document-scroll');
      return !scroller || scroller.scrollWidth <= scroller.clientWidth + 1;
    })).toBe(true);
    for (const name of ['源码模式', '即时渲染模式', '阅读模式']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
  }
  await expect(page.locator('.cm-live-details details')).toHaveCount(1);
  await page.locator('.cm-live-details summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-live-details details')).toHaveAttribute('open', '');
});

test('live preview keeps collapsible blocks independent and inside their own structure', async ({ page }) => {
  const title = `即时折叠-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>',
    '<summary>相同折叠</summary>',
    '',
    '相同正文',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>相同折叠</summary>',
    '',
    '相同正文',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>外层折叠</summary>',
    '',
    '外层正文',
    '',
    '<details open>',
    '<summary>内层折叠</summary>',
    '',
    '内层正文',
    '',
    '</details>',
    '',
    '</details>',
    '',
    '<details title=" open ">',
    '<summary>属性里的 open</summary>',
    '',
    '属性正文',
    '',
    '</details>',
    '',
    '<section>',
    '<details>',
    '<summary>不应折叠</summary>',
    '',
    '容器正文',
    '',
    '</details>',
    '</section>',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  // Two identical blocks are two widgets with their own state; a nested block and a plain `open` attribute are
  // handled separately, while a details inside another raw HTML block stays literal source.
  await expect(page.locator('.cm-live-details > details')).toHaveCount(4);
  await expect(page.locator('.cm-live-details-body')).toContainText(['相同正文', '相同正文', '外层正文', '属性正文']);
  await expect(page.locator('.cm-live-details-body details')).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '<summary>不应折叠</summary>' })).toHaveCount(1);
  const attributed = page.locator('.cm-live-details details').filter({ hasText: '属性里的 open' });
  await expect(attributed).not.toHaveAttribute('open', '');

  const identical = page.locator('.cm-live-details details').filter({ hasText: '相同折叠' });
  await expect(identical).toHaveCount(2);
  await identical.first().locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(identical.first()).not.toHaveAttribute('open', '');
  await expect(identical.nth(1)).toHaveAttribute('open', '');
  // Reading has no input target, so its button keeps the focus; every editing mode hands it to the editor.
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('button', { name: '阅读模式' })).toBeFocused();
  // The state belongs to the block position, so it survives a source/live round trip.
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  // Entering an editing mode hands the keyboard back to the editor with the existing selection.
  await expect(editor).toBeFocused();
  await expect(identical.first()).not.toHaveAttribute('open', '');
  await expect(identical.nth(1)).toHaveAttribute('open', '');

  // The nested block folds on its own.
  const nested = page.locator('.cm-live-details-body details').first();
  await expect(nested.locator('summary')).toHaveText('内层折叠');
  await nested.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(nested).not.toHaveAttribute('open', '');
  await expect(page.locator('.cm-live-details details').filter({ hasText: '外层折叠' })).toHaveAttribute('open', '');
});

test('live preview enters block widgets from any column and drags a source selection', async ({ page }) => {
  const title = `即时进入-${randomUUID().slice(0, 6)}`;
  const content = [
    '前面的普通段落',
    '```js',
    'const inside = 1;',
    '```',
    '中间的普通段落',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 值甲 | 值乙 |',
    '',
    '结尾段落',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(page.locator('.cm-live-code pre')).toBeVisible();

  // ArrowDown from the middle of the line above the fence reaches it; a caret at a specific column is not required.
  await page.locator('.cm-line').filter({ hasText: '前面的普通段落' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await expect(editor).toContainText('const inside = 1;');

  // ArrowUp from the middle of the line below the fence does the same.
  await page.locator('.cm-line').filter({ hasText: '中间的普通段落' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await expect(editor).toContainText('const inside = 1;');

  // A drag that starts on a block widget selects the real Markdown across blocks.
  await page.locator('.cm-line').filter({ hasText: '结尾段落' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
  const cell = await page.locator('.cm-live-table td').first().boundingBox();
  const tail = await page.locator('.cm-line').filter({ hasText: '结尾段落' }).boundingBox();
  expect(cell && tail).toBeTruthy();
  await page.mouse.move(cell!.x + 6, cell!.y + 6);
  await page.mouse.down();
  await page.mouse.move(tail!.x + 20, tail!.y + tail!.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('| 甲 | 乙 |');
  expect(selected).toContain('结尾段落');

  // Leaving the block restores its rendering.
  await page.locator('.cm-line').filter({ hasText: '前面的普通段落' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
});

test('live preview task checkboxes keep the right line when text above changes', async ({ page }) => {
  const title = `即时待办行-${randomUUID().slice(0, 6)}`;
  const content = ['开头段落', '', '- [ ] 甲任务', '- [ ] 乙任务', '', '结尾段落'].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };

  // Lines are inserted above the tasks while the caret stays in the first block.
  await page.locator('.cm-line').filter({ hasText: '开头段落' }).click();
  await editor.press('End');
  await editor.press('Enter');
  await editor.pressSequentially('新增一行');
  await page.getByRole('checkbox', { name: '待办事项：乙任务', exact: true }).check();
  await expect.poll(stored).toBe(['开头段落', '新增一行', '', '- [ ] 甲任务', '- [x] 乙任务', '', '结尾段落'].join('\n'));
  // One undo reverts exactly that task marker.
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(['开头段落', '新增一行', '', '- [ ] 甲任务', '- [ ] 乙任务', '', '结尾段落'].join('\n'));
});

test('live preview falls back per note and only retries that note', async ({ page }) => {
  const normalTitle = `即时正常-${randomUUID().slice(0, 6)}`;
  const brokenTitle = `即时超限-${randomUUID().slice(0, 6)}`;
  const preferenceKey = `easynote-display-mode:v1:${testUserId}`;
  // Formula scanning that exceeds the plan budget degrades that note to source; the note is created through the
  // API so this case is only about the rendering mode.
  const created = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
    headers,
    data: {
      title: brokenTitle, content: '$a{'.repeat(12000), tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');
  await newNote(page, normalTitle, '# 正常标题\n\n正常正文');
  await expect(page.locator('.cm-live-h1')).toHaveText('正常标题');

  await page.locator('[data-note-row]').filter({ hasText: brokenTitle }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这篇笔记结构过于复杂，已切回源码模式，内容仍会完整保留。')).toBeVisible();
  // The automatic fallback never writes an account preference.
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();

  // Reading the failed note and coming back with the shortcut keeps the user's own editing mode: the fault only
  // decides the effective mode of this note, so `source` must not become the account preference.
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('button', { name: '阅读模式' })).toBeFocused();
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe('live');
  await page.locator('[data-note-row]').filter({ hasText: normalTitle }).click();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  // The freshly opened note starts with the caret in its first block, so move it before checking the rendering.
  await page.locator('.cm-line').filter({ hasText: '正常正文' }).click();
  await expect(page.locator('.cm-live-h1')).toHaveText('正常标题');
  await page.locator('[data-note-row]').filter({ hasText: brokenTitle }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');

  // Leaving the fault fallback for reading must not promote the fallback to the editing preference: a healthy
  // note opened from reading comes back to live with Cmd/Ctrl+E.
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('button', { name: '阅读模式' })).toBeFocused();
  await page.locator('[data-note-row]').filter({ hasText: normalTitle }).click();
  await expect(page.getByRole('button', { name: '阅读模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');

  // Another note keeps the live mode.
  await page.locator('[data-note-row]').filter({ hasText: normalTitle }).click();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.cm-line').filter({ hasText: '正常正文' }).click();
  await expect(page.locator('.cm-live-h1')).toHaveText('正常标题');

  // Returning to the broken note stays in source; an explicit retry falls back again instead of being bypassed.
  await page.locator('[data-note-row]').filter({ hasText: brokenTitle }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这篇笔记结构过于复杂，已切回源码模式，内容仍会完整保留。')).toBeVisible();

  await page.locator('[data-note-row]').filter({ hasText: normalTitle }).click();
  await page.locator('.cm-line').filter({ hasText: '正常正文' }).click();
  await expect(page.locator('.cm-live-h1')).toHaveText('正常标题');
});

test('live preview restores the editing preference when a task opens another note', async ({ page }) => {
  const brokenTitle = `即时故障源-${randomUUID().slice(0, 6)}`;
  const normalTitle = `即时任务目标-${randomUUID().slice(0, 6)}`;
  const preferenceKey = `easynote-display-mode:v1:${testUserId}`;
  const created = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
    headers,
    data: {
      title: brokenTitle, content: '$a{'.repeat(12000), tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');
  await newNote(page, normalTitle, '## 正常标题\n\n- [ ] 打开这一项\n\n正常结尾');
  await page.locator('[data-note-row]').filter({ hasText: brokenTitle }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  // Reading the failed note records the explicit reading choice, never the source fallback.
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('button', { name: '阅读模式' })).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe('read');
  // The task centre opens the healthy note reached from that reading state. The programmatic entry must restore
  // the user's own editing mode; the fault of the note being read only applies to that note.
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button').filter({ hasText: '打开这一项' }).click();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe('read');
  // The healthy note really renders, so the mode bar is not the only evidence.
  await expect(page.locator('.cm-live-h2')).toHaveText('正常标题');
  await page.locator('.cm-line').filter({ hasText: '正常结尾' }).click();
  await expect(page.locator('.cm-live-h2')).toHaveText('正常标题');
});

test('live preview degrades an oversized draft on first load', async ({ page }) => {
  const title = `即时额度-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '额度开头');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const draft = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('easynote');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const drafts = await new Promise<Array<{ note: { content: string } }>>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return drafts.map((entry) => entry.note.content);
    } finally { db.close(); }
  });
  // 256 KiB is the default session limit, so this draft stays local and exceeds it.
  await editor.fill(`额度正文开始\n\n${'a'.repeat(262144)}\n\n额度结束标记`);
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');

  // Reloading restores the oversized draft; the first render must degrade without waiting for an edit, and the
  // draft itself stays complete.
  await page.reload();
  await page.locator('[data-note-row]').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '源码模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这篇笔记超过当前正文额度，已切回源码模式，内容仍会完整保留。')).toBeVisible();
  await expect.poll(async () => (await draft()).some((content) => content.endsWith('额度结束标记') && content.length > 262144)).toBe(true);
});

test('live preview keeps a near-limit note live while typing', async ({ page }) => {
  const title = `即时大笔记-${randomUUID().slice(0, 6)}`;
  // 240 KiB of rich Markdown stays below the 256 KiB session limit, so the note saves while it is edited. The
  // same scale is the smallest sample that reliably re-rendered the whole document on one keystroke.
  const block = (index: number) => [
    `## 章节 ${index}`, '',
    `这一段包含 **加粗 ${index}**、*斜体*、~~删除~~、\`code-${index}\` 和 [相对链接](/x/${index}) 以及行内公式 $a_${index}^2$。`, '',
    `- 列表项 ${index}`, `- [ ] 待办 ${index}`, `  - 嵌套项 ${index}`, '',
    `> 引用第 ${index} 段`, '',
    `| 列甲 ${index} | 列乙 |`, '| --- | --- |', `| 值 ${index} | 值二 |`, '',
    '```js', `const value${index} = ${index};`, '```', '',
    '---', '',
    '<details>', `<summary>折叠 ${index}</summary>`, '', `折叠正文 ${index}`, '', '</details>', '',
  ].join('\n');
  let content = '';
  for (let index = 0; Buffer.byteLength(content + block(index), 'utf8') <= 240 * 1024; index++) content += block(index);
  // The tail itself holds a structure: it can only show its widget once the plan described that range.
  content += '\n```js\nconst tailMarker = 1;\n```\n\n尾部标记';
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(250 * 1024);

  const id = randomUUID();
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: { title, content, tags: [], pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(title);
  await page.locator('[data-note-row]').filter({ hasText: title }).first().click();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-live-widget').first()).toBeVisible();

  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.click();
  // Cmd-End is CodeMirror's document-end binding on macOS; Control-End only moves through rendered lines in a
  // virtualized document.
  await editor.press('Meta+End');
  await editor.pressSequentially('X');
  // Typing only re-renders the region around the caret: the mode and the note stay live.
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这篇笔记结构过于复杂，已切回源码模式，内容仍会完整保留。')).toHaveCount(0);
  await expect.poll(async () => {
    const note = await (await page.request.get(`${origin}/api/notes/${id}`)).json();
    return note.note.content.endsWith('尾部标记X');
  }).toBe(true);

  // The tail was owed work while the parser caught up; once it advances the plan finishes that range instead of
  // leaving it as source forever, so the block above the caret really is rendered.
  await expect(page.locator('.cm-live-code pre').filter({ hasText: 'const tailMarker = 1;' })).toHaveCount(1, { timeout: 20000 });
  // Scrolling back to a block that is certainly not active shows its rendering again after the edit.
  await page.locator('.document-scroll').evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator('.cm-live-heading.cm-live-h2').first()).toBeVisible();
  await expect(page.locator('.cm-live-table').first()).toBeVisible();

  // A burst of typing stays live as well.
  await editor.pressSequentially('0123456789', { delay: 40 });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '即时渲染模式' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这篇笔记结构过于复杂，已切回源码模式，内容仍会完整保留。')).toHaveCount(0);
  await expect.poll(async () => {
    const note = await (await page.request.get(`${origin}/api/notes/${id}`)).json();
    return note.note.content.endsWith('尾部标记X0123456789');
  }).toBe(true);
});

test('live preview keeps multi-line link titles and autolinks readable', async ({ page }) => {
  const title = `即时链接-${randomUUID().slice(0, 6)}`;
  const filler = Array.from({ length: 40 }, (_, index) => `第 ${index} 段填充正文`).join('\n\n');
  const url = 'https://auto.example';
  const content = [
    '前言段落。',
    '',
    `<${url}/top>`,
    '',
    `<user@example.com>`,
    '',
    '| 自动链接 | 邮箱 |',
    '| --- | --- |',
    `| <${url}/cell> | <cell@example.com> |`,
    '',
    '<details open>',
    '<summary>自动链接正文</summary>',
    '',
    `<${url}/body>`,
    '',
    '</details>',
    '',
    filler,
    '',
    `[多行标题](https://example.com "第一行`,
    '第二行")',
    '',
    '结尾段落。',
  ].join('\n');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await page.getByRole('textbox', { name: '笔记标题' }).click();
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };

  await page.waitForTimeout(600);
  // Autolinks keep their whole text: HTTP in place, and an email becomes a mailto target instead of a
  // same-origin relative path.
  await expect(page.locator('a.cm-live-link', { hasText: `${url}/top` })).toHaveAttribute('href', `${url}/top`);
  await expect(page.locator('a.cm-live-link', { hasText: 'user@example.com' })).toHaveAttribute('href', 'mailto:user@example.com');
  await expect(page.locator('.cm-live-table a.cm-live-link', { hasText: `${url}/cell` })).toHaveAttribute('href', `${url}/cell`);
  await expect(page.locator('.cm-live-table a.cm-live-link', { hasText: 'cell@example.com' })).toHaveAttribute('href', 'mailto:cell@example.com');
  await expect(page.locator('.cm-live-details-body a.cm-live-link', { hasText: `${url}/body` })).toHaveAttribute('href', `${url}/body`);

  // A link title that covers a line break keeps its source: CodeMirror refuses a cross-line replacement from a
  // view plugin, and that check runs after the decoration builders returned.
  for (let index = 0; index < 40; index++) {
    await page.locator('.document-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    if (await page.locator('.cm-line').filter({ hasText: '结尾段落。' }).count()) break;
    await page.waitForTimeout(80);
  }
  await expect(page.locator('.cm-line').filter({ hasText: '第二行\"' })).toHaveCount(1);
  await expect(page.locator('a.cm-live-link', { hasText: '多行标题' })).toHaveCount(1);

  // Selection changes and a search hit on the same offset keep the editor usable.
  await page.locator('.cm-line').filter({ hasText: '第二行\"' }).click();
  await expect(page.locator('.cm-line').filter({ hasText: '第一行' })).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('多行标题');
  await expect(page.locator('.cm-search-highlight')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('');
  await expect(page.locator('.cm-search-highlight')).toHaveCount(0);

  await editor.press('Meta+End');
  await editor.pressSequentially('追加');
  await expect.poll(stored).toBe(`${content}追加`);
  expect(errors.filter((message) => message.includes('line break'))).toEqual([]);
});

test('live preview block math follows containers and raw HTML', async ({ page }) => {
  const title = `即时公式容器-${randomUUID().slice(0, 6)}`;
  const content = [
    '<section>',
    '',
    '$$htmlInside$$',
    '',
    '</section>',
    '',
    '> $$',
    '> q^2',
    '> $$',
    '',
    '- $$',
    '  l^2',
    '  $$',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    '$$',
    '- x',
    '$$',
    '',
    '> $$',
    '> - y',
    '> $$',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  // Raw HTML stays literal, both inside one HTML block and beyond the blank line the parser splits on.
  await expect(page.locator('.cm-line').filter({ hasText: '$$htmlInside$$' })).toHaveCount(1);
  // A quote and a list container hold the same formula the standalone form uses.
  await expect(page.locator('.cm-live-math.cm-live-math-display')).toHaveCount(5);
  await expect(page.locator('.cm-live-math-display math msup')).toHaveCount(2);
  await expect(page.locator('.cm-live-math-display math mfrac')).toHaveCount(1);

  // `- x` on a TeX line is a minus, not a list marker to strip: the editor and the reading surface agree.
  const negatives = page.locator('.cm-live-math-display').filter({ hasText: '−' });
  await expect(negatives).toHaveCount(2);
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.locator('.document .markdown math').filter({ hasText: '−' })).toHaveCount(2);
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(page.locator('.cm-live-math.cm-live-math-display')).toHaveCount(5);

  // Entering the container formula shows its whole source, including the quote markers.
  await page.locator('.cm-live-math-display').first().click();
  await expect(page.locator('.cm-live-math-display')).toHaveCount(4);
  await expect(editor).toContainText('> q^2');
});

test('live preview details scanning stays inside its own structure', async ({ page }) => {
  const title = `即时折叠结构-${randomUUID().slice(0, 6)}`;
  const content = [
    '<section>',
    '',
    '<!-- </section> -->',
    '',
    '<details>',
    '<summary>容器内折叠</summary>',
    '',
    '容器正文',
    '',
    '</details>',
    '',
    '</section>',
    '',
    '<dl>',
    '',
    '<details open>',
    '<summary>列表容器折叠</summary>',
    '',
    '列表容器正文',
    '',
    '</details>',
    '',
    '</dl>',
    '',
    '<details open>',
    '<summary>围栏示例</summary>',
    '',
    '```html',
    '<details><summary>示例</summary>示例正文</details>',
    '```',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>伪闭合</summary>',
    '',
    '正文 </detailsXYZ> 保留',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>尾随文字</summary>',
    '',
    '尾随正文',
    '',
    '</details> 尾随文字',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);

  // A container element that closes after a blank line still blocks the details inside it, and the pseudo close
  // tag in the body does not end anything. A closing tag inside a comment is not a closing tag.
  await expect(page.locator('.cm-line').filter({ hasText: '<summary>容器内折叠</summary>' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '<!-- </section> -->' })).toHaveCount(1);
  // Block containers outside the old fixed set (`dl`, `h1`, …) are not interpreted either.
  await expect(page.locator('.cm-line').filter({ hasText: '<summary>列表容器折叠</summary>' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '列表容器正文' })).toHaveCount(1);
  await expect(page.locator('.cm-live-details > details')).toHaveCount(2);
  await expect(page.locator('.cm-live-details-body details')).toHaveCount(0);
  await expect(page.locator('.cm-live-details-body').filter({ hasText: '</detailsXYZ>' })).toContainText('正文 </detailsXYZ> 保留');
  // The fenced example keeps its literal text instead of becoming a second collapsible control.
  await expect(page.locator('.cm-live-details-body pre')).toContainText('<summary>示例</summary>');
  // Trailing text after the closing tag keeps that candidate as source instead of being cut off.
  await expect(page.locator('.cm-line').filter({ hasText: '</details> 尾随文字' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '尾随正文' })).toHaveCount(1);
});

test('live preview keeps ordinary Markdown inside a recognised HTML container as source', async ({ page }) => {
  const title = `即时容器源码-${randomUUID().slice(0, 6)}`;
  const content = [
    '<section>', '',
    '容器内 **强调** 与 `代码`', '',
    '- [ ] 容器内任务', '',
    '```js', 'const inside = 1;', '```', '',
    '</section>', '',
    '容器外 **强调** 与 `代码`', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // Every marker inside the container stays visible; only the block after it is decorated.
  await expect(page.locator('.cm-line').filter({ hasText: '容器内 **强调** 与 `代码`' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '- [ ] 容器内任务' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: '```js' })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: 'const inside = 1;' })).toHaveCount(1);
  await expect(page.locator('.cm-live-strong')).toHaveCount(1);
  await expect(page.locator('.cm-live-strong')).toHaveText('强调');
  await expect(page.locator('.cm-live-inline-code')).toHaveCount(1);
  await expect(page.locator('.cm-live-task')).toHaveCount(0);
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
});

test('live preview details keeps a nested list inside its parent item', async ({ page }) => {
  const title = `即时折叠列表-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>嵌套列表</summary>', '',
    '- 父项', '  - 子项', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const body = page.locator('.cm-live-details-body');
  await expect(body.locator('> ul > li > ul > li')).toHaveText('子项');
  const structure = await body.locator('> ul').evaluate((list) => ({
    siblings: list.children.length,
    parent: list.querySelector(':scope > li > p')?.textContent ?? '',
    nested: list.querySelector(':scope > li > ul > li')?.textContent ?? '',
  }));
  expect(structure.siblings).toBe(1);
  expect(structure.parent).toContain('父项');
  expect(structure.nested).toContain('子项');
  const text = await body.innerText();
  expect(text.indexOf('父项')).toBeLessThan(text.indexOf('子项'));
});

test('live preview details body headings keep their level without their marks', async ({ page }) => {
  const title = `即时正文标题-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>正文标题</summary>', '',
    '## 二级标题', '',
    '### 三级标题', '',
    'Setext 标题', '---', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const body = page.locator('.cm-live-details-body');
  // A heading in the body is rendered as its level, so its own `HeaderMark`s are syntax: ATX openers and closers
  // and the Setext underline stay out of the visible text.
  await expect(body.locator('h2')).toHaveText(['二级标题', 'Setext 标题']);
  await expect(body.locator('h3')).toHaveText('三级标题');
  const text = await body.innerText();
  expect(text).not.toContain('##');
  expect(text).not.toContain('---');
  expect(text).toContain('二级标题');
});

test('live preview hides a Setext underline inside a quote', async ({ page }) => {
  const title = `即时引用标题-${randomUUID().slice(0, 6)}`;
  const content = [
    '普通 Setext', '===', '',
    '> 引用 Setext', '> ---', '',
    '> **加粗引用** 与 `代码` [链接](/quoted)', '> ===', '',
    '- 列表项', '', '  Setext 标题', '  ---', '',
    '> ## 引用 ATX', '',
    '<details open>', '<summary>引用标题</summary>', '',
    '> 正文引用标题', '> ---', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  // The underline of a Setext heading is syntax whichever container holds it, so its whole line disappears
  // together with the quote prefix instead of staying on screen as `> ---`.
  const text = await editor.innerText();
  expect(text).not.toContain('---');
  expect(text).not.toContain('===');
  expect(text).not.toMatch(/^>\s*$/m);
  await expect(page.locator('.cm-line.cm-live-h1').filter({ hasText: '普通 Setext' })).toHaveText('普通 Setext');
  const setext = page.locator('.cm-line.cm-live-h2').filter({ hasText: '引用 Setext' });
  await expect(setext).toHaveText('> 引用 Setext');
  await expect(setext).toHaveAttribute('aria-level', '2');
  // The same holds when the heading text is indented inside a list item.
  await expect(page.locator('.cm-line.cm-live-h2').filter({ hasText: 'Setext 标题' })).toHaveAttribute('aria-level', '2');
  // The heading keeps its inline nodes although its underline came from a quoted line.
  const quoted = page.locator('.cm-line.cm-live-h1').filter({ hasText: '加粗引用' });
  await expect(quoted.locator('strong')).toHaveText('加粗引用');
  await expect(quoted.locator('.cm-live-inline-code')).toHaveText('代码');
  await expect(quoted.locator('a.cm-live-link')).toHaveText('链接');
  await expect(quoted.locator('a.cm-live-link')).toHaveAttribute('href', '/quoted');
  // An ATX heading inside a quote still hides its own marks.
  const atx = page.locator('.cm-line').filter({ hasText: '引用 ATX' });
  await expect(atx).toHaveCount(1);
  const atxText = await atx.innerText();
  expect(atxText).toContain('引用 ATX');
  expect(atxText).not.toContain('##');
  // The details body keeps the same heading text without its underline.
  const body = page.locator('.cm-live-details-body');
  await expect(body.locator('blockquote h2')).toHaveText('正文引用标题');
  expect(await body.innerText()).not.toContain('---');
});

test('live preview details body lists keep their source numbering', async ({ page }) => {
  const title = `即时正文编号-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>正文编号</summary>', '',
    '3. 第三步', '4. 第四步', '',
    '> 3. 引用第三步', '> 4. 引用第四步', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const body = page.locator('.cm-live-details-body');
  // The source numbering is the list's first number, not the browser's default of 1; a quoted list goes through
  // the same branch.
  await expect(body.locator('> ol')).toHaveAttribute('start', '3');
  await expect(body.locator('> ol > li')).toHaveText(['第三步', '第四步']);
  await expect(body.locator('blockquote ol')).toHaveAttribute('start', '3');
  await expect(body.locator('blockquote ol > li')).toHaveText(['引用第三步', '引用第四步']);
  const text = await body.innerText();
  expect(text).not.toContain('3. 第三步');
});

test('live preview hides inline code delimiters at their real edges', async ({ page }) => {
  const title = `即时行内代码-${randomUUID().slice(0, 6)}`;
  const content = [
    '行内 `单反引号` 与 ``双反引号`` 结束。', '',
    '| 列 |', '| --- |', '| ``表格反引号`` |', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // The whole visible line is the rendered text: no backtick survives outside the code element.
  const inlineLine = page.locator('.cm-line').filter({ hasText: '单反引号' });
  await expect(inlineLine).toHaveText('行内 单反引号 与 双反引号 结束。');
  await expect(inlineLine.locator('.cm-live-inline-code')).toHaveText(['单反引号', '双反引号']);
  // The safe DOM inside the table follows the same `CodeMark` edges.
  await expect(page.locator('.cm-live-table td')).toHaveText('表格反引号');
  await expect(page.locator('.cm-live-table td code')).toHaveText('表格反引号');
});

test('live preview keeps cell literal hashes out of the heading rule', async ({ page }) => {
  const title = `即时表格井号-${randomUUID().slice(0, 6)}`;
  const content = [
    '| 列 |', '| --- |', '| ## **粗体** `代码` [链接](/cell) |', '',
    '<details open>', '<summary>表格井号</summary>', '',
    '| 表头 |', '| --- |', '| ## 正文标签 | 普通值 |', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // A table cell is inline Markdown: its `##` is text, not a heading opener, so the cell keeps it while the
  // emphasis, code span and link inside it are still built.
  const table = page.locator('.cm-live-table').first();
  await expect(table.locator('th')).toHaveText('列');
  await expect(table.locator('td')).toHaveText('## 粗体 代码 链接');
  await expect(table.locator('td strong')).toHaveText('粗体');
  await expect(table.locator('td code')).toHaveText('代码');
  await expect(table.locator('td a.cm-live-link')).toHaveAttribute('href', '/cell');
  // The same rule holds inside a details body, and an ordinary cell beside it is unaffected.
  const body = page.locator('.cm-live-details-body');
  await expect(body.locator('table th')).toHaveText('表头');
  await expect(body.locator('table td')).toHaveText(['## 正文标签', '普通值']);
});

test('live preview keeps a recognised HTML container inside a details body as source', async ({ page }) => {
  const title = `即时折叠容器-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>折叠容器</summary>', '',
    '<section>', '',
    '容器内 **隐藏** 与 `代码`', '',
    '</section>', '',
    '容器外 **显示**', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // The details body is Markdown again, but a recognised container inside it is still literal source: the same
  // boundary the note plan applies, not a second interpretation of the widget DOM.
  const body = page.locator('.cm-live-details-body');
  await expect(body).toContainText('<section>');
  await expect(body).toContainText('**隐藏**');
  await expect(body).toContainText('`代码`');
  await expect(body.locator('strong')).toHaveCount(1);
  await expect(body.locator('strong')).toHaveText('显示');
  await expect(body.locator('code')).toHaveCount(0);
});

test('live preview keeps a quoted details body as blocks instead of one paragraph', async ({ page }) => {
  const title = `即时折叠引用-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>引用结构</summary>', '',
    '- 列表项', '',
    '  > 引用段落', '  >', '  > - 父项', '  >   - 子项', '  >', '  > > 深层引用', '  >',
    '  > ```js', '  > const quoted = 1;', '  >', '  > const later = 2;', '  > ```', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const body = page.locator('.cm-live-details-body');
  // A quote inside the body holds nested blocks: its own list levels, a nested quote and a code block.
  await expect(body.locator('li > blockquote')).toHaveCount(1);
  await expect(body.locator('blockquote')).toHaveCount(2);
  await expect(body.locator('blockquote ul > li > ul > li')).toHaveText('子项');
  await expect(body.locator('blockquote blockquote')).toContainText('深层引用');
  // A quoted fence is split into one code line per child with the quote's own marks between them: every line and
  // the blank line between them keep their place in the code element.
  await expect(body.locator('blockquote pre > code')).toContainText('const quoted = 1;');
  expect(await body.locator('blockquote pre > code').evaluate((code) => code.textContent))
    .toBe('const quoted = 1;\n\nconst later = 2;');
  const text = await body.innerText();
  for (const word of ['列表项', '引用段落', '父项', '子项', '深层引用', 'const quoted = 1;', 'const later = 2;']) {
    expect(text.split(word).length - 1, `${word} appears once`).toBe(1);
  }
  expect(text.indexOf('列表项')).toBeLessThan(text.indexOf('引用段落'));
  expect(text.indexOf('父项')).toBeLessThan(text.indexOf('子项'));
  // Only the quote markers disappear together with the structure they belonged to.
  expect(text).not.toContain('>');
});

test('live preview keeps every line of a quoted code block', async ({ page }) => {
  const title = `即时引用围栏-${randomUUID().slice(0, 6)}`;
  const content = [
    '> ```js', '> const quotedFirst = 1;', '>', '> const quotedSecond = 2;', '> ```', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // A fence continued across quote lines is one block whose body is every code line of the quote: the second
  // line and the blank line before it keep their place instead of the first line being the only one rendered.
  const code = page.locator('.cm-live-code code');
  await expect(code).toHaveCount(1);
  expect(await code.evaluate((element) => element.textContent)).toBe('const quotedFirst = 1;\n\nconst quotedSecond = 2;');
});

test('live preview keeps a recognised container inside a details list item as source', async ({ page }) => {
  const title = `即时列表容器-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>列表容器正文</summary>', '',
    '- 父项', '',
    '  <section>', '',
    '  **隐藏** 与 `代码`', '',
    '  </section>', '',
    '  容器外 **显示**', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  // The first paragraph of a list item goes through the same container judgement as every other block: a
  // recognised container stays literal source there too, and only the Markdown outside it is decorated.
  const body = page.locator('.cm-live-details-body');
  await expect(body.locator('> ul > li')).toHaveCount(1);
  await expect(body).toContainText('**隐藏**');
  await expect(body).toContainText('`代码`');
  await expect(body.locator('strong')).toHaveCount(1);
  await expect(body.locator('strong')).toHaveText('显示');
  await expect(body.locator('code')).toHaveCount(0);
});

test('live preview details body tasks keep their own source position', async ({ page }) => {
  const title = `即时正文待办-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>', '<summary>正文待办</summary>', '',
    '> - [ ] 引用待办', '',
    '- [ ] 列表待办', '',
    '- [] 简写待办', '',
    '> - [] 引用简写', '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };
  const marked = (source: string, line: string) => source.split('\n')
    .map((text) => (text === line ? text.replace(/\[[ xX]?\]/, '[x]') : text)).join('\n');
  const body = page.locator('.cm-live-details-body');
  // A task inside a details body is a real checkbox, not the `[ ]` text of its marker. The `- []` shorthand is
  // the same list-item rule the note plan applies, so it is a checkbox here too.
  await expect(body.locator('.cm-live-task')).toHaveCount(4);

  await page.getByRole('checkbox', { name: '待办事项：引用待办', exact: true }).check();
  await expect.poll(stored).toBe(marked(content, '> - [ ] 引用待办'));
  // One undo restores that one marker, so the write went through the same isolated task transaction.
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(content);

  await page.getByRole('checkbox', { name: '待办事项：列表待办', exact: true }).check();
  const listChecked = marked(content, '- [ ] 列表待办');
  await expect.poll(stored).toBe(listChecked);

  // `[]` is two characters and `[x]` three: the marker at the checkbox's own offset is the replaced one.
  await page.getByRole('checkbox', { name: '待办事项：简写待办', exact: true }).check();
  await expect.poll(stored).toBe(marked(listChecked, '- [] 简写待办'));
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(listChecked);

  await page.getByRole('checkbox', { name: '待办事项：引用简写', exact: true }).check();
  await expect.poll(stored).toBe(marked(listChecked, '> - [] 引用简写'));
});

test('live preview details body tasks keep the marker they show on a shared line', async ({ page }) => {
  const title = `即时同行待办-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>',
    '<summary>',
    '- [ ] 标题任务</summary>- [ ] 正文任务',
    '</details>',
    '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };
  const summary = page.locator('.cm-live-details summary');
  // A summary that closes on a later line makes the body start mid-line: the title's own task is text, the body's
  // second marker is the checkbox, and only the marker the checkbox shows may be written back.
  await expect(summary).toHaveText('- [ ] 标题任务');
  await expect(page.locator('.cm-live-details-body .cm-live-task')).toHaveCount(1);

  await page.getByRole('checkbox', { name: '待办事项：正文任务', exact: true }).check();
  await expect.poll(stored).toBe(content.replace('- [ ] 正文任务', '- [x] 正文任务'));
  // The title in the summary is a byte-for-byte part of that same line.
  await expect(summary).toHaveText('- [ ] 标题任务');
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(content);
});

test('live preview details body tasks write back when no marker precedes them on the line', async ({ page }) => {
  const title = `即时同行无前置-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>',
    '<summary>前情摘要</summary>- [ ] 无前置任务',
    '</details>',
    '',
    '结尾段落。', '',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };
  // The body slice starts right after `</summary>`, so its marker is the only task on that line. A rule that looks
  // for a task at the start of the line cannot find it at all.
  await expect(page.locator('.cm-live-details-body .cm-live-task')).toHaveCount(1);

  await page.getByRole('checkbox', { name: '待办事项：无前置任务', exact: true }).check();
  await expect.poll(stored).toBe(content.replace('- [ ] 无前置任务', '- [x] 无前置任务'));
  await editor.press('Meta+z');
  await expect.poll(stored).toBe(content);
});

test('live preview resolves angle-bracket targets before its whitelist', async ({ page }) => {
  const fileId = randomUUID();
  const uploaded = await page.request.put(`${origin}/api/files/${fileId}`, {
    headers: { ...headers, 'Content-Type': 'text/plain', 'X-Filename': 'angle.txt' }, data: '尖括号附件正文',
  });
  expect(uploaded.status()).toBe(201);
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  // The target is absolute because it carries a scheme; the test origin keeps the expectation exact.
  const target = `${origin}/angle-target`;
  const title = `即时尖括号目标-${randomUUID().slice(0, 6)}`;
  const content = [
    `[尖括号链接](<${target}>)`,
    '',
    '[危险尖括号](<javascript:alert(1)>)',
    '',
    `[尖括号附件](</api/files/${fileId}>)`,
    '',
    '<details open>',
    '<summary>尖括号目标</summary>',
    '',
    `[正文尖括号](<${target}/body>)`,
    '',
    `[正文角附件](</api/files/${fileId}>)`,
    '',
    '</details>',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);

  // `<…>` is Markdown syntax: the protocol check sees the target itself, so an absolute URL stays absolute.
  const link = page.locator('a.cm-live-link', { hasText: '尖括号链接' });
  await expect(link).toHaveAttribute('href', target);
  await link.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toContain(target);
  // A dangerous scheme stays plain text even with the shell around it.
  await expect(page.locator('a.cm-live-link', { hasText: '危险尖括号' })).toHaveCount(0);

  // The same target in the safe DOM, and a private attachment that still reaches its own download action.
  const bodyLink = page.locator('.cm-live-details-body a.cm-live-link', { hasText: '正文尖括号' });
  await expect(bodyLink).toHaveAttribute('href', `${target}/body`);
  await bodyLink.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toContain(`${target}/body`);

  const file = page.locator('.cm-live-details-body a.cm-live-link', { hasText: '正文角附件' });
  await expect(file).toHaveAttribute('href', `/api/files/${fileId}`);
  await expect(file).toHaveAttribute('data-live-action', 'file');
  await expect(file).toHaveAttribute('data-file-id', fileId);
  const download = page.waitForEvent('download');
  await file.focus();
  await page.keyboard.press('Enter');
  await download;

  // The plan's own link mark resolves the shell the same way.
  const marked = page.locator('a.cm-live-link', { hasText: '尖括号附件' });
  await expect(marked).toHaveAttribute('data-live-action', 'file');
  await expect(marked).toHaveAttribute('href', `/api/files/${fileId}`);
});

test('live preview builds link labels from their inline nodes in the safe DOM', async ({ page }) => {
  const title = `即时链接标签-${randomUUID().slice(0, 6)}`;
  const target = 'https://example.com/label';
  // The image target contains a `]` the parser accepts, so the label edges may not come from the node's end.
  const imageTarget = '/asset]part';
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const content = [
    '| 链接 | 组合 |', '| --- | --- |',
    '| [`x`](/relative/path) | [**强** ``y``](https://example.com/label) |', '',
    '<details open>', '<summary>正文链接</summary>', '',
    '[`正文代码`](/details/target)', '',
    `[![图](${imageTarget})](/target)`,
    '',
    '</details>', '',
    '结尾段落。', '',
  ].join('\n');
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto('/');
  await newNote(page, title, content);
  // The label range of a link goes through the same inline construction as a paragraph, so code and emphasis
  // inside it keep their structure instead of showing their delimiters.
  const codeCell = page.locator('.cm-live-table td').nth(0);
  await expect(codeCell.locator('a.cm-live-link')).toHaveText('x');
  await expect(codeCell.locator('a.cm-live-link code')).toHaveText('x');
  await expect(codeCell.locator('a.cm-live-link')).toHaveAttribute('href', '/relative/path');
  await expect(codeCell.locator('a.cm-live-link')).toHaveAttribute('data-live-action', 'href');

  const mixed = page.locator('.cm-live-table td').nth(1).locator('a.cm-live-link');
  await expect(mixed).toHaveText('强 y');
  await expect(mixed.locator('strong')).toHaveText('强');
  await expect(mixed.locator('code')).toHaveText('y');
  await expect(mixed).toHaveAttribute('href', target);

  const bodyLink = page.locator('.cm-live-details-body a.cm-live-link', { hasText: '正文代码' });
  await expect(bodyLink).toHaveText('正文代码');
  await expect(bodyLink.locator('code')).toHaveText('正文代码');
  await expect(bodyLink).toHaveAttribute('href', '/details/target');
  await expect(bodyLink).toHaveAttribute('data-live-action', 'href');
  // The unified action marker still reaches the link action through its new child nodes.
  await bodyLink.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toContain('/details/target');
  await expect(page.locator('.cm-live-details > details')).toHaveCount(1);

  // An image label ends at the `]` the parser closed it with; a `]` inside the image target stays in the target,
  // so the visible text is the alt only and no image request is made.
  const imageLabel = page.locator('.cm-live-details-body a.cm-live-link', { hasText: '图' });
  await expect(imageLabel).toHaveText('图');
  await expect(imageLabel).toHaveAttribute('href', '/target');
  await expect(imageLabel).toHaveAttribute('data-live-action', 'href');
  await expect(imageLabel.locator('img')).toHaveCount(0);
  await imageLabel.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toContain('/target');
  expect(requests.filter((url) => url.includes(imageTarget))).toEqual([]);
});

test('live preview fold state follows its block and survives rebuilds', async ({ page }) => {
  const title = `即时折叠身份-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>',
    '<summary>相同折叠</summary>',
    '',
    '相同正文',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>外层折叠</summary>',
    '',
    '外层正文',
    '',
    '<details open>',
    '<summary>内层折叠</summary>',
    '',
    '内层正文',
    '',
    '</details>',
    '',
    '</details>',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const first = page.locator('.cm-live-details details').filter({ hasText: '相同折叠' });
  const outer = page.locator('.cm-live-details details').filter({ hasText: '外层折叠' });
  const inner = page.locator('.cm-live-details-body details').first();

  // Fold the first block, then insert text in front of it in source mode: the state belongs to the block, not
  // to the offset it used to start at.
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.locator('.cm-line').filter({ hasText: '<details open>' }).first().click({ position: { x: 4, y: 4 } });
  await editor.press('Home');
  await editor.press('Enter');
  await editor.press('ArrowUp');
  await editor.pressSequentially('intro');
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  // Source mode only mapped the plan; returning to live has to render the block the edit touched.
  await expect(first).toBeVisible();
  await expect(first).not.toHaveAttribute('open', '');

  // A same-length replacement is a different block: it starts from its own source `open` instead of inheriting
  // the previous state.
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.locator('.cm-line').filter({ hasText: '<summary>相同折叠</summary>' }).click();
  await editor.press('Home');
  for (let index = 0; index < 9; index++) await editor.press('ArrowRight');
  for (let index = 0; index < 4; index++) await editor.press('Shift+ArrowRight');
  await editor.pressSequentially('别的折叠');
  await editor.press('Meta+End');
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  const replaced = page.locator('.cm-live-details details').filter({ hasText: '别的折叠' });
  await expect(replaced).toHaveAttribute('open', '');

  // A nested block keeps its own state across a rebuild and across an outer toggle.
  await inner.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(inner).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(page.locator('.cm-live-details-body details').first()).not.toHaveAttribute('open', '');

  // One focus, then consecutive Enter presses: an open/close updates the existing control in place, so the
  // summary keeps the keyboard focus and the block can be toggled again without being re-focused by the test.
  // Entering a mode hands the keyboard to the editor first, so wait for that before moving to the summary.
  await expect(editor).toBeFocused();
  const summary = outer.locator('summary').first();
  // The marker only survives if the widget keeps its own DOM; a rebuild would drop it together with the focus.
  await summary.evaluate((element) => { (element as HTMLElement).dataset.focusProbe = '1'; });
  await summary.focus();
  await expect(summary).toBeFocused();
  for (const expected of [false, true, false]) {
    await page.keyboard.press('Enter');
    if (expected) await expect(outer).toHaveAttribute('open', '');
    else await expect(outer).not.toHaveAttribute('open', '');
    await expect(page.locator('.cm-live-details summary[data-focus-probe="1"]')).toHaveCount(1);
    await expect(summary).toBeFocused();
  }
  // A nested block keeps its own state while its outer block opens and closes.
  await expect(page.locator('.cm-live-details-body details').first()).not.toHaveAttribute('open', '');
});

test('live preview fold state belongs to the block at its own position', async ({ page }) => {
  const title = `即时折叠位置-${randomUUID().slice(0, 6)}`;
  const identical = ['<details open>', '<summary>相同折叠</summary>', '', '相同正文', '', '</details>', '', ''].join('\n');
  const content = [
    identical,
    '<details open>', '<summary>外层折叠</summary>', '',
    '<details open>', '<summary>相同内层</summary>', '', '内层正文', '', '</details>', '',
    '<details open>', '<summary>相同内层</summary>', '', '内层正文', '', '</details>', '',
    '</details>', '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const blocks = page.locator('.cm-live-details details').filter({ hasText: '相同折叠' });

  // Fold the only identical block, then add a copy of it in front: the copy starts from its own `open` source
  // and the folded state stays with the block that was folded, not with its content.
  await blocks.first().locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(blocks.first()).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.locator('.cm-line').filter({ hasText: '<details open>' }).first().click({ position: { x: 4, y: 4 } });
  await editor.press('Home');
  // A real paste of the same block in front of it goes through CodeMirror's own input pipeline.
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, identical);
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await page.locator('.cm-line').filter({ hasText: '结尾段落。' }).click();
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toHaveAttribute('open', '');
  await expect(blocks.nth(1)).not.toHaveAttribute('open', '');

  // Two nested siblings with identical source keep separate state, here and across a rebuild.
  const nested = page.locator('.cm-live-details-body details').filter({ hasText: '相同内层' });
  await expect(nested).toHaveCount(2);
  await nested.nth(0).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(nested.nth(0)).not.toHaveAttribute('open', '');
  await expect(nested.nth(1)).toHaveAttribute('open', '');
  await nested.nth(1).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(nested.nth(1)).not.toHaveAttribute('open', '');
  await nested.nth(0).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(nested.nth(0)).toHaveAttribute('open', '');
  await expect(nested.nth(1)).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(nested.nth(0)).toHaveAttribute('open', '');
  await expect(nested.nth(1)).not.toHaveAttribute('open', '');
});

test('live preview renders details after an edit above them returns from source mode', async ({ page }) => {
  const title = `即时折叠恢复-${randomUUID().slice(0, 6)}`;
  const content = [
    '<details open>',
    '<summary>上方折叠</summary>',
    '',
    '折叠正文',
    '',
    '</details>',
    '',
    '结尾段落。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  const details = page.locator('.cm-live-details details').filter({ hasText: '上方折叠' });
  await expect(details).toBeVisible();

  // A source-mode insertion immediately above the opening tag accumulates in the mapped plan's dirty region.
  await page.getByRole('button', { name: '源码模式' }).click();
  await page.locator('.cm-line').filter({ hasText: '<details open>' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.press('Home');
  await editor.press('Enter');
  await editor.press('ArrowUp');
  await editor.pressSequentially('intro');
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  await expect(details).toBeVisible();
  await expect(details.locator('summary')).toHaveText('上方折叠');
});

test('live preview drag keeps every crossed block as source until the gesture ends', async ({ page }) => {
  const title = `即时拖选-${randomUUID().slice(0, 6)}`;
  const content = [
    '起始段落',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 值甲 | 值乙 |',
    '',
    '```js',
    'const drag = 1;',
    '```',
    '',
    '中间段落',
    '',
    '> 引用块',
    '',
    '结尾段落',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await page.locator('.cm-line').filter({ hasText: '结尾段落' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
  const cell = (await page.locator('.cm-live-table td').first().boundingBox())!;
  const code = (await page.locator('.cm-live-code pre').boundingBox())!;
  const quote = (await page.locator('.cm-line').filter({ hasText: '引用块' }).boundingBox())!;

  await page.mouse.move(cell.x + 6, cell.y + 6);
  await page.mouse.down();
  await page.mouse.move(quote.x + 20, quote.y + quote.height / 2, { steps: 10 });
  await expect(page.locator('.cm-live-table')).toHaveCount(0);
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  // Moving back over a block the gesture already crossed must not restore it before the pointer is released.
  await page.mouse.move(cell.x + 6, cell.y + 6, { steps: 10 });
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('| 甲 | 乙 |');

  // A reverse gesture selects the real Markdown all the way up to the first block.
  await expect(page.locator('.cm-live-code pre')).toBeVisible();
  const rendered = (await page.locator('.cm-live-code pre').boundingBox())!;
  const paragraph = (await page.locator('.cm-line').filter({ hasText: '起始段落' }).boundingBox())!;
  await page.mouse.move(rendered.x + 20, rendered.y + 10);
  await page.mouse.down();
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await page.mouse.move(paragraph.x + 2, paragraph.y + 2, { steps: 10 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.startsWith('起始段落')).toBe(true);
  expect(selected).toContain('| 甲 | 乙 |');

  // A forward gesture that ends below the block selects its real Markdown as well.
  await page.locator('.cm-line').filter({ hasText: '起始段落' }).click();
  await expect(page.locator('.cm-live-table')).toHaveCount(1);
  const table = (await page.locator('.cm-live-table td').first().boundingBox())!;
  const middle = (await page.locator('.cm-line').filter({ hasText: '中间段落' }).boundingBox())!;
  await page.mouse.move(table.x + 6, table.y + 6);
  await page.mouse.down();
  await page.mouse.move(middle.x + 30, middle.y + middle.height / 2, { steps: 10 });
  await page.mouse.up();
  const forward = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(forward).toContain('```js');
  expect(forward).toContain('const drag = 1;');
  expect(forward).toContain('中间段落');
});

test('live preview arrow keys respect wrapped lines and exposed blocks', async ({ page }) => {
  const title = `即时方向键-${randomUUID().slice(0, 6)}`;
  const marker = `mark-${randomUUID().slice(0, 8)}`;
  const paragraph = `${'段落内容'.repeat(30)}末标记`;
  const lines = (first: string, last = '```') => [
    paragraph, first, `const first = 1; // ${marker}`, 'const second = 2;', last, '下面的段落',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, lines('```js'));
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  const stored = async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content as string;
  };

  // The paragraph is one logical line with several screen lines: the first ArrowDown must stay inside it.
  await page.locator('.cm-line').filter({ hasText: '末标记' }).click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  for (let index = 0; index < 6 && await page.locator('.cm-live-code').count(); index++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await page.keyboard.type('X');
  // The caret really is inside the block source, not merely near the widget: the character lands on the fence.
  await expect.poll(stored).toBe(lines('X```js'));
  await page.keyboard.press('Meta+z');
  await expect.poll(stored).toBe(lines('```js'));

  // Coming from below, ArrowUp enters the block at its last line so its source can be walked upwards.
  await page.locator('.cm-line').filter({ hasText: '下面的段落' }).click();
  await page.keyboard.press('Home');
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Y');
  await expect.poll(stored).toBe(lines('```js', '```Y'));
  await page.keyboard.press('Meta+z');
  await expect.poll(stored).toBe(lines('```js'));

  // Backspace next to a rendered block exposes its source instead of deleting the closing fence.
  await page.locator('.cm-line').filter({ hasText: '下面的段落' }).click();
  await page.keyboard.press('Home');
  await expect(page.locator('.cm-live-code')).toHaveCount(1);
  const before = await stored();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  expect(await stored()).toBe(before);

  // A block that a search hit already shows as source keeps the default keymap: Delete joins the line above
  // instead of only moving the caret.
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(marker);
  await expect(page.locator('.cm-live-code')).toHaveCount(0);
  await page.locator('.cm-line').filter({ hasText: '下面的段落' }).click();
  await page.locator('.cm-line').filter({ hasText: '末标记' }).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  const beforeDelete = await stored();
  await page.keyboard.press('Delete');
  await expect.poll(stored).toBe(beforeDelete.replace('末标记\nX```js', '末标记X```js'));
});

test('live preview keeps the visible source block when the caret is scrolled away', async ({ page }) => {
  const title = `即时视口-${randomUUID().slice(0, 6)}`;
  const content = Array.from({ length: 80 }, (_, index) => `第${index}段正文 ${'填充'.repeat(10)}`).join('\n\n');
  await page.goto('/');
  await newNote(page, title, content);
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.click();
  await editor.press('Meta+End');
  const scroller = page.locator('.document-scroll');
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(50);
  const containerTop = (await scroller.boundingBox())!.y;

  // Reading starts at the source block that was visible, not at the caret's block at the end.
  await page.getByRole('button', { name: '阅读模式' }).click();
  const firstParagraph = page.locator('.markdown p[data-source-line]').first();
  await expect(firstParagraph).toContainText('第0段正文');
  await expect.poll(async () => ((await firstParagraph.boundingBox())?.y ?? 99999) - containerTop).toBeLessThan(160);

  // Coming back to the editor restores the same source block near the top.
  await page.getByRole('button', { name: '即时渲染模式' }).click();
  const firstLine = page.locator('.cm-line').first();
  await expect(firstLine).toContainText('第0段正文');
  await expect.poll(async () => ((await firstLine.boundingBox())?.y ?? 99999) - containerTop).toBeLessThan(160);
});

test('live preview renders unopened math and highlighted code offline', async ({ page, context }) => {
  const title = `即时离线-${randomUUID().slice(0, 6)}`;
  const id = randomUUID();
  const content = ['# 离线标题', '', '$$', '\\frac{a}{b} + c^2', '$$', '', '```js', 'const offline = 1;', '```', '', '结尾段落。'].join('\n');
  // The note is created through the API, so neither the formula nor the code has ever been rendered here.
  expect((await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: { title, content, tags: [], pinned: false, archived: false, deletedAt: null, revision: 0, operationId: randomUUID() },
  })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(title);
  await expect(page.locator('[data-note-row]').filter({ hasText: title })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(async () => !!(await storedOrderNote(page, id, 'notes'))).toBe(true);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '搜索笔记' }).fill(title);
    await page.locator('[data-note-row]').filter({ hasText: title }).click();
    await expect(page.locator('.cm-live-math-display math mfrac')).toHaveCount(1);
    await expect(page.locator('.cm-live-code .hljs-keyword')).toHaveText('const');
  } finally { await context.setOffline(false); }
});

test.describe('live preview with touch input', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('a touch tap toggles details and opens the image lightbox', async ({ page }) => {
    const title = `即时触摸-${randomUUID().slice(0, 6)}`;
    const content = [
      '<details open>',
      '<summary>触摸折叠</summary>',
      '',
      '触摸正文',
      '',
      '</details>',
      '',
      '图片段落',
    ].join('\n');
    await page.goto('/');
    await newNote(page, title, content);
    const summary = page.locator('.cm-live-details summary');
    await summary.tap();
    await expect(page.locator('.cm-live-details details')).not.toHaveAttribute('open', '');
    await summary.tap();
    await expect(page.locator('.cm-live-details details')).toHaveAttribute('open', '');

    const shot = await page.locator('.document').screenshot({ type: 'png' });
    await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: '触摸图片.png', mimeType: 'image/png', buffer: shot });
    await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
    const image = page.locator('.cm-live-image-button img, .cm-live-inline-image img').first();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await page.locator('.cm-live-image-button, .cm-live-inline-image button').first().tap();
    const lightbox = page.getByRole('dialog');
    await expect(lightbox.getByRole('img', { name: '笔记图片' })).toBeVisible();
    await lightbox.getByRole('button', { name: '关闭', exact: true }).click();
  });
});

test('account security changes the password and logs out every device', async ({ page }) => {
  const newPassword = 'Changed-EasyNote-Password-842!';
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前密码').nth(0).fill(testPassword);
  await dialog.getByLabel('新密码', { exact: true }).fill(newPassword);
  await dialog.getByLabel('确认新密码').fill(newPassword);
  await dialog.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByRole('status')).toHaveText('密码已修改，其他设备已退出');
  await dialog.getByLabel('当前密码').nth(1).fill(newPassword);
  await dialog.getByRole('button', { name: '登出所有设备' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码').fill(newPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
});
