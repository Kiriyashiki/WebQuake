import "maplibre-gl/dist/maplibre-gl.css";
import "../styles/index.css";
import "../styles/gmpeTest.css";

import {
  loadAreaCodes,
  loadCityForecastMapCsv,
  loadCityNames,
  loadStationNames,
  loadStationsCsvText,
} from "./areaCodes.js";
import { haversineDistance } from "./constants.js";
import {
  clearEpicenter,
  displayEpicenter,
  initMap,
  updateCityAreasVisibility,
  updateShakemapVisibility,
} from "./map.js";
import { calculateGmpe, floatToShindo } from "./eew/physics.js";
import { prepareEvent, shindoAtSite } from "./eew/mf2013.js";
import { createSlabModel } from "./eew/slabs.js";

const GMPE_MF2013 = "mf2013";
const GMPE_SM1999 = "sm1999";

const state = {
  map: null,
  areaCodes: null,
  cityNames: null,
  stationNames: null,
  stations: [],
  cityToArea: new Map(),
  slabModel: null,
  slabModelPromise: null,
  mode: "shakemap",
  pickMode: false,
  computing: false,
  results: null,
  resultByStationName: new Map(),
};

const dom = {
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebar-toggle-btn"),
  toggleArrow: document.querySelector("#sidebar-toggle-btn .toggle-arrow"),
  model: document.getElementById("gmpe-model"),
  magnitude: document.getElementById("gmpe-magnitude"),
  depth: document.getElementById("gmpe-depth"),
  latitude: document.getElementById("gmpe-latitude"),
  longitude: document.getElementById("gmpe-longitude"),
  pickEpicenter: document.getElementById("gmpe-pick-epicenter"),
  pickHint: document.getElementById("gmpe-pick-hint"),
  mf2013Options: document.getElementById("gmpe-mf2013-options"),
  mw: document.getElementById("gmpe-mw"),
  eventType: document.getElementById("gmpe-event-type"),
  region: document.getElementById("gmpe-region"),
  run: document.getElementById("gmpe-run"),
  message: document.getElementById("gmpe-message"),
  statusDot: document.getElementById("gmpe-status-dot"),
  statusText: document.getElementById("gmpe-status-text"),
  tooltipEstimated: document.getElementById("tooltip-estimated"),
  modeButtons: Array.from(document.querySelectorAll(".gmpe-mode-btn")),
};

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(text, kind = "idle") {
  dom.statusText.textContent = text;
  dom.statusDot.className = `dot-${kind}`;
}

function setMessage(text, kind = "") {
  dom.message.textContent = text;
  dom.message.classList.toggle("is-error", kind === "error");
  dom.message.classList.toggle("is-success", kind === "success");
}

function syncModelFields() {
  const isMf2013 = dom.model.value === GMPE_MF2013;
  dom.mf2013Options.disabled = !isMf2013;
}

function setPickMode(enabled) {
  state.pickMode = enabled;
  dom.pickEpicenter.classList.toggle("active", enabled);
  dom.pickEpicenter.setAttribute("aria-pressed", String(enabled));
  dom.pickHint.classList.toggle("hidden", !enabled);

  if (state.map) {
    state.map.getCanvas().style.cursor = enabled ? "crosshair" : "";
  }
}

function updateModeButtons() {
  for (const button of dom.modeButtons) {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  }
}

function showEstimatedLine(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    hideEstimatedLine();
    return;
  }
  dom.tooltipEstimated.textContent = `Estimated intensity · 推定震度 ${value.toFixed(1)}`;
  dom.tooltipEstimated.classList.remove("hidden");
}

function hideEstimatedLine() {
  dom.tooltipEstimated.classList.add("hidden");
  dom.tooltipEstimated.textContent = "";
}

// ─── Data loading ────────────────────────────────────────────────────────────

function parseStationsCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  let startIndex = 0;
  if (lines[0]?.startsWith("code")) startIndex = 1;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(";");
    if (parts.length < 9) continue;

    const lat = Number.parseFloat(parts[4]);
    const lon = Number.parseFloat(parts[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const avs30 = parts.length > 8 ? Number.parseFloat(parts[8]) : Number.NaN;
    const d1400Raw = parts.length > 9 ? parts[9].trim() : "";
    const d1400 = d1400Raw === "" ? null : Number.parseFloat(d1400Raw);

    rows.push({
      code: parts[0].trim(),
      name: parts[1].replace(/[＊*]/g, "").trim(),
      lat,
      lon,
      cityCode: parts[6]?.trim() ?? "",
      arv: parts.length > 7 ? Number.parseFloat(parts[7]) : Number.NaN,
      avs30,
      d1400: Number.isFinite(d1400) ? d1400 : null,
    });
  }

  return rows;
}

function parseCityForecastMap(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("cityCode")) continue;

    const [cityCode, areaCode] = line.split(",");
    if (!cityCode || !areaCode) continue;
    map.set(cityCode.trim(), areaCode.trim());
  }

  return map;
}

async function loadSlabModel() {
  if (state.slabModel) return state.slabModel;

  if (!state.slabModelPromise) {
    state.slabModelPromise = (async () => {
      const [metaRes, binRes] = await Promise.all([
        fetch("/slab2_japan.json"),
        fetch("/slab2_japan.bin"),
      ]);
      if (!metaRes.ok || !binRes.ok) {
        throw new Error(`slab2_japan fetch failed (${metaRes.status}/${binRes.status})`);
      }

      const [meta, buffer] = await Promise.all([metaRes.json(), binRes.arrayBuffer()]);
      state.slabModel = createSlabModel(meta, buffer);
      return state.slabModel;
    })().catch((err) => {
      state.slabModelPromise = null;
      throw err;
    });
  }

  return state.slabModelPromise;
}

// ─── Epicenter marker ────────────────────────────────────────────────────────

function readCoordinateInputs() {
  const latitude = Number.parseFloat(dom.latitude.value);
  const longitude = Number.parseFloat(dom.longitude.value);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude };
}

function updateEpicenterMarker() {
  if (!state.map) return;

  const coordinates = readCoordinateInputs();
  if (coordinates) {
    displayEpicenter(state.map, coordinates);
  } else {
    clearEpicenter(state.map);
  }
}

// ─── GMPE calculation ────────────────────────────────────────────────────────

function readNumberField(el, label, min, max, { required = true } = {}) {
  const raw = el.value.trim();
  if (raw === "") {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function readParameters() {
  const model = dom.model.value === GMPE_SM1999 ? GMPE_SM1999 : GMPE_MF2013;
  const magnitude = readNumberField(dom.magnitude, "Magnitude (Mj)", 0, 11);
  const depthKm = readNumberField(dom.depth, "Depth", 0, 750);
  const latitude = readNumberField(dom.latitude, "Latitude", -90, 90);
  const longitude = readNumberField(dom.longitude, "Longitude", -180, 180);

  const params = { model, magnitude, depthKm, latitude, longitude };

  if (model === GMPE_MF2013) {
    params.mw = readNumberField(dom.mw, "Magnitude (Mw)", 0, 11, { required: false });
    params.type = dom.eventType.value ? Number(dom.eventType.value) : null;
    params.region = dom.region.value || null;
  }

  return params;
}

function updateMaxResult(map, key, item) {
  const current = map.get(key);
  if (!current || item.value > current.value) {
    map.set(key, item);
  }
}

function calculateResults(params) {
  const perStation = [];
  const byCity = new Map();
  const byArea = new Map();
  const byStationName = new Map();

  let mf2013Event = null;
  if (params.model === GMPE_MF2013) {
    // A forced event type bypasses the slab-based classifier entirely.
    if (params.type === null && !state.slabModel) {
      throw new Error("MF 2013 slab model is not loaded.");
    }

    const event = {
      magnitude: params.magnitude,
      depthKm: params.depthKm,
      lat: params.latitude,
      lon: params.longitude,
    };
    if (params.mw !== null) event.mw = params.mw;
    if (params.type !== null) event.type = params.type;
    if (params.region !== null) event.region = params.region;

    mf2013Event = prepareEvent(event, state.slabModel);
  }

  for (const station of state.stations) {
    const distance = haversineDistance(
      station.lat,
      station.lon,
      params.latitude,
      params.longitude,
    );

    let value;
    if (mf2013Event) {
      value = shindoAtSite(mf2013Event, {
        lat: station.lat,
        lon: station.lon,
        avs30: station.avs30,
        d1400: station.d1400,
        epicentralDistanceKm: distance,
      });
    } else {
      let arv = station.arv;
      if (!(arv > 0) || !Number.isFinite(arv)) arv = 1;
      value = calculateGmpe(params.magnitude, params.depthKm, distance, arv);
    }

    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    const item = {
      station,
      value,
      shindo: floatToShindo(value),
      cityCode: station.cityCode,
      areaCode: state.cityToArea.get(station.cityCode) ?? null,
    };

    perStation.push(item);
    byStationName.set(station.name, item);
    updateMaxResult(byCity, item.cityCode, item);
    if (item.areaCode) updateMaxResult(byArea, item.areaCode, item);
  }

  return { params, perStation, byCity, byArea, byStationName };
}

// ─── Map result display ──────────────────────────────────────────────────────

function clearMapResultStates() {
  if (!state.map) return;
  for (const source of ["shakemap", "cities", "forecast_areas"]) {
    try {
      state.map.removeFeatureState({ source });
    } catch (_) {
      // Source may not be initialised yet.
    }
  }
}

function applyResults() {
  if (!state.map) return;

  if (!state.map.isStyleLoaded()) {
    state.map.once("idle", applyResults);
    return;
  }

  clearMapResultStates();
  hideEstimatedLine();

  const results = state.results;
  if (!results) return;

  if (state.mode === "shakemap") {
    for (const item of results.perStation) {
      if (item.shindo === "0") continue;
      try {
        state.map.setFeatureState(
          { source: "shakemap", id: item.station.name },
          { highlighted: true, intensity: item.shindo },
        );
      } catch (_) {
        // Station may not exist in the shakemap source.
      }
    }
    return;
  }

  if (state.mode === "city") {
    for (const [cityCode, item] of results.byCity.entries()) {
      if (item.shindo === "0") continue;
      try {
        state.map.setFeatureState(
          { source: "cities", id: cityCode },
          { highlighted: true, intensity: item.shindo },
        );
      } catch (_) {
        // City may not exist in the municipalities source.
      }
    }
    return;
  }

  for (const [areaCode, item] of results.byArea.entries()) {
    if (item.shindo === "0") continue;
    try {
      state.map.setFeatureState(
        { source: "forecast_areas", id: areaCode },
        { highlighted: true, intensity: item.shindo },
      );
    } catch (_) {
      // Area may not exist in the forecast source.
    }
  }
}

function setMode(mode) {
  if (mode !== "forecast" && mode !== "city" && mode !== "shakemap") return;

  state.mode = mode;
  updateModeButtons();
  setPickMode(false);
  hideEstimatedLine();

  if (!state.map) return;

  updateShakemapVisibility(state.map, mode === "shakemap");
  if (mode !== "shakemap") {
    updateCityAreasVisibility(state.map, mode === "city");
  }

  applyResults();
}

function bindShakemapTooltipEstimate() {
  if (!state.map) return;

  state.map.on("mousemove", "shakemap-fill", (event) => {
    if (state.mode !== "shakemap") {
      hideEstimatedLine();
      return;
    }

    const feature = event.features?.[0];
    if (!feature) return;

    const rawName = feature.properties?.name ?? feature.id ?? "";
    const name = String(rawName).replace(/[＊*]/g, "");
    const result = state.resultByStationName.get(name);

    if (result) {
      showEstimatedLine(result.value);
    } else {
      hideEstimatedLine();
    }
  });

  state.map.on("mouseleave", "shakemap-fill", hideEstimatedLine);
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function bindUiEvents() {
  dom.sidebarToggle.addEventListener("click", () => {
    dom.sidebar.classList.toggle("hidden");
    dom.sidebarToggle.classList.toggle("closed");
    dom.toggleArrow?.classList.toggle("rotated");
  });

  dom.model.addEventListener("change", syncModelFields);

  dom.latitude.addEventListener("input", updateEpicenterMarker);
  dom.longitude.addEventListener("input", updateEpicenterMarker);

  dom.pickEpicenter.addEventListener("click", () => {
    setPickMode(!state.pickMode);
  });

  dom.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  dom.run.addEventListener("click", runTest);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.pickMode) {
      setPickMode(false);
    }
  });
}

function bindMapEvents() {
  if (!state.map) return;

  state.map.on("click", (event) => {
    if (!state.pickMode) return;

    const { lat, lng } = event.lngLat;
    dom.latitude.value = lat.toFixed(3);
    dom.longitude.value = lng.toFixed(3);
    updateEpicenterMarker();
    setPickMode(false);
  });
}

async function runTest() {
  if (state.computing) return;

  let params;
  try {
    params = readParameters();
  } catch (err) {
    setMessage(err.message, "error");
    setStatus("Invalid input", "error");
    return;
  }

  state.computing = true;
  dom.run.disabled = true;
  dom.run.textContent = "Calculating… · 計算中";
  setMessage("");
  setStatus("Calculating…", "loading");

  try {
    if (params.model === GMPE_MF2013 && params.type === null) {
      try {
        await loadSlabModel();
      } catch (err) {
        throw new Error(`MF 2013 slab model unavailable: ${err.message}`);
      }
    }

    // Let the loading state paint before the synchronous station loop.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const results = calculateResults(params);
    state.results = results;
    state.resultByStationName = results.byStationName;

    console.debug(results);

    applyResults();

    const displayedCount = results.perStation.filter((item) => item.shindo !== "0").length;
    const modelLabel = params.model === GMPE_MF2013 ? "MF 2013" : "SM 1999";
    setMessage(
      `${modelLabel}: ${displayedCount.toLocaleString()} of ${results.perStation.length.toLocaleString()} stations with intensity ≥ 1.`,
      "success",
    );
    setStatus("Complete", "live");
  } catch (err) {
    console.error("[GMPE Test]", err);
    setMessage(err.message || String(err), "error");
    setStatus("Error", "error");
  } finally {
    state.computing = false;
    dom.run.disabled = false;
    dom.run.textContent = "Run GMPE Test · 実行";
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  bindUiEvents();
  syncModelFields();

  dom.run.disabled = true;
  dom.run.textContent = "Loading… · 読み込み中";
  setStatus("Loading map…", "loading");

  let areaCodes;
  let cityNames;
  let stationNames;
  let stationsText;
  let cityForecastText;

  try {
    [areaCodes, cityNames, stationNames, stationsText, cityForecastText] = await Promise.all([
      loadAreaCodes(),
      loadCityNames(),
      loadStationNames(),
      loadStationsCsvText(),
      loadCityForecastMapCsv(),
    ]);
  } catch (err) {
    console.error("[GMPE Test] Failed to load map data:", err);
    setStatus("Load error", "error");
    setMessage("Failed to load map data. Check the console for details.", "error");
    return;
  }

  state.areaCodes = areaCodes;
  state.cityNames = cityNames;
  state.stationNames = stationNames;
  state.stations = parseStationsCsv(stationsText);
  state.cityToArea = parseCityForecastMap(cityForecastText);

  const mapEl = document.getElementById("map");
  if (!mapEl) {
    setStatus("Map error", "error");
    setMessage("Map container not found.", "error");
    return;
  }

  const map = initMap(mapEl, areaCodes, cityNames, stationNames, () => false);
  state.map = map;

  await new Promise((resolve) => {
    if (map.loaded()) {
      resolve();
    } else {
      map.once("load", resolve);
    }
  });

  bindMapEvents();
  bindShakemapTooltipEstimate();
  setMode(state.mode);
  updateEpicenterMarker();

  dom.run.disabled = false;
  dom.run.textContent = "Run GMPE Test · 実行";
  setStatus("Ready", "idle");
  setMessage("Enter earthquake parameters, then run the test.");

  // Load the MF 2013 slab model in the background so the first run is fast.
  loadSlabModel().catch((err) => {
    console.warn("[GMPE Test] MF 2013 slab model preload failed:", err);
  });
}

boot().catch((err) => {
  console.error("[GMPE Test] Boot failed:", err);
  setStatus("Fatal error", "error");
  setMessage(err.message || String(err), "error");
});
