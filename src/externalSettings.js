/**
 * External services settings popup: provider list, provider details and source
 * selection for EEW and earthquake reports.
 */

import { AXIS_REPORT_CHANNEL } from "./constants.js";
import {
  EXTERNAL_CAPABILITY,
  getAvailableProviders,
  getExternalSourceId,
  getProvider,
  getSelectableProviders,
  getShowTestEew,
  isExternalSourceEnabled,
  parseJwtPayload,
  setShowTestEew,
} from "./externalProviders.js";
import {
  getExternalStatusLabel,
  getSourceStatus,
  reconnectProvider,
  setExternalEnabled,
  setExternalSource,
  subscribeExternalStatus,
} from "./externalServices.js";
import { clearTestEews, setEewHomeSync } from "./eew.js";

function _el(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "textContent") element.textContent = value;
    else if (key === "innerHTML") element.innerHTML = value;
    else if (key === "className") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key === "checked" || key === "disabled" || key === "value") element[key] = value;
    else if (key === "type") element.type = value;
    else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2), value);
    } else if (value != null) element.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

function _bilingual(en, ja, className = "external-description") {
  return _el("div", { className: "external-description-block" }, [
    _el("p", { className, textContent: en }),
    _el("p", { className: `${className} external-ja`, textContent: ja }),
  ]);
}

function _dotClassForStatus(status) {
  if (status === "connected") return "live";
  if (status === "connecting" || status === "upstream-disconnected") return "loading";
  if (status === "error" || status === "token-required") return "error";
  return "idle";
}

function _formatTokenExpiry(expiryMs) {
  const date = new Date(expiryMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function _getTokenClaims(provider) {
  const token = provider?.getToken?.() || "";
  if (!token) return null;
  return typeof provider.getTokenClaims === "function"
    ? provider.getTokenClaims()
    : parseJwtPayload(token);
}

function _getTokenExpiry(provider) {
  if (typeof provider?.getTokenExpiry === "function") return provider.getTokenExpiry();
  const claims = _getTokenClaims(provider);
  const exp = Number(claims?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function _renderTokenStatus(provider, container) {
  const statusEl = container.querySelector(".external-token-status");
  if (!statusEl) return;

  const token = provider?.getToken?.() || "";
  if (!token) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.classList.remove("hidden");

  const expiryEl = statusEl.querySelector(".external-token-expiry");
  const warningEl = statusEl.querySelector(".external-token-warning");

  const expiry = _getTokenExpiry(provider);
  expiryEl.classList.remove("is-expired");
  if (expiry != null && Number.isFinite(expiry)) {
    const isExpired = expiry < Date.now();
    expiryEl.textContent =
      `Expiry • 有効期限: ${_formatTokenExpiry(expiry)}` +
      (isExpired ? " (expired • 期限切れ)" : "");
    if (isExpired) expiryEl.classList.add("is-expired");
  } else {
    expiryEl.textContent =
      "Expiry • 有効期限: unknown • トークンから有効期限を読み取れませんでした";
  }

  const claims = _getTokenClaims(provider);
  const channels = Array.isArray(claims?.channels)
    ? claims.channels.map((channel) => String(channel))
    : null;
  const warnings = [];

  if (channels && getExternalSourceId(EXTERNAL_CAPABILITY.EEW) === provider.id) {
    if (!channels.includes("eew")) {
      warnings.push(
        '⚠ This token does not include the "eew" channel, which is required to receive EEWs.\n' +
          "⚠ このトークンには「eew」チャンネルが含まれていません。緊急地震速報の受信には必要です。",
      );
    }
  }

  if (channels && getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) === provider.id) {
    if (!channels.includes(AXIS_REPORT_CHANNEL)) {
      warnings.push(
        `⚠ This token does not include the "${AXIS_REPORT_CHANNEL}" channel, which is required to receive earthquake reports.\n` +
          `⚠ このトークンには「${AXIS_REPORT_CHANNEL}」チャンネルが含まれていません。地震情報の受信には必要です。`,
      );
    }
  }

  if (warnings.length > 0) {
    warningEl.textContent = warnings.join("\n");
    warningEl.classList.remove("hidden");
  } else {
    warningEl.textContent = "";
    warningEl.classList.add("hidden");
  }
}

function _makeTokenSetting(provider) {
  const input = _el("input", {
    type: "password",
    className: "search-input",
    placeholder: provider.tokenPlaceholder || "Bearer Token",
    value: provider.getToken(),
    "data-token-provider": provider.id,
  });

  const toggleButton = _el("button", {
    type: "button",
    className: "preset-action-btn external-token-toggle",
    textContent: "Show • 表示",
  });

  toggleButton.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggleButton.textContent = show ? "Hide • 隠す" : "Show • 表示";
  });

  const status = _el("div", { className: "external-token-status hidden" }, [
    _el("div", { className: "external-token-expiry" }),
    _el("div", { className: "external-token-warning hidden" }),
  ]);

  const group = _el("div", { className: "dropdown-group external-setting" }, [
    _el("label", {
      for: `external-token-${provider.id}`,
      textContent: provider.tokenLabel || `${provider.name} Token • トークン:`,
    }),
    _el("div", { className: "external-token-row" }, [input, toggleButton]),
    status,
  ]);
  input.id = `external-token-${provider.id}`;

  input.addEventListener("change", () => {
    provider.setToken(input.value.trim());
    provider.resetTokenState?.();
    _renderTokenStatus(provider, group);
    if (
      getExternalSourceId(EXTERNAL_CAPABILITY.EEW) === provider.id ||
      getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) === provider.id
    ) {
      reconnectProvider(provider.id);
    }
  });

  return group;
}

function _makePortSetting(provider) {
  const input = _el("input", {
    type: "number",
    className: "search-input",
    placeholder: provider.defaultPort || "11311",
    value: provider.getPort(),
  });
  input.id = `external-port-${provider.id}`;

  const group = _el("div", { className: "dropdown-group external-setting" }, [
    _el("label", { for: input.id, textContent: "Port Number • ポート番号:" }),
    input,
  ]);

  input.addEventListener("change", () => {
    const port = input.value.trim() || provider.defaultPort || "11311";
    input.value = port;
    provider.setPort(port);
    if (
      getExternalSourceId(EXTERNAL_CAPABILITY.EEW) === provider.id ||
      getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) === provider.id
    ) {
      reconnectProvider(provider.id);
    }
  });

  return group;
}

function _makeHomeSyncSetting(provider) {
  const toggle = _el("input", { type: "checkbox", checked: provider.getHomeSync() });
  toggle.id = `external-home-sync-${provider.id}`;

  const label = _el(
    "label",
    {
      className: "live-mode-toggle popup-setting",
      "data-tooltip":
        "Sync home location with EEW Client • ホーム場所をEEW Clientと同期する",
    },
    [
      toggle,
      _el("span", {
        className: "toggle-label",
        innerHTML: "Sync Home Location<br>ホーム場所を同期",
      }),
      _el("span", { className: "toggle-switch" }),
    ],
  );

  toggle.addEventListener("change", () => {
    setEewHomeSync(provider, toggle.checked);
  });

  return _el("div", { className: "dropdown-group external-setting" }, [label]);
}

function _renderProviderSettings(provider) {
  if (!provider.configurable) return null;
  if (!provider.requiresToken && !provider.requiresPort && !provider.supportsHomeSync) return null;

  const settings = _el("div", { className: "external-provider-settings" }, [
    _el("div", { className: "external-subheader", textContent: "Settings • 設定" }),
  ]);

  if (provider.requiresToken) settings.appendChild(_makeTokenSetting(provider));
  if (provider.requiresPort) settings.appendChild(_makePortSetting(provider));
  if (provider.supportsHomeSync) settings.appendChild(_makeHomeSyncSetting(provider));

  return settings;
}

function _renderProviderDetail(provider) {
  const container = document.getElementById("external-provider-detail");
  if (!container) return;
  container.replaceChildren();

  if (!provider) {
    container.appendChild(
      _el("p", {
        className: "external-empty",
        textContent: "Select a provider to see its details. • 配信元を選択して詳細を表示します。",
      }),
    );
    return;
  }

  container.appendChild(_el("h3", { className: "external-provider-title", textContent: provider.name }));

  const detail = provider.detail || {};

  if (detail.descriptionEn || detail.descriptionJa) {
    container.appendChild(
      _bilingual(detail.descriptionEn || "", detail.descriptionJa || ""),
    );
  }

  if (detail.docs) {
    const links = [];
    if (detail.docs.en) {
      links.push(
        _el("a", {
          href: detail.docs.en,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: "Configuration tutorial (English)",
        }),
      );
    }
    if (detail.docs.ja) {
      if (links.length > 0) links.push(document.createTextNode(" · "));
      links.push(
        _el("a", {
          href: detail.docs.ja,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: "設定チュートリアル (日本語)",
        }),
      );
    }
    container.appendChild(_el("p", { className: "external-docs" }, links));
  }

  const importantEn = Array.isArray(detail.importantEn) ? detail.importantEn : [];
  const importantJa = Array.isArray(detail.importantJa) ? detail.importantJa : [];
  if (importantEn.length > 0 || importantJa.length > 0) {
    const important = _el("div", { className: "external-important" }, [
      _el("div", { className: "external-subheader external-important-title", textContent: "Important • 重要" }),
    ]);
    const count = Math.max(importantEn.length, importantJa.length);
    for (let index = 0; index < count; index += 1) {
      if (importantEn[index]) {
        important.appendChild(_el("p", { className: "external-important-text", textContent: importantEn[index] }));
      }
      if (importantJa[index]) {
        important.appendChild(
          _el("p", {
            className: "external-important-text external-ja",
            textContent: importantJa[index],
          }),
        );
      }
    }
    container.appendChild(important);
  }

  if (Array.isArray(detail.sections)) {
    for (const section of detail.sections) {
      const title = [section.titleEn, section.titleJa].filter(Boolean).join(" • ");
      const table = _el("table", { className: "external-feature-table" });
      const tbody = _el("tbody");

      for (const row of section.rows || []) {
        const label = row.labelJa ? `${row.label} • ${row.labelJa}` : row.label;
        const value = row.valueJa ? `${row.value} • ${row.valueJa}` : row.value;
        tbody.appendChild(
          _el("tr", {}, [
            _el("th", { scope: "row", textContent: label }),
            _el("td", { textContent: value }),
          ]),
        );
      }

      table.appendChild(tbody);
      container.appendChild(
        _el("div", { className: "external-feature-section" }, [
          _el("div", { className: "external-subheader", textContent: title }),
          table,
        ]),
      );
    }
  }

  if (Array.isArray(detail.footnotes) && detail.footnotes.length > 0) {
    const footnotes = _el("div", { className: "external-footnotes" });
    for (const footnote of detail.footnotes) {
      footnotes.appendChild(
        _el("p", { className: "external-footnote" }, [
          _el("span", { className: "external-footnote-marker", textContent: `${footnote.marker} ` }),
          _el("span", { textContent: footnote.en }),
          _el("br"),
          _el("span", { className: "external-ja", textContent: footnote.ja }),
        ]),
      );
    }
    container.appendChild(footnotes);
  }

  const settings = _renderProviderSettings(provider);
  if (settings) {
    container.appendChild(settings);
    if (provider.requiresToken) _renderTokenStatus(provider, container);
  }
}

let _selectedProviderId = null;

function _getListableProviders() {
  return getAvailableProviders();
}

function _renderProviderList() {
  const list = document.getElementById("external-provider-list");
  if (!list) return;

  const providers = _getListableProviders();
  if (!providers.some((provider) => provider.id === _selectedProviderId)) {
    _selectedProviderId = providers[0]?.id || null;
  }

  list.replaceChildren();
  for (const provider of providers) {
    const button = _el("button", {
      type: "button",
      className: "external-provider-item",
      textContent: provider.name,
      dataset: { providerId: provider.id },
    });
    button.classList.toggle("active", provider.id === _selectedProviderId);
    button.addEventListener("click", () => {
      _selectedProviderId = provider.id;
      _renderProviderList();
      _renderProviderDetail(getProvider(provider.id));
    });
    list.appendChild(button);
  }
}

function _renderSourceStatus(capability) {
  const container = document.getElementById(
    capability === EXTERNAL_CAPABILITY.EEW
      ? "external-eew-status"
      : "external-reports-status",
  );
  if (!container) return;

  const provider = getProvider(getExternalSourceId(capability));
  if (!provider) {
    container.classList.add("hidden");
    container.replaceChildren();
    return;
  }

  const status = getSourceStatus(capability);
  container.classList.remove("hidden");
  container.replaceChildren();

  const dot = _el("span", { className: `dot-${_dotClassForStatus(status)}` });
  const text = _el("span", { textContent: getExternalStatusLabel(status) });
  container.appendChild(dot);
  container.appendChild(text);

  container.title = `${provider.name}: ${getExternalStatusLabel(status)}`;
  container.onclick = () => {
    if (isExternalSourceEnabled(capability)) reconnectProvider(provider.id);
  };
}

function _populateSourceSelect(capability) {
  const select = document.getElementById(
    capability === EXTERNAL_CAPABILITY.EEW
      ? "external-eew-source-select"
      : "external-reports-source-select",
  );
  if (!select) return;

  const current = getExternalSourceId(capability);
  select.replaceChildren();
  select.appendChild(_el("option", { value: "", textContent: "None • なし" }));

  for (const provider of getSelectableProviders(capability)) {
    select.appendChild(_el("option", { value: provider.id, textContent: provider.name }));
  }

  select.value = current && select.querySelector(`option[value="${current}"]`) ? current : "";
}

function _renderSourceControls() {
  for (const capability of [EXTERNAL_CAPABILITY.EEW, EXTERNAL_CAPABILITY.REPORTS]) {
    _populateSourceSelect(capability);

    const hasSource = Boolean(getExternalSourceId(capability));
    const toggle = document.getElementById(
      capability === EXTERNAL_CAPABILITY.EEW
        ? "external-eew-enabled-toggle"
        : "external-reports-enabled-toggle",
    );
    if (toggle) {
      toggle.disabled = !hasSource;
      toggle.checked = hasSource && isExternalSourceEnabled(capability);
    }

    _renderSourceStatus(capability);
  }

  const testToggle = document.getElementById("external-show-test-toggle");
  if (testToggle) testToggle.checked = getShowTestEew();
}

function _renderAll() {
  _renderProviderList();
  _renderSourceControls();
  _renderProviderDetail(getProvider(_selectedProviderId));
}

function _refreshCurrentTokenStatus() {
  const container = document.getElementById("external-provider-detail");
  if (!container) return;
  const provider = getProvider(_selectedProviderId);
  if (provider?.requiresToken) _renderTokenStatus(provider, container);
}

/**
 * Wires the External Services button in Settings to the external services popup.
 */
export function initExternalSettings() {
  const openBtn = document.getElementById("external-open-btn");
  const popup = document.getElementById("external-popup");
  if (!openBtn || !popup) return;

  const closeBtn = popup.querySelector("#external-close-btn");
  const eewSelect = popup.querySelector("#external-eew-source-select");
  const reportsSelect = popup.querySelector("#external-reports-source-select");
  const eewToggle = popup.querySelector("#external-eew-enabled-toggle");
  const reportsToggle = popup.querySelector("#external-reports-enabled-toggle");
  const testToggle = popup.querySelector("#external-show-test-toggle");

  eewSelect?.addEventListener("change", () => {
    setExternalSource(EXTERNAL_CAPABILITY.EEW, eewSelect.value);
    if (eewSelect.value) _selectedProviderId = eewSelect.value;
    _renderProviderList();
    _renderSourceControls();
    _renderProviderDetail(getProvider(_selectedProviderId));
  });

  reportsSelect?.addEventListener("change", () => {
    setExternalSource(EXTERNAL_CAPABILITY.REPORTS, reportsSelect.value);
    if (reportsSelect.value) _selectedProviderId = reportsSelect.value;
    _renderProviderList();
    _renderSourceControls();
    _renderProviderDetail(getProvider(_selectedProviderId));
  });

  eewToggle?.addEventListener("change", () => {
    if (!setExternalEnabled(EXTERNAL_CAPABILITY.EEW, eewToggle.checked)) {
      eewToggle.checked = false;
    }
    _renderSourceControls();
  });

  reportsToggle?.addEventListener("change", () => {
    if (!setExternalEnabled(EXTERNAL_CAPABILITY.REPORTS, reportsToggle.checked)) {
      reportsToggle.checked = false;
    }
    _renderSourceControls();
  });

  testToggle?.addEventListener("change", () => {
    setShowTestEew(testToggle.checked);
    if (!testToggle.checked) clearTestEews();
  });

  const render = () => {
    if (!_selectedProviderId) {
      _selectedProviderId =
        getExternalSourceId(EXTERNAL_CAPABILITY.EEW) ||
        getAvailableProviders()[0]?.id ||
        null;
    }
    _renderAll();
  };

  openBtn.addEventListener("click", () => {
    popup.classList.remove("hidden");
    render();
  });

  closeBtn?.addEventListener("click", () => {
    popup.classList.add("hidden");
  });

  popup.addEventListener("click", (event) => {
    if (event.target === popup) popup.classList.add("hidden");
  });

  subscribeExternalStatus(() => {
    if (popup.classList.contains("hidden")) return;
    const previousSelected = _selectedProviderId;
    _renderProviderList();
    if (_selectedProviderId !== previousSelected) {
      _renderProviderDetail(getProvider(_selectedProviderId));
    }
    _renderSourceControls();
    _refreshCurrentTokenStatus();
  });
}
