export type UiLanguage = 'zh' | 'en';

const storageKey = 'easynote-language';
export const uiLanguage = (): UiLanguage => localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh';
export const setUiLanguage = (language: UiLanguage) => {
  localStorage.setItem(storageKey, language);
  location.reload();
};

const exact: Record<string, string> = {
  '设置': 'Settings', '语言': 'Language',
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

export const dateLocale = (): string => uiLanguage() === 'en' ? 'en-US' : 'zh-CN';

const phrases: [string, string][] = [
  ['未命名笔记', 'Untitled Note'], ['未命名图片', 'Untitled image'], ['未命名', 'Untitled'],
  ['已取消归档', 'Unarchived'], ['已归档', 'Archived'],
  ['第 ', 'Line '], [' 行', ''], ['有效至 ', 'Expires '], ['截止 ', 'Until '], ['分享于 ', 'Shared '], ['更新于 ', 'Updated '],
  ['正在读取', 'Loading '], ['正在准备', 'Preparing '], ['正在生成', 'Generating '], ['正在渲染', 'Rendering '], ['正在打包 ', 'Packaging '],
  ['已选择 ', 'Selected '],
  [' 篇笔记添加标签', ' notes'],
  [' 篇笔记移入回收站？', ' notes to Trash?'],
  [' 篇笔记移入回收站?', ' notes to Trash?'],
  [' 篇笔记将移入回收站，可稍后恢复。', ' notes will be moved to Trash and can be restored later.'],
  [' 篇笔记移入回收站', ' notes to Trash'],
  [' 篇笔记已存在', ' notes already exist'],
  [' 篇笔记中移除', ' notes'],
  [' 篇笔记', ' notes'],
  [' 个标签', ' tags'], [' 个字符', ' characters'], [' 个文件', ' files'],
  [' 篇本机草稿', ' local drafts'], [' 篇草稿', ' drafts'],
  ['已导出 ', 'Exported '], ['已新增标签 #', 'Added tag #'],
  ['本机基于修订 ', 'Local based on revision '], ['，云端已到修订 ', ', cloud is at revision '],
  ['修订', 'Revision'], ['字符', 'characters'],
  ['已将 #', '#'], [' 重命名为 #', ' renamed to #'], [' 合并到 #', ' merged into #'],
  ['已将 ', 'Moved '], ['将 ', 'Move '], ['选中的 ', 'Selected '],
  ['已永久删除 ', 'Permanently deleted '],
  ['批量操作已处理 ', 'Batch operation processed '], [' 篇，在“', ' notes, stopped at "'], ['”处停止。', '".'],
  ['已导入 ', 'Imported '], [' 篇、跳过 ', ' notes, skipped '], [' 篇重复笔记，后续导入停止。', ' duplicate notes, import stopped.'],
  ['，跳过 ', ', skipped '], [' 篇重复笔记', ' duplicate notes'],
  ['跳过重复笔记 ', 'Skipped duplicate notes '], ['导入笔记 ', 'Importing notes '],
  ['恢复文件 ', 'Restoring files '], ['恢复笔记 ', 'Restoring notes '],
  ['上传引用文件 ', 'Uploading referenced files '], ['导出笔记 ', 'Exporting notes '], ['导出文件 ', 'Exporting files '],
  ['已删除标签 #', 'Deleted tag #'],
  ['，更新了 ', ', and updated '],
  ['去除标签 #', 'Remove tag #'], ['去除标签 ', 'Remove tag '],
  ['未导入：', 'Not imported: '],
  ['待办事项：', 'Task: '], ['图表无法渲染：', 'Chart render failed: '],
  [' 延期时长', ' extension duration'], ['延期 ', 'Extend '], ['取消分享 ', 'Stop sharing '],
  [' 用户名', ' username'], [' 角色', ' role'], [' 新密码', ' new password'], ['删除用户 ', 'Delete user '],
  ['文件不能超过 ', 'File cannot exceed '], ['图片不能超过 ', 'Image cannot exceed '], ['附件不能超过 ', 'Attachment cannot exceed '],
  ['图片无法写入 PDF：', 'Image cannot be written to PDF: '],
  ['已为 ', 'Added tags to '],
  ['已插入 ', 'Inserted '],
  ['撤销令牌 ', 'Revoke token '],
  ['[图片：', '[Image: '], ['[图片]', '[Image]'],
  ['本机离线数据清理失败：', 'Failed to clean local offline data: '],
  ['PDF 第 ', 'PDF Page '], [' 页', ' pages'],
  ['导入目录存在重复路径：', 'Duplicate path in import folder: '],
  ['转换后的笔记超过大小限制：', 'Converted note exceeds size limit: '],
  ['笔记超过大小限制：', 'Note exceeds size limit: '],
  ['笔记不是 UTF-8：', 'Note is not UTF-8: '],
  ['本地草稿写入失败，请勿关闭页面。', 'Failed to save local draft. Please do not close this page.'],
  ['离线附件缓存失败，将在后续同步时重试。', 'Failed to cache offline attachments. Will retry on next sync.'],
  ['离线笔记写入失败。', 'Failed to save offline note.'],
  ['离线 PDF 资源准备失败。', 'Failed to prepare offline PDF resources.'],
  ['后台同步失败，将自动重试。', 'Background sync failed. Will retry automatically.'],
  [' (冲突副本)', ' (Conflict Copy)'], ['(冲突副本)', '(Conflict Copy)'],
  [' 篇', ' notes'],
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
  '永久删除这篇笔记？': 'Delete this note permanently?', '永久删除这篇笔记?': 'Delete this note permanently?', '将永久删除回收站中的全部笔记，此操作无法撤销。': 'All notes in Trash will be permanently deleted. This cannot be undone.',
  '另一个标签页正在编辑': 'Another Tab Is Editing', '浏览器不支持安全编辑锁': 'Browser Does Not Support Safe Edit Lock',
  '添加标签': 'Add Tag', '新增标签': 'New Tag', '输入新标签名称…': 'Enter new tag name…',
  '暂无标签，在上方输入名称创建新标签': 'No tags. Enter a name above to create one.',
  '确认合并': 'Confirm Merge', '搜索或回车新建标签…': 'Search or press enter to create…',
  '新建并打标': 'Create & Tag', '按回车创建新标签': 'Press Enter to create new tag', '完成': 'Done',
  '备份已下载': 'Backup downloaded', '正在准备草稿…': 'Preparing drafts…', '添加': 'Add',
  '云端笔记已永久删除，本机草稿仍然安全保留。': 'Cloud note was permanently deleted. Local draft remains safely preserved.',
  '永久删除全部笔记？': 'Delete all notes permanently?', '永久删除全部笔记?': 'Delete all notes permanently?', '移入回收站？': 'Move to Trash?', '移入回收站?': 'Move to Trash?', '笔记图片': 'Note image',
  '标签必须为 1-40 个字符，且不能包含逗号。': 'Tags must be 1-40 characters and cannot contain commas.',
  '最多 20 个标签。': 'Maximum of 20 tags.', '该标签已存在。': 'Tag already exists.',
  '本机还有未上传草稿，请先完成保存。': 'There are unsaved local drafts. Please save them first.',
  '请先保存当前笔记。': 'Please save the current note first.',
  '部分笔记已不可用，请刷新列表后重试。': 'Some notes are no longer available. Please refresh the list and try again.',
  '离线资源准备超时，请稍后重试。': 'Offline resources timed out. Please try again later.',
  '这篇笔记尚未保存到本机。': 'This note has not been saved locally yet.',
  '离线笔记写入失败。': 'Failed to save offline note.', ' (冲突副本)': ' (Conflict Copy)',
  '没有选择导入文件。': 'No import files selected.', '笔记大小超过限制。': 'Note exceeds size limit.',
  '已跳过重复笔记': 'Skipped duplicate notes', 'EasyNote 备份清单过大。': 'EasyNote backup manifest is too large.',
  '不支持的备份格式。': 'Unsupported backup format.', '文件缺失、重复或校验失败。': 'Files missing, duplicated, or failed verification.',
  '笔记清单无效或正文缺失。': 'Note manifest is invalid or content is missing.',
  '笔记引用的文件不在备份中。': 'Referenced files are not in the backup.',
  '当前没有待同步的本机草稿。': 'No local drafts pending sync.',
  '当前浏览器导出上限为 64 MiB / 1200 个文件。': 'Browser export limit is 64 MiB / 1200 files.',
  '本机草稿导出上限为 64 MiB / 1200 个文件。': 'Local draft export limit is 64 MiB / 1200 files.',
  '导入文件超过 64 MiB。': 'Import file exceeds 64 MiB.', '导入内容超过 64 MiB。': 'Import content exceeds 64 MiB.',
  '备份解压大小、路径或文件数量不符合限制。': 'Backup size, path, or file count exceeds limits.',
  '导入目录包含不安全路径。': 'Import directory contains unsafe paths.', '导入文件路径无效。': 'Import file path is invalid.',
  '请选择包含 Markdown 或 TXT 的目录或 ZIP。': 'Please select a directory or ZIP containing Markdown or TXT.',
  '没有找到 Markdown 或 TXT 笔记。': 'No Markdown or TXT notes found.',
  'PDF 预览生成失败。': 'Failed to generate PDF preview.', 'PDF 离线资源下载失败。': 'Failed to download offline PDF resources.',
  '已移入回收站': 'Moved to Trash', '还有未保存的内容，请先完成保存。': 'There are unsaved changes. Please save them first.',
  '新建': 'New', '同步': 'Sync', '保存并同步': 'Save & Sync', '搜索': 'Search',
  '切换': 'Switch', '置顶笔记': 'Pin Note', '历史': 'History', '待办': 'Tasks',
  '创建只读分享链接': 'Create Read-only Share Link', '只读链接': 'Read-only Link', '帮助': 'Help',
  '关闭错误': 'Dismiss Error', '笔记分类': 'Note Categories', '全部选中': 'Select All',
  '空白笔记': 'Blank note', '调整笔记列表宽度': 'Resize note list width',
  '拖动调整宽度，双击恢复默认': 'Drag to resize, double-click to reset',
  '上传文件中': 'Uploading file', '笔记导航': 'Note Navigation', '选择或创建标签': 'Select or create tag',
  '[外部图片未加载]': '[External image not loaded]', '返回脚注引用': 'Return to footnote reference',
  '图表内容过大或数量超过 20 个。': 'Chart content is too large or exceeds 20 items.',
  '图表内容为空。': 'Chart content is empty.',
  '只读分享链接已创建': 'Read-only share link created', '分享链接已撤销': 'Share link revoked',
  '分享已设为永久有效': 'Share set to permanent', '分享有效期已延长': 'Share expiration extended',
  '分享已取消': 'Share stopped',
  '用户已创建': 'User created', '用户设置已保存': 'User settings saved',
  '用户已停用，数据正在安全清理': 'User disabled, data being securely cleaned',
  '已开启注册，新增账号需管理员批准': 'Registration enabled. New accounts require admin approval.',
  '已关闭自助注册': 'Self-registration disabled',
  '仅支持 JPEG、PNG、WebP 图片。': 'Only JPEG, PNG, and WebP images are supported.',
  '图片尺寸超过限制。': 'Image dimensions exceed limits.',
  '仅支持 PDF、Markdown、TXT、CSV 和 JSON 附件。': 'Only PDF, Markdown, TXT, CSV, and JSON attachments are supported.',
  '图片读取失败。': 'Failed to read image.', '图片转换失败。': 'Failed to convert image.',
  'Mermaid 图表尺寸无效。': 'Invalid Mermaid chart dimensions.',
  'Mermaid 图表转换失败。': 'Failed to convert Mermaid chart.',
  'Mermaid 图表尚未准备完成。': 'Mermaid chart is not ready yet.',
  'Mermaid 图表': 'Mermaid Chart', 'PDF 正文尚未准备完成。': 'PDF content is not ready yet.',
  '新密码必须为 12-128 个字符。': 'New password must be 12-128 characters.',
  '两次输入的新密码不一致。': 'New passwords do not match.',
  '两次输入的密码不一致。': 'Passwords do not match.',
  '密码已修改，其他设备已退出': 'Password changed, other devices signed out',
  '恢复代码已复制': 'Recovery code copied',
  '新的恢复代码已生成': 'New recovery code generated',
  'AI 接入令牌已创建': 'AI access token created',
  'AI 接入令牌已撤销': 'AI access token revoked',
  '令牌已复制': 'Token copied',
  'Codex 配置已复制': 'Codex config copied',
  'AI 接入令牌': 'AI Access Token',
  'PDF 内容准备超时，请检查笔记中的图片或图表后重试。': 'PDF preparation timed out. Please check images or charts in the note and try again.',
  '登录已过期，请重新登录。': 'Login expired, please sign in again.',
  '密码已重置，请登录。': 'Password reset, please sign in.',
  'PDF 内容尚未准备完成。': 'PDF content is not ready yet.',
  '附件需要联网上传。': 'Attachments require an internet connection to upload.',
  '图片已插入': 'Image inserted',
  '附件已插入': 'Attachment inserted',
  '草稿已保存并同步': 'Draft saved and synced',
  '已恢复版本，恢复前内容已保留': 'Version restored, previous content preserved',
  '正在准备分页预览': 'Preparing page preview',
  'PDF 已交给系统保存': 'PDF sent to system save',
  'PDF 已下载': 'PDF downloaded',
  '这个附件尚未保存到本机。': 'This attachment has not been saved locally yet.',
  '标签必须为 1-40 个字符。': 'Tag must be 1-40 characters.',
  '当前笔记不可用，请刷新后重试。': 'Current note unavailable, please refresh and try again.',
  '标题': 'Title', '正文': 'Content', '置顶状态': 'Pin Status', '归档状态': 'Archive Status', '删除状态': 'Delete Status',
  '无标签': 'No tags', '已置顶': 'Pinned', '未置顶': 'Not pinned', '未归档': 'Not archived',
  '（空）': '(empty)', '等待初始化': 'Waiting for initialization', '登录笔记': 'Sign in to Notes',
  '示例：': 'Example:', 'manifest.json 示例：': 'manifest.json Example:',
  '重新打开': 'Reopen',
});

const ignored = '.note-row, .note-title, .cm-editor, .markdown, .tag-nav, .tag-picker label, .task-center-copy, .version-preview, pre, code, [data-i18n-ignore]';

export function translate(value: string) {
  if (uiLanguage() !== 'en') return value;
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
  for (const attribute of ['aria-label', 'title', 'placeholder', 'data-tooltip', 'alt']) {
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
  })).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder', 'data-tooltip', 'alt'] });
}
