(function () {
  "use strict";

  const FILTERS = [
    {
      id: "all",
      labelKey: "filter_all",
      icon: "apps",
      predicate: () => true,
    },
    {
      id: "automatic",
      labelKey: "filter_automatic",
      icon: "wand",
      predicate: EasyMacCore.isAutomatic,
    },
    {
      id: "cask",
      labelKey: "filter_cask",
      icon: "package",
      predicate: (item) => item.kind === "cask",
    },
    {
      id: "mas",
      labelKey: "filter_mas",
      icon: "store",
      predicate: (item) => item.kind === "mas",
    },
    {
      id: "formula",
      labelKey: "filter_formula",
      icon: "terminal",
      predicate: (item) => item.kind === "formula",
    },
    {
      id: "pwa",
      labelKey: "filter_pwa",
      icon: "globe",
      predicate: (item) => item.kind === "pwa",
    },
    {
      id: "manual",
      labelKey: "filter_manual",
      icon: "hand",
      predicate: (item) => item.kind === "manual",
    },
  ];

  function kindLabel(kind) {
    switch (kind) {
      case "homebrew":
        return "Homebrew";
      case "cask":
        return "Homebrew Cask";
      case "formula":
        return window.t("kind_formula");
      case "mas":
        return "App Store";
      case "pwa":
        return window.t("kind_pwa");
      case "manual":
        return window.t("kind_manual");
      default:
        return kind;
    }
  }

  const state = {
    items: [],
    selected: new Set(),
    filter: "all",
    query: "",
    script: "",
  };

  const elements = {
    workspace: document.querySelector("#workspace"),
    scanStatus: document.querySelector("#scanStatus"),
    loadError: document.querySelector("#loadError"),
    scanSource: document.querySelector("#scanSource"),
    scanCount: document.querySelector("#scanCount"),
    filterNav: document.querySelector("#filterNav"),
    searchInput: document.querySelector("#searchInput"),
    selectVisibleButton: document.querySelector("#selectVisibleButton"),
    clearSelectionButton: document.querySelector("#clearSelectionButton"),
    selectAutomaticButton: document.querySelector("#selectAutomaticButton"),
    libraryTitle: document.querySelector("#libraryTitle"),
    resultSummary: document.querySelector("#resultSummary"),
    appList: document.querySelector("#appList"),
    emptyState: document.querySelector("#emptyState"),
    selectedSummary: document.querySelector("#selectedSummary"),
    selectionCount: document.querySelector("#selectionCount"),
    automaticCount: document.querySelector("#automaticCount"),
    pwaCount: document.querySelector("#pwaCount"),
    manualCount: document.querySelector("#manualCount"),
    dependencyStatus: document.querySelector("#dependencyStatus"),
    scriptPreview: document.querySelector("#scriptPreview"),
    downloadButton: document.querySelector("#downloadButton"),
    toast: document.querySelector("#toast"),
  };

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function normalize(value) {
    return value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-Hans-CN")
      .replace(/\s+/g, " ")
      .trim();
  }

  function visibleItems() {
    const activeFilter =
      FILTERS.find((filter) => filter.id === state.filter) || FILTERS[0];
    const query = normalize(state.query);

    return state.items.filter((item) => {
      if (!activeFilter.predicate(item)) return false;
      if (!query) return true;

      return normalize(
        [item.name, item.version, item.bundleId, item.installId, item.path].join(
          " ",
        ),
      ).includes(query);
    });
  }

  function selectedItems() {
    return state.items.filter((item) => state.selected.has(item.id));
  }

  function itemDetail(item) {
    if (item.kind === "manual") {
      return item.bundleId || item.path || window.t("unknown_install_source");
    }
    if (item.kind === "mas") {
      return `App Store ID ${item.installId}`;
    }
    if (item.kind === "pwa") {
      const browser = item.bundleId.startsWith("com.google.Chrome.app.")
        ? "Chrome"
        : item.bundleId.startsWith("com.microsoft.edgemac.app.")
          ? "Edge"
          : window.t("browser");
      return `${browser} · ${item.installId}`;
    }
    if (item.kind === "homebrew") {
      return window.t("homebrew_dep_detail");
    }
    return item.installId;
  }

  function renderFilters() {
    elements.filterNav.replaceChildren();

    FILTERS.forEach((filter) => {
      const count = state.items.filter(filter.predicate).length;
      const button = document.createElement("button");
      button.className = `filter-button${state.filter === filter.id ? " active" : ""}`;
      button.type = "button";
      button.dataset.filter = filter.id;
      button.setAttribute(
        "aria-current",
        state.filter === filter.id ? "page" : "false",
      );

      const label = document.createElement("span");
      label.textContent = window.t(filter.labelKey);
      const output = document.createElement("output");
      output.textContent = String(count);

      button.append(icon(filter.icon), label, output);
      elements.filterNav.append(button);
    });
  }

  function renderList() {
    const items = visibleItems();
    const filter = FILTERS.find((entry) => entry.id === state.filter);
    elements.libraryTitle.textContent = filter ? window.t(filter.labelKey) : window.t("filter_all");
    elements.resultSummary.textContent = window.t("result_summary", items.length);
    elements.appList.replaceChildren();
    elements.appList.hidden = items.length === 0;
    elements.emptyState.hidden = items.length !== 0;

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const row = document.createElement("label");
      row.className = `app-row${state.selected.has(item.id) ? " selected" : ""}`;
      row.dataset.id = item.id;
      row.setAttribute("role", "listitem");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(item.id);
      checkbox.setAttribute("aria-label", window.t("select_item_aria", item.name));

      const main = document.createElement("div");
      main.className = "app-main";
      const nameLine = document.createElement("div");
      nameLine.className = "app-name-line";
      const name = document.createElement("span");
      name.className = "app-name";
      name.textContent = item.name;
      name.title = item.name;
      nameLine.append(name);

      if (item.version) {
        const version = document.createElement("span");
        version.className = "version";
        version.textContent = item.version;
        nameLine.append(version);
      }

      const detail = document.createElement("span");
      detail.className = "app-detail";
      detail.textContent = itemDetail(item);
      detail.title = detail.textContent;
      main.append(nameLine, detail);

      const badge = document.createElement("span");
      badge.className = [
        "kind-badge",
        EasyMacCore.isAutomatic(item) ? "automatic" : "",
        item.kind === "pwa" ? "pwa" : "",
      ]
        .filter(Boolean)
        .join(" ");
      badge.textContent = kindLabel(item.kind);

      row.append(checkbox, main, badge);
      fragment.append(row);
    });
    elements.appList.append(fragment);
  }

  function renderPlan() {
    const items = selectedItems();
    const summary = EasyMacCore.summarize(items);
    state.script = EasyMacCore.generateInstallScript(items);

    elements.selectionCount.textContent = String(summary.total);
    elements.automaticCount.textContent = String(summary.automatic);
    elements.pwaCount.textContent = String(summary.pwa);
    elements.manualCount.textContent = String(summary.manual);
    elements.selectedSummary.textContent =
      summary.total === 0 ? window.t("no_items_selected") : window.t("selected_summary", summary.total);
    elements.downloadButton.disabled = summary.total === 0;
    elements.scriptPreview.textContent =
      summary.total === 0
        ? window.t("script_preview_empty")
        : state.script;

    elements.dependencyStatus.classList.toggle(
      "required",
      summary.homebrew,
    );
    const statusTitle = elements.dependencyStatus.querySelector("strong");
    const statusDescription = elements.dependencyStatus.querySelector("span");
    if (summary.homebrew) {
      statusTitle.textContent = window.t("homebrew_required");
      statusDescription.textContent =
        summary.appStore > 0
          ? window.t("homebrew_mas_desc")
          : window.t("homebrew_desc");
    } else {
      statusTitle.textContent = window.t("homebrew_not_needed");
      if (summary.pwa > 0 && summary.manual > 0) {
        statusDescription.textContent = window.t("homebrew_pwa_manual_desc");
      } else if (summary.pwa > 0) {
        statusDescription.textContent = window.t("homebrew_pwa_desc");
      } else if (summary.manual > 0) {
        statusDescription.textContent = window.t("homebrew_manual_desc");
      } else {
        statusDescription.textContent = window.t("homebrew_not_needed_desc");
      }
    }
  }

  function renderSelectionControls() {
    elements.clearSelectionButton.disabled = state.selected.size === 0;
    elements.selectAutomaticButton.disabled =
      state.items.filter(EasyMacCore.isAutomatic).length === 0;
  }

  function render() {
    renderFilters();
    renderList();
    renderPlan();
    renderSelectionControls();
  }

  function toggleSelection(id, checked) {
    if (checked) {
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    renderList();
    renderPlan();
    renderSelectionControls();
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      elements.toast.classList.remove("visible");
    }, 2400);
  }

  function downloadScript() {
    const items = selectedItems();
    if (items.length === 0) return;

    const zipBytes = EasyMacCore.createExecutableZip(
      "EasyMac-Migration.command",
      state.script,
    );
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    anchor.href = url;
    anchor.download = `EasyMac-Migration-${date}.zip`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(window.t("migration_script_downloaded"));
  }

  function bindEvents() {
    elements.filterNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      renderFilters();
      renderList();
    });

    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value;
      renderList();
    });

    elements.appList.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      const row = checkbox?.closest("[data-id]");
      if (!checkbox || !row) return;
      toggleSelection(row.dataset.id, checkbox.checked);
    });

    elements.selectVisibleButton.addEventListener("click", () => {
      const items = visibleItems();
      items.forEach((item) => state.selected.add(item.id));
      render();
      showToast(window.t("toast_selected_visible", items.length));
    });

    elements.clearSelectionButton.addEventListener("click", () => {
      state.selected.clear();
      render();
    });

    elements.selectAutomaticButton.addEventListener("click", () => {
      const items = state.items.filter(EasyMacCore.isAutomatic);
      items.forEach((item) => state.selected.add(item.id));
      render();
      showToast(window.t("toast_selected_automatic", items.length));
    });

    elements.downloadButton.addEventListener("click", downloadScript);
  }

  function formatScanSource(scan) {
    const date = new Date(scan.scannedAt);
    const locale = window.EasyMacI18n?.getLanguage?.() === "en" ? "en-US" : "zh-CN";
    const time = Number.isNaN(date.getTime())
      ? ""
      : new Intl.DateTimeFormat(locale, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);

    return [scan.computerName, time ? window.t("scan_source_time", time) : ""]
      .filter(Boolean)
      .join(" · ");
  }

  function initialize() {
    try {
      const scan = EasyMacCore.decodeScanPayload(
        window.EASYMAC_SCAN || window.EASYNEWMAC_SCAN,
      );
      state.items = scan.items.sort((left, right) => {
        const order = ["homebrew", "cask", "mas", "formula", "pwa", "manual"];
        const kindDifference =
          order.indexOf(left.kind) - order.indexOf(right.kind);
        return (
          kindDifference ||
          left.name.localeCompare(right.name, "zh-Hans-CN", {
            sensitivity: "base",
            numeric: true,
          })
        );
      });
      elements.scanSource.textContent =
        formatScanSource(scan) || window.t("local_scan_results");
      elements.scanCount.textContent = String(state.items.length);
      elements.workspace.hidden = false;
      elements.scanStatus.hidden = true;
      elements.loadError.hidden = true;
      bindEvents();
      render();
    } catch (error) {
      console.error(error);
      elements.scanSource.textContent = window.t("no_local_scan_results");
      elements.workspace.hidden = true;
      elements.scanStatus.hidden = true;
      elements.loadError.hidden = false;
    }
  }

  function loadScanData() {
    delete window.EASYMAC_PENDING;
    delete window.EASYNEWMAC_PENDING;
    delete window.EASYMAC_SCAN;
    delete window.EASYNEWMAC_SCAN;

    const script = document.createElement("script");
    script.src = `data.js?${Date.now()}`;
    script.addEventListener("load", () => {
      script.remove();
      if (window.EASYMAC_PENDING || window.EASYNEWMAC_PENDING) {
        window.setTimeout(loadScanData, 800);
        return;
      }
      initialize();
    });
    script.addEventListener("error", () => {
      script.remove();
      initialize();
    });
    document.body.append(script);
  }

  loadScanData();
})();
