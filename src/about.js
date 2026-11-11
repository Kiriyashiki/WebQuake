const root = document.documentElement;
const langToggle = document.getElementById("lang-toggle");
const kanaToggle = document.getElementById("kana-toggle");

const LANG_KEY = "kyoquake-about-lang";
const KANA_KEY = "kyoquake-about-kana";

const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/Kiriyashiki/WebQuake/releases/latest";
const GITHUB_RELEASES_URL = "https://github.com/Kiriyashiki/WebQuake/releases";

const downloadToggle = document.getElementById("download-toggle");
const downloader = document.getElementById("downloader");
const osPicker = document.getElementById("os-picker");
const downloaderStatus = document.getElementById("downloader-status");
const downloaderVersion = document.getElementById("downloader-version");
const downloadOptions = document.getElementById("download-options");

const DOWNLOAD_OS = {
  linux: {
    recommended: "appimage",
    formats: [
      {
        id: "appimage",
        match: /\.appimage$/i,
        label: "AppImage",
        note: {
          en: "Portable · recommended",
          ja: "ポータブル・推奨",
        },
      },
      {
        id: "deb",
        match: /\.deb$/i,
        label: "Debian / Ubuntu (.deb)",
        note: {
          en: "Debian, Ubuntu and derivatives",
          ja: "Debian・Ubuntu 系",
        },
      },
      {
        id: "rpm",
        match: /\.rpm$/i,
        label: "Fedora / RHEL (.rpm)",
        note: {
          en: "Fedora, RHEL and derivatives",
          ja: "Fedora・RHEL 系",
        },
      },
    ],
  },
  windows: {
    recommended: "exe",
    formats: [
      {
        id: "exe",
        match: /\.exe$/i,
        label: "Windows installer (.exe)",
        note: {
          en: "Recommended",
          ja: "推奨",
        },
      },
      {
        id: "msi",
        match: /\.msi$/i,
        label: "Windows installer (.msi)",
        note: {
          en: "For managed or MSI installs",
          ja: "MSI インストール向け",
        },
      },
    ],
  },
  macos: {
    recommended: "dmg",
    formats: [
      {
        id: "dmg",
        match: /\.dmg$/i,
        label: "macOS disk image (.dmg)",
        note: {
          en: "Recommended",
          ja: "推奨",
        },
      },
      {
        id: "targz",
        match: /\.tar\.gz$/i,
        label: "macOS archive (Apple silicon · .tar.gz)",
        note: {
          en: "For advanced users",
          ja: "上級者向け",
        },
      },
    ],
  },
};

const osButtons = osPicker
  ? Array.from(osPicker.querySelectorAll(".os-btn"))
  : [];

let selectedOS = detectOS();
let releaseData = null;
let releaseError = null;
let releaseLoading = false;
let releasePromise = null;

function currentLang() {
  return root.classList.contains("lang-ja") ? "ja" : "en";
}

function detectOS() {
  const userAgentData = navigator.userAgentData;
  const platform = (
    userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();

  if (platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad")) {
    return "macos";
  }
  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("linux") || platform.includes("x11") || platform.includes("android")) {
    return "linux";
  }
  // Most desktop visitors are on Windows, so use it as the fallback.
  return "windows";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function makeLangSpan(lang, text) {
  const span = document.createElement("span");
  span.className = `lang-${lang}`;
  span.textContent = text;
  return span;
}

function setLocalizedText(el, en, ja) {
  if (!el) return;
  el.replaceChildren(makeLangSpan("en", en), makeLangSpan("ja", ja));
}

function setStatus(en, ja, linkToReleases = false) {
  if (!downloaderStatus) return;
  setLocalizedText(downloaderStatus, en, ja);

  if (linkToReleases) {
    const link = document.createElement("a");
    link.className = "downloader-status-link";
    link.href = GITHUB_RELEASES_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "GitHub Releases";
    downloaderStatus.append(" ", link);
  }

  downloaderStatus.classList.remove("hidden");
}

function findAsset(release, format) {
  if (!Array.isArray(release?.assets)) return null;
  return release.assets.find((asset) => format.match.test(asset.name || "")) || null;
}

function createDownloadRow(asset, format, isRecommended, lang) {
  const row = document.createElement("a");
  row.className = "download-row";
  row.href = asset.browser_download_url;

  const icon = document.createElement("img");
  icon.className = "download-row-icon";
  icon.src = "/demo/download.png";
  icon.alt = "";
  icon.width = 20;
  icon.height = 20;

  const body = document.createElement("span");
  body.className = "download-row-body";

  const titleRow = document.createElement("span");
  titleRow.className = "download-row-title-row";

  const title = document.createElement("span");
  title.className = "download-row-title";
  title.textContent = format.label;
  titleRow.append(title);

  if (isRecommended) {
    const badge = document.createElement("span");
    badge.className = "download-badge mono";
    badge.textContent = lang === "ja" ? "推奨" : "Recommended";
    titleRow.append(badge);
  }

  const meta = document.createElement("span");
  meta.className = "download-row-meta mono";
  const size = formatBytes(asset.size);
  meta.textContent = size ? `${asset.name} · ${size}` : asset.name;

  const note = document.createElement("span");
  note.className = "download-row-note";
  note.textContent = format.note[lang] || format.note.en;

  body.append(titleRow, meta, note);

  const action = document.createElement("span");
  action.className = "download-row-action mono";
  action.textContent = lang === "ja" ? "ダウンロード" : "Download";

  row.append(icon, body, action);
  return row;
}

function renderDownloader() {
  if (!downloader) return;

  const lang = currentLang();

  for (const button of osButtons) {
    const isActive = button.dataset.os === selectedOS;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  }

  if (!downloadOptions) return;

  if (!releaseData) {
    downloadOptions.replaceChildren();

    if (releaseError) {
      setStatus(
        "Could not load the latest release.",
        "最新リリースを読み込めませんでした。",
        true,
      );
    } else if (releaseLoading || !downloader.classList.contains("hidden")) {
      setStatus("Loading the latest release…", "最新リリースを読み込み中…");
    }
    return;
  }

  downloaderStatus.classList.add("hidden");

  if (downloaderVersion) {
    downloaderVersion.textContent = releaseData.tag_name || "";
  }

  const config = DOWNLOAD_OS[selectedOS];
  const rows = [];

  for (const format of config.formats) {
    const asset = findAsset(releaseData, format);
    if (!asset) continue;
    rows.push(
      createDownloadRow(asset, format, format.id === config.recommended, lang),
    );
  }

  downloadOptions.replaceChildren(...rows);

  if (rows.length === 0) {
    setStatus(
      "No downloads were found for this operating system.",
      "この OS 向けのダウンロードは見つかりませんでした。",
      true,
    );
  }
}

async function loadDownloaderRelease() {
  if (releaseData) return;
  if (releasePromise) return releasePromise;

  releaseLoading = true;
  releaseError = null;
  renderDownloader();

  releasePromise = fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      releaseData = data;
    })
    .catch((err) => {
      console.error("[about] Failed to load the latest release:", err);
      releaseError = err;
    })
    .finally(() => {
      releaseLoading = false;
      releasePromise = null;
      renderDownloader();
    });

  return releasePromise;
}

function openDownloader({ scroll = true } = {}) {
  if (!downloader) return;
  downloader.classList.remove("hidden");
  downloadToggle?.setAttribute("aria-expanded", "true");
  loadDownloaderRelease();
  renderDownloader();
  if (scroll) {
    downloader.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function closeDownloader() {
  if (!downloader) return;
  downloader.classList.add("hidden");
  downloadToggle?.setAttribute("aria-expanded", "false");
}

function toggleDownloader() {
  if (!downloader) return;
  if (downloader.classList.contains("hidden")) {
    openDownloader();
  } else {
    closeDownloader();
  }
}

function getDownloadOSParameter() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("download")) {
    return (params.get("download") || "1").toLowerCase();
  }
  if (window.location.hash === "#download") {
    return "1";
  }
  return null;
}

function applyLang(lang, persist = true) {
  const isJa = lang === "ja";
  root.classList.toggle("lang-en", !isJa);
  root.classList.toggle("lang-ja", isJa);
  root.lang = isJa ? "ja" : "en";

  if (langToggle) {
    langToggle.setAttribute(
      "aria-label",
      isJa ? "Switch to English" : "日本語に切り替える",
    );
  }

  document.title = isJa ? "KyoQuake — 概要" : "KyoQuake — About";

  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, isJa ? "ja" : "en");
    } catch (err) {
      // Ignore storage failures.
    }
  }

  renderDownloader();
}

function applyKana(enabled, persist = true) {
  root.classList.toggle("kana-on", enabled);

  if (kanaToggle) {
    kanaToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  if (persist) {
    try {
      localStorage.setItem(KANA_KEY, enabled ? "1" : "0");
    } catch (err) {
      // Ignore storage failures.
    }
  }
}

// Sync the controls with the language/kana classes set by the inline head script.
applyLang(currentLang(), false);
applyKana(root.classList.contains("kana-on"), false);

langToggle?.addEventListener("click", () => {
  applyLang(currentLang() === "ja" ? "en" : "ja");
});

kanaToggle?.addEventListener("click", () => {
  applyKana(!root.classList.contains("kana-on"));
});

downloadToggle?.addEventListener("click", toggleDownloader);

osPicker?.addEventListener("click", (event) => {
  const button = event.target.closest(".os-btn");
  if (!button) return;
  selectedOS = button.dataset.os;
  renderDownloader();
});

// Allow the desktop app (and external links) to open the downloader directly:
//   /about.html?download=1   or  /about.html?download=windows
const downloadOSParameter = getDownloadOSParameter();
if (downloadOSParameter !== null) {
  if (Object.prototype.hasOwnProperty.call(DOWNLOAD_OS, downloadOSParameter)) {
    selectedOS = downloadOSParameter;
  }
  openDownloader({ scroll: true });
}
