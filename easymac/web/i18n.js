(function (global) {
  "use strict";

  const key = "easymac-language";

  const translations = {
    zh: {
      meta_description: "在旧 Mac 本地扫描应用并生成迁移安装脚本",
      scan_source_reading: "正在读取本地扫描结果",
      privacy_note: "扫描清单仅保存在本机",
      settings: "设置",
      scan_status_title: "正在扫描这台 Mac",
      scan_status_desc: "应用列表准备完成后会自动显示",
      scan_progress_aria: "正在扫描",
      app_categories: "应用分类",
      categories: "分类",
      scanned_items_suffix: "个扫描项目",
      search_placeholder: "搜索名称、标识或路径",
      search_aria: "搜索应用",
      select_current_results: "选择当前结果",
      clear_selection: "清空选择",
      all_items: "全部项目",
      select_all_automatic: "选择全部可自动安装",
      no_matching_items: "没有匹配项目",
      no_matching_items_hint: "调整搜索词或分类后重试",
      migration_plan: "迁移计划",
      no_items_selected: "尚未选择项目",
      selection_summary_aria: "选择统计",
      metric_automatic: "自动安装",
      metric_pwa: "网页应用",
      metric_manual: "手动安装",
      homebrew_not_needed: "无需 Homebrew",
      homebrew_not_needed_desc: "选择可自动安装项目后会自动加入",
      script_preview: "脚本预览",
      read_only: "只读",
      download_migration_script: "下载迁移脚本",
      export_note_line1: "自动项目由脚本安装；网页应用仅保留宿主浏览器和重建地址。",
      export_note_line2: "下载为 ZIP 以保留执行权限，解压后可直接双击运行。",
      error_title: "请从 EasyMac.app 启动",
      error_desc: "选择页面需要先读取这台 Mac 的本地扫描结果。",
      close: "关闭",
      language_label: "语言",

      filter_all: "全部项目",
      filter_automatic: "可自动安装",
      filter_cask: "图形应用",
      filter_mas: "App Store",
      filter_formula: "命令行工具",
      filter_pwa: "网页应用",
      filter_manual: "手动安装",

      kind_formula: "命令行工具",
      kind_pwa: "网页应用",
      kind_manual: "手动安装",

      unknown_install_source: "未识别安装来源",
      browser: "浏览器",
      homebrew_dep_detail: "自动准备所选项目的前置依赖",
      result_summary: "{0} 个结果",
      select_item_aria: "选择 {0}",
      selected_summary: "已选择 {0} 个项目",
      script_preview_empty: "# 选择项目后，这里会显示完整迁移脚本。",
      homebrew_required: "需要 Homebrew",
      homebrew_mas_desc: "脚本会先安装 Homebrew 和 mas，再处理所选项目",
      homebrew_desc: "脚本会先检测并按需安装 Homebrew",
      homebrew_pwa_manual_desc: "当前脚本只会列出需要手动处理的项目",
      homebrew_pwa_desc: "当前脚本只会列出网页应用及清理跟踪参数后的地址",
      homebrew_manual_desc: "当前脚本只会列出手动安装提醒",
      migration_script_downloaded: "迁移脚本已下载",
      toast_selected_visible: "已选择当前结果中的 {0} 个项目",
      toast_selected_automatic: "已选择 {0} 个可自动安装项目",
      scan_source_time: "{0} 扫描",
      local_scan_results: "本地扫描结果",
      no_local_scan_results: "未找到本地扫描结果",
    },
    en: {
      meta_description: "Scan apps on your old Mac and generate a migration install script",
      scan_source_reading: "Loading local scan results",
      privacy_note: "Scan list stays on this Mac",
      settings: "Settings",
      scan_status_title: "Scanning this Mac",
      scan_status_desc: "The app list appears when scanning finishes",
      scan_progress_aria: "Scanning",
      app_categories: "App Categories",
      categories: "Categories",
      scanned_items_suffix: "scanned items",
      search_placeholder: "Search name, identifier, or path",
      search_aria: "Search apps",
      select_current_results: "Select Current Results",
      clear_selection: "Clear Selection",
      all_items: "All Items",
      select_all_automatic: "Select All Automatic",
      no_matching_items: "No matching items",
      no_matching_items_hint: "Change search or category and try again",
      migration_plan: "Migration Plan",
      no_items_selected: "No items selected",
      selection_summary_aria: "Selection Summary",
      metric_automatic: "Automatic",
      metric_pwa: "Web Apps",
      metric_manual: "Manual",
      homebrew_not_needed: "Homebrew Not Needed",
      homebrew_not_needed_desc: "Added when automatic items are selected",
      script_preview: "Script Preview",
      read_only: "Read Only",
      download_migration_script: "Download Migration Script",
      export_note_line1: "The script installs automatic items. Web apps keep their browser and restore URL.",
      export_note_line2: "Download as ZIP to preserve permissions. Unzip, then double-click to run.",
      error_title: "Open from EasyMac.app",
      error_desc: "This page needs local scan results from this Mac.",
      close: "Close",
      language_label: "Language",

      filter_all: "All Items",
      filter_automatic: "Automatic",
      filter_cask: "GUI Apps",
      filter_mas: "App Store",
      filter_formula: "Command-line Tools",
      filter_pwa: "Web Apps",
      filter_manual: "Manual",

      kind_formula: "Command-line Tools",
      kind_pwa: "Web Apps",
      kind_manual: "Manual",

      unknown_install_source: "Unknown install source",
      browser: "Browser",
      homebrew_dep_detail: "Automatically prepare prerequisites for selected items",
      result_summary: "{0} results",
      select_item_aria: "Select {0}",
      selected_summary: "Selected {0} items",
      script_preview_empty: "# The complete migration script will appear here after selecting items.",
      homebrew_required: "Homebrew Required",
      homebrew_mas_desc: "The script will install Homebrew and mas before processing selected items.",
      homebrew_desc: "The script will detect and install Homebrew if needed.",
      homebrew_pwa_manual_desc: "The script lists items that need manual action",
      homebrew_pwa_desc: "The script lists web apps and URLs without tracking parameters",
      homebrew_manual_desc: "The script lists manual installation reminders",
      migration_script_downloaded: "Migration script downloaded",
      toast_selected_visible: "Selected {0} items from current results",
      toast_selected_automatic: "Selected {0} automatic items",
      scan_source_time: "{0} scan",
      local_scan_results: "Local scan results",
      no_local_scan_results: "No local scan results found",
    },
  };

  function getLanguage() {
    if (typeof localStorage === "undefined") return "zh";
    return localStorage.getItem(key) === "en" ? "en" : "zh";
  }

  function setLanguage(lang) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, lang === "en" ? "en" : "zh");
    }
  }

  function t(name, ...args) {
    const lang = getLanguage();
    const dictionary = translations[lang] || translations.zh;
    const template = dictionary[name] ?? translations.zh[name] ?? name;
    if (args.length === 0) return template;
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const value = args[Number(index)];
      return value !== undefined ? String(value) : match;
    });
  }

  function renderStaticI18n(root = document) {
    const elements = root.querySelectorAll("[data-i18n]");
    elements.forEach((element) => {
      const name = element.getAttribute("data-i18n");
      if (name) element.textContent = t(name);
    });

    const titleElements = root.querySelectorAll("[data-i18n-title]");
    titleElements.forEach((element) => {
      const name = element.getAttribute("data-i18n-title");
      if (name) element.setAttribute("title", t(name));
    });

    const placeholderElements = root.querySelectorAll("[data-i18n-placeholder]");
    placeholderElements.forEach((element) => {
      const name = element.getAttribute("data-i18n-placeholder");
      if (name) element.setAttribute("placeholder", t(name));
    });

    const ariaLabelElements = root.querySelectorAll("[data-i18n-aria-label]");
    ariaLabelElements.forEach((element) => {
      const name = element.getAttribute("data-i18n-aria-label");
      if (name) element.setAttribute("aria-label", t(name));
    });

    const contentElements = root.querySelectorAll("[data-i18n-content]");
    contentElements.forEach((element) => {
      const name = element.getAttribute("data-i18n-content");
      if (name) element.setAttribute("content", t(name));
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const language = localStorage.getItem(key) === "en" ? "en" : "zh";
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";

    renderStaticI18n(document);

    const select = document.querySelector("#languageSelect");
    if (select) {
      select.value = language;
      select.addEventListener("change", () => {
        setLanguage(select.value);
        location.reload();
      });
    }

    const dialog = document.querySelector("#settingsDialog");
    const settingsButton = document.querySelector("#settingsButton");
    const settingsClose = document.querySelector("#settingsClose");
    if (dialog && settingsButton && settingsClose) {
      settingsButton.addEventListener("click", () => dialog.showModal());
      settingsClose.addEventListener("click", () => dialog.close());
    }

    window.EasyMacI18n = {
      translations,
      t,
      getLanguage,
      setLanguage,
      renderStaticI18n,
    };
    window.t = t;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      translations,
      t,
      getLanguage,
      setLanguage,
      renderStaticI18n,
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
