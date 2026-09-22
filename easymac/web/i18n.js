(function () {
  "use strict";
  const key = "easymac-language";
  const language = localStorage.getItem(key) === "en" ? "en" : "zh";
  const exact = {
    "设置": "Settings", "语言": "Language", "关闭": "Close", "中文": "Chinese", "英文": "English",
    "正在读取本地扫描结果": "Loading local scan results", "扫描清单仅保存在本机": "Scan list stays on this Mac",
    "正在扫描这台 Mac": "Scanning this Mac", "应用列表准备完成后会自动显示": "The app list appears when scanning finishes", "正在扫描": "Scanning",
    "应用分类": "App Categories", "分类": "Categories", "个扫描项目": "scanned items", "搜索名称、标识或路径": "Search name, identifier, or path",
    "搜索应用": "Search apps", "选择当前结果": "Select Current Results", "清空选择": "Clear Selection", "全部项目": "All Items",
    "可自动安装": "Automatic", "图形应用": "GUI Apps", "命令行工具": "Command-line Tools", "网页应用": "Web Apps", "手动安装": "Manual",
    "选择全部可自动安装": "Select All Automatic", "没有匹配项目": "No matching items", "调整搜索词或分类后重试": "Change search or category and try again",
    "迁移计划": "Migration Plan", "尚未选择项目": "No items selected", "自动安装": "Automatic", "选择统计": "Selection Summary",
    "无需 Homebrew": "Homebrew Not Needed", "需要 Homebrew": "Homebrew Required", "选择可自动安装项目后会自动加入": "Added when automatic items are selected",
    "脚本预览": "Script Preview", "只读": "Read Only", "下载迁移脚本": "Download Migration Script",
    "自动项目由脚本安装；网页应用仅保留宿主浏览器和重建地址。": "The script installs automatic items. Web apps keep their browser and restore URL.",
    "下载为 ZIP 以保留执行权限，解压后可直接双击运行。": "Download as ZIP to preserve permissions. Unzip, then double-click to run.",
    "请从 EasyMac.app 启动": "Open from EasyMac.app", "选择页面需要先读取这台 Mac 的本地扫描结果。": "This page needs local scan results from this Mac.",
    "未识别安装来源": "Unknown install source", "浏览器": "Browser", "本地扫描结果": "Local scan results", "未找到本地扫描结果": "No local scan results found",
    "迁移脚本已下载": "Migration script downloaded", "尚未选择项目": "No items selected", "当前脚本只会列出需要手动处理的项目": "The script lists items that need manual action",
    "当前脚本只会列出网页应用及清理跟踪参数后的地址": "The script lists web apps and URLs without tracking parameters",
    "当前脚本只会列出手动安装提醒": "The script lists manual installation reminders",
    "自动准备所选项目的前置依赖": "Automatically prepare prerequisites for selected items",
    "# 选择项目后，这里会显示完整迁移脚本。": "# The complete migration script will appear here after selecting items.",
    "脚本会先安装 Homebrew 和 mas，再处理所选项目": "The script will install Homebrew and mas before processing selected items.",
    "脚本会先检测并按需安装 Homebrew": "The script will detect and install Homebrew if needed.",
    "在旧 Mac 本地扫描应用并生成迁移安装脚本": "Scan apps on your old Mac and generate a migration install script",
  };
  const phrases = [
    [" 个结果", " results"],
    ["已选择当前结果中的 ", "Selected "],
    ["已选择 ", "Selected "],
    [" 个可自动安装项目", " automatic items"],
    [" 个项目", " items"],
    [" 扫描", " scan"],
    ["选择 ", "Select "],
  ];
  function translate(value) {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (exact[trimmed]) return value.replace(trimmed, exact[trimmed]);
    let translated = value;
    for (const [source, target] of phrases) translated = translated.replaceAll(source, target);
    return translated;
  }
  function translateElement(element) {
    if (element.closest("pre, code, [data-i18n-ignore]")) return;
    for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, translate(value));
    }
    for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const translated = translate(node.textContent);
      if (translated !== node.textContent) node.textContent = translated;
    }
  }
  function apply(root) {
    if (root instanceof Element) translateElement(root);
    root.querySelectorAll?.("*").forEach(translateElement);
  }
  document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  const select = document.querySelector("#languageSelect");
  select.value = language;
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    location.reload();
  });
  const dialog = document.querySelector("#settingsDialog");
  document.querySelector("#settingsButton").addEventListener("click", () => dialog.showModal());
  document.querySelector("#settingsClose").addEventListener("click", () => dialog.close());
  if (language !== "en") return;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    const desc = metaDesc.getAttribute("content");
    if (desc) metaDesc.setAttribute("content", translate(desc));
  }
  apply(document.body);
  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === "attributes") translateElement(record.target);
    record.addedNodes.forEach((node) => node instanceof Element ? apply(node) : node.parentElement && translateElement(node.parentElement));
  })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "title", "placeholder", "alt"] });
})();
