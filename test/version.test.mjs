import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { bumpVersion, extractReleaseNotes } from '../scripts/version.mjs';

const root = new URL('..', import.meta.url).pathname;

const sampleNotes = `## EasyMac 0.4.3

- 重构国际化体系为独立字典（\`i18n.js\`），支持 \`t(key, ...args)\` 参数插值。
- HTML 采用 \`data-i18n*\` 标记静态文案，JS 动态文案统一使用 \`t(...)\` 获取。
- 新增 \`scripts/check-i18n.mjs\` 自动化 Key 对齐检查。

## EasyMac 0.4.2

- 统一设置面板语言标签为「语言/Language」。

## EasyMac 0.3.3

项目正式更名为 EasyMac，全面同步应用标识与发布工作流。

- 项目全面重命名为 EasyMac（原 EasyNewMac）。
- 应用程序名称、Bundle ID (\`party.tiandi.easymac\`)。
`;

test('extractReleaseNotes extracts only the target version notes', () => {
  const notes043 = extractReleaseNotes(sampleNotes, '0.4.3');
  assert.equal(
    notes043,
    '- 重构国际化体系为独立字典（`i18n.js`），支持 `t(key, ...args)` 参数插值。\n' +
    '- HTML 采用 `data-i18n*` 标记静态文案，JS 动态文案统一使用 `t(...)` 获取。\n' +
    '- 新增 `scripts/check-i18n.mjs` 自动化 Key 对齐检查。'
  );

  const notes042 = extractReleaseNotes(sampleNotes, '0.4.2');
  assert.equal(notes042, '- 统一设置面板语言标签为「语言/Language」。');

  const notes033 = extractReleaseNotes(sampleNotes, '0.3.3');
  assert.ok(notes033.startsWith('项目正式更名为 EasyMac'));
  assert.ok(notes033.includes('- 应用程序名称、Bundle ID'));
  assert.ok(!notes033.includes('0.4.2'));
});

test('extractReleaseNotes supports includeHeading option', () => {
  const withHeading = extractReleaseNotes(sampleNotes, '0.4.2', { includeHeading: true });
  assert.equal(withHeading, '## EasyMac 0.4.2\n\n- 统一设置面板语言标签为「语言/Language」。');
});

test('extractReleaseNotes throws on non-existent version', () => {
  assert.throws(
    () => extractReleaseNotes(sampleNotes, '0.9.9'),
    /Release notes for version 0\.9\.9 not found/
  );
});

test('bumpVersion increments semantic versions correctly', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
});

test('CLI notes command outputs extracted version notes', () => {
  const result = spawnSync('node', [join(root, 'scripts/version.mjs'), 'notes', 'easymac', '0.4.3'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /重构国际化体系/);
  assert.ok(!result.stdout.includes('0.4.2'));
  assert.ok(!result.stdout.includes('0.4.1'));
});
