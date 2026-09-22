export type UiLanguage = 'zh' | 'en';

const storageKey = 'easynote-language';
export const uiLanguage = (): UiLanguage => localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh';
export const setUiLanguage = (language: UiLanguage) => {
  localStorage.setItem(storageKey, language);
  location.reload();
};

const exact: Record<string, string> = {
  '设置': 'Settings', '语言': 'Language', '中文': 'Chinese', '英文': 'English',
  '全部笔记': 'All Notes', '回收站': 'Trash', '新建笔记': 'New Note', '搜索笔记': 'Search notes',
  '任务': 'Tasks', '分享': 'Sharing', '标签': 'Tags', '标签管理': 'Manage Tags', '暂无已有标签': 'No existing tags',
  '打开导航菜单': 'Open navigation menu', '打开设置': 'Open Settings',
  '编辑': 'Edit', '预览': 'Preview', '历史版本': 'Version History', '只读分享': 'Read-only Share',
  '归档': 'Archive', '取消归档': 'Unarchive', '置顶': 'Pin', '取消置顶': 'Unpin', '移入回收站': 'Move to Trash',
  '永久删除': 'Delete Permanently', '恢复笔记': 'Restore Note', '插入图片': 'Insert Image', '插入附件': 'Insert Attachment',
  '同步并更新历史版本': 'Sync and Save Version', '正在同步并更新历史版本': 'Syncing and Saving Version',
  '已保存到云端': 'Saved to Cloud', '正在保存': 'Saving', '正在同步': 'Syncing', '离线': 'Offline',
  '大纲与链接': 'Outline & Links', '大纲': 'Outline', '反向链接': 'Backlinks', '没有标题': 'No headings', '没有反向链接': 'No backlinks',
  '深色外观': 'Dark Appearance', '使用宽屏': 'Use Wide Layout', '使用阅读宽度': 'Use Reading Width',
  '离线笔记库': 'Offline Note Library', '账户安全': 'Account Security', '用户与注册': 'Users & Registration',
  '管理': 'Manage', '管理用户': 'Manage Users', '退出登录': 'Sign Out', '版本': 'Version',
  '数据': 'Data', '导出': 'Export', '导入': 'Import', '导出草稿': 'Export Drafts', '查看导入格式示例': 'View Import Format Example',
  'AI 接入': 'AI Access', '名称': 'Name', '权限': 'Access', '有效期': 'Expiration', '读取和写入': 'Read & Write', '只读': 'Read Only',
  '创建令牌': 'Create Token', '暂无有效令牌': 'No active tokens', '复制令牌': 'Copy Token', '复制 Codex 配置': 'Copy Codex Config',
  '关闭': 'Close', '取消': 'Cancel', '确认': 'Confirm', '保存': 'Save', '删除': 'Delete', '创建': 'Create', '重试': 'Retry',
  '用户': 'User', '管理员': 'Administrator', '用户名': 'Username', '密码': 'Password', '新密码': 'New Password',
  '登录': 'Sign In', '创建账户': 'Create Account', '提交注册': 'Submit Registration', '恢复账户': 'Recover Account', '重置密码': 'Reset Password',
  '允许自助注册': 'Allow Self-registration', '创建用户': 'Create User', '用户列表': 'User List', '启用': 'Enabled',
  '分享管理': 'Share Management', '暂无正在分享的笔记': 'No shared notes', '永久': 'Permanent', '延期': 'Extend', '取消分享': 'Stop Sharing',
  '1 小时': '1 hour', '1 天': '1 day', '7 天': '7 days', '30 天': '30 days', '永久有效': 'Never expires',
  '创建链接': 'Create Link', '替换链接': 'Replace Link', '复制': 'Copy', '已复制': 'Copied', '撤销': 'Revoke',
  '任务中心': 'Task Center', '没有未完成的待办事项': 'No incomplete tasks', '正在汇总待办…': 'Collecting tasks…',
  '快捷键': 'Keyboard Shortcuts', '快速跳转': 'Quick Open', '没有匹配的笔记': 'No matching notes', '暂无笔记': 'No notes',
  '批量选择': 'Select Multiple', '退出批量选择': 'Exit Selection', '全选': 'Select All', '取消全选': 'Clear Selection',
  '批量添加标签': 'Add Tag to Selected Notes', '管理标签': 'Manage Tags', '来源标签': 'Source Tag', '操作': 'Action',
  '重命名': 'Rename', '合并': 'Merge', '目标标签': 'Target Tag', '应用': 'Apply',
  '检测到版本冲突': 'Version Conflict Detected', 'PDF 文件名': 'PDF Filename', 'PDF 纸张': 'PDF Paper',
  'PDF 方向': 'PDF Orientation', 'PDF 缩放': 'PDF Scale', '纵向': 'Portrait', '横向': 'Landscape',
  '笔记操作': 'Note Actions', '同步并保存版本': 'Sync and Save Version', '全部永久删除': 'Delete All Permanently',
  '当前': 'Current', '已启用': 'Enabled', '已停用': 'Disabled', '待批准': 'Pending Approval', '（当前）': ' (current)',
  '正在加载…': 'Loading…', '正在连接': 'Connecting', '正在打开笔记': 'Opening Note', '处理中…': 'Working…',
};

const phrases: [string, string][] = [
  ['未命名笔记', 'Untitled Note'], ['已归档', 'Archived'], ['修订', 'Revision'], ['字符', 'characters'],
  ['第 ', 'Line '], [' 行', ''], ['有效至 ', 'Expires '], ['截止 ', 'Until '], ['分享于 ', 'Shared '],
  ['正在读取', 'Loading '], ['正在准备', 'Preparing '], ['正在生成', 'Generating '], ['正在渲染', 'Rendering '],
  ['已选择 ', 'Selected '], [' 篇笔记', ' notes'], [' 个标签', ' tags'], [' 个字符', ' characters'],
];

Object.assign(exact, {
  '应用': 'App', '安装 EasyNote': 'Install EasyNote', '导出 ZIP': 'Export ZIP', '导入文件': 'Import Files', '导入目录': 'Import Folder',
  '请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。': 'Select a complete ZIP exported by EasyNote. Do not extract it and select note files individually.',
  '也可导入 Obsidian 目录、通用 Markdown/TXT ZIP 或多个 Markdown/TXT 文件；本地 Wiki 链接、相对链接和受支持附件会自动转换。': 'You can also import an Obsidian folder, a Markdown/TXT ZIP, or multiple Markdown/TXT files. Local Wiki links, relative links, and supported attachments are converted automatically.',
  '笔记文件优先使用标题命名，重名时自动编号；ZIP 根据清单恢复原标题。单独导入 Markdown 或 TXT 时，正文首个非空行作为标题。正文完全一致或完全空白的重复笔记会自动跳过。': 'Note files use titles as names and add numbers for duplicates. ZIP imports restore original titles from the manifest. Standalone Markdown or TXT imports use the first non-empty line as the title. Exact or blank duplicates are skipped.',
  '令牌仅显示一次': 'Token shown only once', '例如：本机 AI': 'Example: Local AI', '30 天': '30 days', '90 天': '90 days', '365 天': '365 days',
  '确认撤销': 'Confirm Revoke', '取消撤销': 'Cancel Revoke', '撤销令牌': 'Revoke Token', '正在读取令牌…': 'Loading tokens…',
  '更改密码': 'Change Password', '确认新密码': 'Confirm New Password', '恢复代码': 'Recovery Code', '复制恢复代码': 'Copy Recovery Code',
  '注销账号': 'Delete Account', '确认注销': 'Confirm Account Deletion', '当前密码': 'Current Password',
  '初始密码（至少 12 位）': 'Initial password (at least 12 characters)', '新用户用户名': 'New user username', '新用户密码': 'New user password',
  '新用户角色': 'New user role', '留空则不改密码': 'Leave blank to keep password', '确认删除': 'Confirm Delete', '删除用户': 'Delete User',
  '正在读取用户…': 'Loading users…', '正常笔记': 'Notes', '归档笔记': 'Archived Notes', '打开任务中心': 'Open Task Center',
  '打开分享管理': 'Open Share Management', '管理标签': 'Manage Tags', '展开侧栏': 'Expand Sidebar', '收起侧栏': 'Collapse Sidebar',
  '快速跳转搜索': 'Quick Open Search', '清空搜索': 'Clear Search', '返回笔记列表': 'Back to Note List', '笔记空间': 'Note Workspace',
  '你的笔记': 'Your Notes', '开始记录…': 'Start writing…', '笔记正文': 'Note Content', '笔记标题': 'Note Title', '笔记标签': 'Note Tags',
  '显示模式': 'Display Mode', '编辑模式': 'Edit Mode', '预览模式': 'Preview Mode', '切换到编辑模式': 'Switch to Edit Mode', '切换到预览模式': 'Switch to Preview Mode',
  '大纲与反向链接': 'Outline & Backlinks', '打开大纲与反向链接': 'Open Outline & Backlinks', '关闭笔记导航': 'Close Note Navigation',
  '插入内部链接': 'Insert Internal Link', '搜索链接目标': 'Search Link Target', '链接': 'Link', '附件': 'Attachment', '图片': 'Image',
  '导出为 PDF': 'Export PDF', '导出当前笔记为 PDF': 'Export Current Note as PDF', 'PDF 分页预览': 'PDF Page Preview',
  '正在打开分页预览': 'Opening Page Preview', '正在渲染分页预览': 'Rendering Page Preview', '正在生成分页预览': 'Generating Page Preview',
  '文件名': 'Filename', '纸张': 'Paper', '方向': 'Orientation', '缩放': 'Scale', '打印': 'Print',
  '查看历史版本': 'View Version History', '恢复此版本': 'Restore This Version', '查看快捷键': 'View Keyboard Shortcuts',
  '更多笔记操作': 'More Note Actions', '移动端笔记分类': 'Mobile Note Categories', '移动端标签': 'Mobile Tags',
  '同步全部': 'Sync All', '正在同步全部': 'Syncing All', '待处理草稿': 'Pending Drafts', '本机草稿': 'Local Draft', '仅保存在本机': 'Stored Locally Only',
  '已同步，内容为最新': 'Synced and Up to Date', '已保存并记录历史版本': 'Saved with Version', '正在重试…': 'Retrying…',
  '分享有效': 'Share Active', '只读分享链接': 'Read-only Share Link', '延长 1 天': 'Extend 1 Day', '延长 7 天': 'Extend 7 Days',
  '延长 30 天': 'Extend 30 Days', '设为永久': 'Make Permanent', '暂无正在分享的笔记': 'No Shared Notes',
  '永久删除这篇笔记？': 'Delete this note permanently?', '将永久删除回收站中的全部笔记，此操作无法撤销。': 'All notes in Trash will be permanently deleted. This cannot be undone.',
  '另一个标签页正在编辑': 'Another Tab Is Editing', '浏览器不支持安全编辑锁': 'Browser Does Not Support Safe Edit Lock',
});

const ignored = '.note-row, .note-title, .cm-editor, .markdown, .tag-nav, .tag-picker label, .task-center-copy, .version-preview, pre, code, [data-i18n-ignore]';

function translate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const match = exact[trimmed];
  if (match) return value.replace(trimmed, match);
  let translated = value;
  for (const [source, target] of phrases) translated = translated.replaceAll(source, target);
  return translated;
}

function translateElement(element: Element) {
  if (element.closest(ignored)) return;
  for (const attribute of ['aria-label', 'title', 'placeholder']) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const translated = translate(value);
    if (translated !== value) element.setAttribute(attribute, translated);
  }
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const translated = translate(node.textContent);
      if (translated !== node.textContent) node.textContent = translated;
    }
  }
}

export function installUiLanguage() {
  const language = uiLanguage();
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  if (language !== 'en') return;
  document.title = 'EasyNote';
  const apply = (root: Document | Element) => {
    if (root instanceof Element) translateElement(root);
    root.querySelectorAll?.('*').forEach(translateElement);
  };
  apply(document.body);
  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === 'attributes') translateElement(record.target as Element);
    if (record.type === 'characterData' && record.target.parentElement) translateElement(record.target.parentElement);
    record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.parentElement && !node.parentElement.closest(ignored) && node.textContent) node.textContent = translate(node.textContent);
      else if (node instanceof Element) apply(node);
    });
  })).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder'] });
}
