/**
 * External services manager.
 *
 * Owns the connections to external data providers. A provider is connected at
 * most once, even when it is selected as both the EEW and the reports source.
 * Each provider connection is independent: a failure in one never disconnects
 * another.
 */

import {
  EXTERNAL_CAPABILITY,
  getExternalSourceId,
  getExternalSourceProvider,
  getProvider,
  isExternalSourceEnabled,
  migrateExternalServiceSettings,
  setExternalSourceEnabled,
  setExternalSourceId,
} from "./externalProviders.js";
import { DEBUG_SETTINGS_CHANGED_EVENT } from "./debugOptions.js";
import {
  applyEewClientUserPoint,
  clearEewState,
  handleEewMessage,
  initEewRuntime,
  onEewSourceChanged,
} from "./eew.js";
import { loadEewDependencies } from "./eew/physics.js";
import { ingestAxisMessage, ingestTelegramMessage } from "./liveMode.js";

const CAPABILITIES = [EXTERNAL_CAPABILITY.EEW, EXTERNAL_CAPABILITY.REPORTS];

/**
 * providerId -> {
 *   provider: BaseExternalProvider,
 *   capabilities: Set<string>,
 *   status: string,
 *   started: boolean,
 *   session: number,
 * }
 */
const connections = new Map();
const statusListeners = new Set();

const STATUS_LABELS = {
  none: "None • なし",
  disconnected: "Disconnected • 未接続",
  connecting: "Connecting • 接続中",
  connected: "Connected • 接続済み",
  "upstream-disconnected": "Upstream disconnected • 上流切断",
  "token-required": "Token required • トークンが必要",
  error: "Error • エラー",
};

export function getExternalStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function subscribeExternalStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function _notifyStatusListeners() {
  renderTopbarExternalStatus();
  for (const listener of statusListeners) {
    try {
      listener();
    } catch (err) {
      console.warn("[external] Status listener failed:", err);
    }
  }
}

/** Connection status for a provider, or "disconnected" when it has none. */
export function getProviderConnectionStatus(providerId) {
  return connections.get(providerId)?.status || "disconnected";
}

/** Status of the connection serving a capability. */
export function getSourceStatus(capability) {
  const provider = getExternalSourceProvider(capability);
  if (!provider) return "none";
  if (!isExternalSourceEnabled(capability)) return "disconnected";
  if (provider.requiresToken && !provider.getToken()) return "token-required";
  return getProviderConnectionStatus(provider.id);
}

/** Re-reads stored selections and reconciles connections with them. */
export function refreshExternalConnections() {
  migrateExternalServiceSettings();
  _sanitizeSelections();

  const desired = new Map();
  for (const capability of CAPABILITIES) {
    if (!isExternalSourceEnabled(capability)) continue;
    const provider = getExternalSourceProvider(capability);
    if (!provider) continue;

    let entry = desired.get(provider.id);
    if (!entry) {
      entry = { provider, capabilities: new Set() };
      desired.set(provider.id, entry);
    }
    entry.capabilities.add(capability);
  }

  for (const [providerId, record] of Array.from(connections.entries())) {
    if (!desired.has(providerId)) {
      _disconnectProvider(record);
      connections.delete(providerId);
    }
  }

  for (const [providerId, entry] of desired.entries()) {
    const record = connections.get(providerId);
    if (record) {
      record.capabilities = entry.capabilities;
      if (!record.started) {
        _startProvider(entry.provider, entry.capabilities);
      }
    } else {
      _startProvider(entry.provider, entry.capabilities);
    }
  }

  _notifyStatusListeners();
}

/** Selects the provider for a capability. An empty id means "none". */
export function setExternalSource(capability, providerId) {
  let nextId = providerId || "";
  if (nextId) {
    const provider = getProvider(nextId);
    if (
      !provider ||
      !provider.selectable ||
      !provider.isAvailable() ||
      !provider.supports(capability)
    ) {
      nextId = "";
    }
  }

  const previousProvider = getExternalSourceProvider(capability);
  setExternalSourceId(capability, nextId);

  if (!nextId) {
    setExternalSourceEnabled(capability, false);
  }

  refreshExternalConnections();

  if (capability === EXTERNAL_CAPABILITY.EEW) {
    const nextProvider = getExternalSourceProvider(capability);
    if (previousProvider !== nextProvider) {
      clearEewState();
      onEewSourceChanged(nextProvider);
    }
  }
}

/**
 * Enables or disables the connection for a capability. Returns false when the
 * provider cannot be used (for example a token is missing).
 */
export function setExternalEnabled(capability, enabled) {
  const provider = getExternalSourceProvider(capability);
  if (enabled) {
    if (!provider) return false;
    if (provider.requiresToken && !provider.getToken()) {
      alert(
        `Please enter a token for ${provider.name} in Settings before connecting.\n接続する前に、「設定」で${provider.name}のトークンを入力してください。`,
      );
      return false;
    }
  }

  setExternalSourceEnabled(capability, enabled);
  if (capability === EXTERNAL_CAPABILITY.EEW && !enabled) {
    clearEewState();
  }
  refreshExternalConnections();
  return true;
}

/** Reconnects a provider after a manual retry or a settings change. */
export function reconnectProvider(providerId) {
  const record = connections.get(providerId);
  if (!record) {
    refreshExternalConnections();
    return;
  }

  record.started = false;
  record.session++;
  try {
    record.provider.disconnect();
  } catch (err) {
    console.warn("[external] Provider disconnect failed:", err);
  }
  record.status = "disconnected";
  refreshExternalConnections();
}

/**
 * Providers currently in use: selected for an enabled source and available.
 * @returns {Array<{provider: Object, status: string}>}
 */
export function getActiveExternalProviders() {
  const result = new Map();
  for (const capability of CAPABILITIES) {
    if (!isExternalSourceEnabled(capability)) continue;
    const provider = getExternalSourceProvider(capability);
    if (!provider || result.has(provider.id)) continue;
    result.set(provider.id, {
      provider,
      status: getSourceStatus(capability),
    });
  }
  return Array.from(result.values());
}

/** Renders the top-bar dots for providers that are in use. */
export function renderTopbarExternalStatus() {
  const container = document.getElementById("external-status-list");
  if (!container) return;

  const active = getActiveExternalProviders();
  container.replaceChildren();

  if (active.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  for (const { provider, status } of active) {
    const item = document.createElement("span");
    item.className = "external-status-item";
    item.title = `${provider.name}: ${getExternalStatusLabel(status)}`;

    const dot = document.createElement("span");
    dot.className = `dot-${_dotClassForStatus(status)}`;
    item.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = provider.name;
    item.appendChild(label);

    container.appendChild(item);
  }
}

function _dotClassForStatus(status) {
  if (status === "connected") return "live";
  if (status === "connecting" || status === "upstream-disconnected") return "loading";
  if (status === "error" || status === "token-required") return "error";
  return "idle";
}

function _sanitizeSelections() {
  for (const capability of CAPABILITIES) {
    const providerId = getExternalSourceId(capability);
    if (!providerId) continue;

    const provider = getProvider(providerId);
    if (
      !provider ||
      !provider.selectable ||
      !provider.isAvailable() ||
      !provider.supports(capability)
    ) {
      setExternalSourceId(capability, "");
      setExternalSourceEnabled(capability, false);
      if (capability === EXTERNAL_CAPABILITY.EEW) clearEewState();
    }
  }
}

function _startProvider(provider, capabilities) {
  let record = connections.get(provider.id);
  if (!record) {
    record = {
      provider,
      capabilities: new Set(capabilities),
      status: "disconnected",
      started: false,
      session: 0,
    };
    connections.set(provider.id, record);
  }
  record.provider = provider;
  record.capabilities = new Set(capabilities);

  if (record.started) return;
  if (provider.requiresToken && !provider.getToken()) {
    record.status = "token-required";
    return;
  }

  record.started = true;
  record.status = "connecting";
  const session = ++record.session;
  _notifyStatusListeners();

  _connectProvider(provider, record, session).catch((err) => {
    console.warn(`[external][${provider.name}] Connection failed:`, err);
    if (record.session === session) {
      record.status = "error";
      record.started = false;
      _notifyStatusListeners();
    }
  });
}

async function _connectProvider(provider, record, session) {
  if (record.capabilities.has(EXTERNAL_CAPABILITY.EEW)) {
    await loadEewDependencies();
  }

  // The selection changed while dependencies were loading.
  if (record.session !== session || !record.started) return;

  await provider.connect({
    onStatusChange: (status) => {
      if (record.session !== session) return;
      record.status = status;
      _notifyStatusListeners();
    },
    onMessage: (message) => {
      if (!record.capabilities.has(EXTERNAL_CAPABILITY.EEW)) return;
      if (!isExternalSourceEnabled(EXTERNAL_CAPABILITY.EEW)) return;
      if (getExternalSourceId(EXTERNAL_CAPABILITY.EEW) !== provider.id) return;
      handleEewMessage(message, provider);
    },
    onSeismologyMessage: (message) => {
      if (!record.capabilities.has(EXTERNAL_CAPABILITY.REPORTS)) return;
      if (!isExternalSourceEnabled(EXTERNAL_CAPABILITY.REPORTS)) return;
      if (getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) !== provider.id) return;
      ingestAxisMessage(message);
    },
    onReportMessage: (message) => {
      if (!record.capabilities.has(EXTERNAL_CAPABILITY.REPORTS)) return;
      if (!isExternalSourceEnabled(EXTERNAL_CAPABILITY.REPORTS)) return;
      if (getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) !== provider.id) return;
      ingestTelegramMessage(message).catch((err) => {
        console.warn("[external] Telegram ingestion failed:", err);
      });
    },
    onUserPoint: async (location) => {
      if (!provider.supportsHomeSync || !provider.getHomeSync()) return;
      if (!isExternalSourceEnabled(EXTERNAL_CAPABILITY.EEW)) return;
      if (getExternalSourceId(EXTERNAL_CAPABILITY.EEW) !== provider.id) return;
      await applyEewClientUserPoint(location);
    },
    onAuthError: (message) => {
      if (record.session !== session) return;
      record.status = "error";
      _notifyStatusListeners();
      alert(message);
    },
    onTokenUpdated: (token) => {
      if (!provider.requiresToken) return;
      const input = document.querySelector(
        `#external-provider-detail input[data-token-provider="${provider.id}"]`,
      );
      if (input) input.value = token;
      _notifyStatusListeners();
    },
  });
}

function _disconnectProvider(record) {
  record.started = false;
  record.session++;
  try {
    record.provider.disconnect();
  } catch (err) {
    console.warn("[external] Provider disconnect failed:", err);
  }
}

/**
 * Initializes the EEW runtime and starts the saved external connections.
 */
export function initExternalServices(map, bounds, cities, areas) {
  migrateExternalServiceSettings();
  initEewRuntime(map, bounds, cities, areas);

  if (typeof window !== "undefined") {
    window.addEventListener(DEBUG_SETTINGS_CHANGED_EVENT, (event) => {
      if (event.detail?.name !== "useTestServer") return;
      refreshExternalConnections();
      _notifyStatusListeners();
    });
  }

  refreshExternalConnections();
}
