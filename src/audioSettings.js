/**
 * Audio settings popup: event sound assignment and audio source management.
 */

import {
  AUDIO_EVENT_DEFS,
  getAudioSources,
  getAudioEventSettings,
  updateAudioEventSetting,
  getEewPlayLowAccuracy,
  setEewPlayLowAccuracy,
  renameAudioSource,
  deleteAudioSource,
  createUploadedAudioSource,
  createLocalAudioSource,
  createRemoteAudioSource,
  listLocalAudioFiles,
  testAudioSource,
} from "./audio.js";
import { checkIsDesktop, desktopGetAudioDirPath } from "./desktopBridge.js";

const SOURCE_TYPE_LABELS = {
  builtin: "Built-in · 内蔵",
  upload: "Upload · アップロード",
  local: "Local · ローカル",
  remote: "Remote · リモート",
};

let _localFiles = [];

function _el(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "textContent") element.textContent = value;
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

function _sourceOptionLabel(source) {
  return `${source.name} · ${SOURCE_TYPE_LABELS[source.type] || source.type}`;
}

function _sourceRefLabel(source) {
  if (source.type === "remote") return source.url || "(no URL)";
  if (source.type === "local" || source.type === "upload") return source.fileName || "(no file)";
  return source.url || "";
}

function _makeSourceSelect(eventId, field, currentValue, sources) {
  const select = _el("select", {
    className: "audio-event-select",
    "aria-label": `${eventId} ${field}`,
    dataset: { eventId, field },
  });

  select.appendChild(_el("option", { value: "", textContent: "None · なし" }));
  for (const source of sources) {
    select.appendChild(
      _el("option", {
        value: source.id,
        textContent: _sourceOptionLabel(source),
      }),
    );
  }

  if (currentValue && sources.some((source) => source.id === currentValue)) {
    select.value = currentValue;
  } else {
    select.value = "";
  }
  return select;
}

function _renderEventList(container) {
  const settings = getAudioEventSettings();
  const sources = getAudioSources();
  container.replaceChildren();

  for (const def of AUDIO_EVENT_DEFS) {
    const current = settings.events[def.id] || { sourceId: null, updateSourceId: null };
    const block = _el("div", { className: "audio-event-block" });

    const row = _el("div", { className: "audio-event-row" }, [
      _el("span", { className: "audio-event-label", textContent: def.label }),
      _makeSourceSelect(def.id, "sourceId", current.sourceId, sources),
    ]);
    block.appendChild(row);

    if (def.hasUpdate) {
      const updateRow = _el("div", { className: "audio-event-row audio-event-update-row" }, [
        _el("span", {
          className: "audio-event-label",
          textContent: "↳ Update · 同一イベントの更新時",
        }),
        _makeSourceSelect(def.id, "updateSourceId", current.updateSourceId, sources),
      ]);
      block.appendChild(updateRow);
    }

    container.appendChild(block);
  }
}

function _makeActionButton(label, action, sourceId) {
  return _el("button", {
    type: "button",
    className: "preset-action-btn audio-source-action",
    textContent: label,
    dataset: { action, sourceId },
  });
}

function _renderSourceList(container) {
  const sources = getAudioSources();
  container.replaceChildren();

  for (const source of sources) {
    const nameInput = _el("input", {
      type: "text",
      className: "search-input audio-source-name",
      value: source.name,
      "aria-label": `Audio source name ${source.name}`,
      dataset: { sourceId: source.id },
    });

    const details = _el("span", {
      className: "audio-source-details",
      textContent: `${SOURCE_TYPE_LABELS[source.type] || source.type} · ${_sourceRefLabel(source)}`,
    });

    const actions = _el("div", { className: "audio-source-actions" }, [
      _makeActionButton("Test", "test", source.id),
      _makeActionButton(source.builtin ? "Locked" : "Delete", "delete", source.id),
    ]);
    if (source.builtin) actions.lastChild.disabled = true;

    container.appendChild(
      _el("div", { className: "audio-source-row", dataset: { sourceId: source.id } }, [
        _el("div", { className: "audio-source-main" }, [nameInput, details]),
        actions,
      ]),
    );
  }
}

async function _renderFolderPath() {
  const pathElement = document.getElementById("audio-folder-path");
  if (!pathElement) return;

  if (!checkIsDesktop()) {
    pathElement.textContent = "";
    pathElement.classList.add("hidden");
    return;
  }

  try {
    const audioDir = await desktopGetAudioDirPath();
    pathElement.textContent = audioDir || "";
    pathElement.classList.toggle("hidden", !audioDir);
  } catch {
    pathElement.textContent = "";
    pathElement.classList.add("hidden");
  }
}

function _updateAddFormVisibility(popup) {
  const type = popup.querySelector("#audio-add-type").value;
  popup.querySelector("#audio-add-upload").classList.toggle("hidden", type !== "upload");
  popup.querySelector("#audio-add-local").classList.toggle("hidden", type !== "local");
  popup.querySelector("#audio-add-remote").classList.toggle("hidden", type !== "remote");
}

function _configureAddTypeOptions(popup) {
  const select = popup.querySelector("#audio-add-type");
  const types = checkIsDesktop()
    ? [
        ["local", "Local file (desktop) · ローカルファイル"],
        ["remote", "Remote URL · リモートURL"],
      ]
    : [
        ["upload", "File upload (web) · ファイルアップロード"],
        ["remote", "Remote URL · リモートURL"],
      ];

  select.replaceChildren();
  for (const [value, label] of types) {
    select.appendChild(_el("option", { value, textContent: label }));
  }
  _updateAddFormVisibility(popup);
}

async function _refreshLocalFiles(popup) {
  const select = popup.querySelector("#audio-add-local-select");
  select.replaceChildren(_el("option", { value: "", textContent: "Loading…" }));
  select.disabled = true;

  _localFiles = await listLocalAudioFiles();

  select.replaceChildren();
  if (_localFiles.length === 0) {
    select.appendChild(
      _el("option", {
        value: "",
        textContent: "No playable files in the audio/ folder",
      }),
    );
    select.disabled = true;
    return;
  }

  for (const fileName of _localFiles) {
    select.appendChild(_el("option", { value: fileName, textContent: fileName }));
  }
  select.disabled = false;
}

function _setStatus(popup, message, isError = false) {
  const status = popup.querySelector("#audio-add-status");
  status.textContent = message;
  status.classList.toggle("is-error", Boolean(isError));
}

async function _handleAddSource(popup) {
  const addBtn = popup.querySelector("#audio-add-btn");
  const type = popup.querySelector("#audio-add-type").value;
  const name = popup.querySelector("#audio-add-name").value.trim();

  addBtn.disabled = true;
  _setStatus(popup, "Adding… · 追加中…");

  try {
    let source;
    if (type === "upload") {
      const fileInput = popup.querySelector("#audio-add-upload-input");
      const file = fileInput.files?.[0];
      if (!file) throw new Error("Please choose an audio file.");
      source = await createUploadedAudioSource(file, name);
      fileInput.value = "";
    } else if (type === "local") {
      const fileName = popup.querySelector("#audio-add-local-select").value;
      if (!fileName) throw new Error("Please choose a file from the audio/ folder.");
      source = createLocalAudioSource(fileName, name);
    } else {
      const url = popup.querySelector("#audio-add-url").value.trim();
      if (!url) throw new Error("Please enter an audio URL.");
      source = createRemoteAudioSource(url, name);
    }

    popup.querySelector("#audio-add-name").value = "";
    popup.querySelector("#audio-add-url").value = "";
    _setStatus(popup, `Added "${source.name}" · 追加しました`);

    _renderSourceList(popup.querySelector("#audio-source-list"));
    _renderEventList(popup.querySelector("#audio-event-list"));
  } catch (err) {
    _setStatus(popup, err.message || String(err), true);
    alert(`Failed to add audio source.\n\n${err.message || err}`);
  } finally {
    addBtn.disabled = false;
  }
}

async function _handleSourceListClick(popup, event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const sourceId = button.dataset.sourceId;
  const source = getAudioSources().find((item) => item.id === sourceId);
  if (!source) return;

  if (button.dataset.action === "test") {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Testing…";
    try {
      await testAudioSource(source);
    } catch (err) {
      alert(`Audio playback failed.\n\n${err.message || err}`);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
    return;
  }

  if (button.dataset.action === "delete" && !source.builtin) {
    if (!confirm(`Delete audio source "${source.name}"?\n音声ソースを削除しますか？`)) return;
    try {
      await deleteAudioSource(sourceId);
    } catch (err) {
      alert(`Failed to delete audio source.\n\n${err.message || err}`);
      return;
    }
    _renderSourceList(popup.querySelector("#audio-source-list"));
    _renderEventList(popup.querySelector("#audio-event-list"));
  }
}

function _bindEvents(popup) {
  popup.querySelector("#audio-event-list").addEventListener("change", (event) => {
    const select = event.target.closest("select[data-event-id]");
    if (!select) return;
    updateAudioEventSetting(select.dataset.eventId, {
      [select.dataset.field]: select.value || null,
    });
  });

  popup.querySelector("#audio-source-list").addEventListener("click", (event) => {
    _handleSourceListClick(popup, event);
  });

  popup.querySelector("#audio-source-list").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-source-id]");
    if (!input) return;
    try {
      renameAudioSource(input.dataset.sourceId, input.value);
      _renderEventList(popup.querySelector("#audio-event-list"));
    } catch (err) {
      alert(`Failed to rename audio source.\n\n${err.message || err}`);
      _renderSourceList(popup.querySelector("#audio-source-list"));
    }
  });

  popup.querySelector("#audio-eew-low-accuracy-toggle").addEventListener("change", (event) => {
    setEewPlayLowAccuracy(event.target.checked);
  });

  popup.querySelector("#audio-add-type").addEventListener("change", () => {
    _updateAddFormVisibility(popup);
    if (popup.querySelector("#audio-add-type").value === "local") {
      _refreshLocalFiles(popup);
    }
  });

  popup.querySelector("#audio-refresh-local").addEventListener("click", () => {
    _refreshLocalFiles(popup);
  });

  popup.querySelector("#audio-add-btn").addEventListener("click", () => {
    _handleAddSource(popup);
  });
}

/**
 * Wires the Audio button in Settings to the audio popup.
 */
export function initAudioSettings() {
  const openBtn = document.getElementById("audio-open-btn");
  const popup = document.getElementById("audio-popup");
  if (!openBtn || !popup) return;

  const closeBtn = popup.querySelector("#audio-close-btn");

  _configureAddTypeOptions(popup);
  _bindEvents(popup);

  const render = () => {
    _renderEventList(popup.querySelector("#audio-event-list"));
    _renderSourceList(popup.querySelector("#audio-source-list"));
    popup.querySelector("#audio-eew-low-accuracy-toggle").checked = getEewPlayLowAccuracy();
    _setStatus(popup, "");
    _renderFolderPath();
    if (popup.querySelector("#audio-add-type").value === "local") {
      _refreshLocalFiles(popup);
    }
  };

  openBtn.addEventListener("click", () => {
    popup.classList.remove("hidden");
    render();
  });

  closeBtn.addEventListener("click", () => {
    popup.classList.add("hidden");
  });

  popup.addEventListener("click", (event) => {
    if (event.target === popup) popup.classList.add("hidden");
  });
}
