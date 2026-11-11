import { isDesktop, desktopFetch, desktopOpenUrl } from "./desktopBridge.js";

const RELEASE_API_URL =
  "https://api.github.com/repos/Kiriyashiki/WebQuake/releases/latest";
const HOMEPAGE_DOWNLOAD_URL =
  "https://kyoquake.hainaut.xyz/about.html?download=1";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECHECK_TICK_MS = 60 * 60 * 1000;
const LAST_CHECK_KEY = "kyoquake-update-last-check";
const CACHE_KEY = "kyoquake-update-release";

const CURRENT_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

let initialized = false;
let updateButton = null;
let popup = null;
let versionElement = null;
let notesElement = null;
let actionButton = null;
let releaseLink = null;
let closeButton = null;
let pendingRelease = null;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage failures.
  }
}

function getLastCheck() {
  const value = Number.parseInt(storageGet(LAST_CHECK_KEY) || "", 10);
  return Number.isFinite(value) ? value : 0;
}

function setLastCheck(timestamp) {
  storageSet(LAST_CHECK_KEY, String(timestamp));
}

function parseVersion(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)*)/);
  if (!match) return null;
  return match[1].split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const active = parseVersion(current);
  if (!next || !active) return false;

  const length = Math.max(next.length, active.length);
  for (let i = 0; i < length; i += 1) {
    const nextPart = next[i] ?? 0;
    const activePart = active[i] ?? 0;
    if (nextPart > activePart) return true;
    if (nextPart < activePart) return false;
  }
  return false;
}

function readCachedRelease() {
  const raw = storageGet(CACHE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data.tag_name === "string" ? data : null;
  } catch {
    return null;
  }
}

function writeCachedRelease(release) {
  if (!release) {
    storageSet(CACHE_KEY, null);
    return;
  }

  storageSet(
    CACHE_KEY,
    JSON.stringify({
      tag_name: release.tag_name,
      name: release.name,
      body: release.body,
      html_url: release.html_url,
      prerelease: release.prerelease,
      draft: release.draft,
    }),
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders the small subset of Markdown used in GitHub release notes.
 * The input is escaped first, so only generated markup can reach innerHTML.
 */
function renderReleaseNotes(body) {
  const escaped = escapeHtml(body || "").trim();
  if (!escaped) return "";

  const html = escaped
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    )
    .replace(/^#{1,6}\s+(.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  let result = html
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");

  if (!isDesktop) {
    result += "<p>If reloading the page does not update, please clear browser cache.</p>";
  }

  return result;
}

function populatePopup(release) {
  if (!release) return;

  if (versionElement) {
    versionElement.textContent = release.name || release.tag_name || "";
  }
  if (notesElement) {
    notesElement.innerHTML = renderReleaseNotes(release.body);
  }
  if (releaseLink && release.html_url) {
    releaseLink.href = release.html_url;
  }
}

function showUpdate(release) {
  if (!release || !updateButton) return;
  pendingRelease = release;
  updateButton.classList.remove("hidden");
  updateButton.title = `Update available: ${release.name || release.tag_name}`;
  populatePopup(release);
}

function hideUpdate() {
  pendingRelease = null;
  updateButton?.classList.add("hidden");
  closePopup();
}

function openPopup() {
  if (!popup || !pendingRelease) return;
  populatePopup(pendingRelease);
  popup.classList.remove("hidden");
}

function closePopup() {
  popup?.classList.add("hidden");
}

async function fetchLatestRelease() {
  const response = await desktopFetch(RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });

  if (!response.ok) {
    throw new Error(`GitHub API responded with ${response.status}`);
  }

  return response.json();
}

async function checkForUpdate() {
  try {
    const release = await fetchLatestRelease();

    if (!release?.tag_name || release.prerelease || release.draft) {
      return;
    }

    if (isNewerVersion(release.tag_name, CURRENT_VERSION)) {
      writeCachedRelease(release);
      showUpdate(release);
    } else {
      writeCachedRelease(null);
      hideUpdate();
    }
  } catch (err) {
    console.warn("[update] Failed to check for updates:", err);
  }
}

function runScheduledCheck() {
  if (Date.now() - getLastCheck() < CHECK_INTERVAL_MS) return;
  setLastCheck(Date.now());
  checkForUpdate();
}

/**
 * Initialises the daily update check and the update button/popup UI.
 * Safe to call more than once.
 */
export function initUpdateChecker() {
  if (initialized) return;
  initialized = true;

  updateButton = document.getElementById("update-btn");
  popup = document.getElementById("update-popup");
  versionElement = document.getElementById("update-version");
  notesElement = document.getElementById("update-notes");
  actionButton = document.getElementById("update-action-btn");
  releaseLink = document.getElementById("update-release-link");
  closeButton = document.getElementById("update-close-btn");

  if (!updateButton || !popup) return;

  updateButton.addEventListener("click", () => {
    if (popup.classList.contains("hidden")) {
      openPopup();
    } else {
      closePopup();
    }
  });

  closeButton?.addEventListener("click", closePopup);

  popup.addEventListener("click", (event) => {
    if (event.target === popup) closePopup();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popup.classList.contains("hidden")) {
      closePopup();
    }
  });

  if (actionButton) {
    if (isDesktop) {
      actionButton.textContent = "Download · ダウンロード";
      actionButton.addEventListener("click", () => {
        desktopOpenUrl(HOMEPAGE_DOWNLOAD_URL);
      });
    } else {
      actionButton.textContent = "Reload page · 再読み込み";
      actionButton.addEventListener("click", () => {
        window.location.reload();
      });
    }
  }

  const cachedRelease = readCachedRelease();
  if (
    cachedRelease &&
    !cachedRelease.prerelease &&
    !cachedRelease.draft &&
    isNewerVersion(cachedRelease.tag_name, CURRENT_VERSION)
  ) {
    showUpdate(cachedRelease);
  } else {
    hideUpdate();
  }

  runScheduledCheck();
  setInterval(runScheduledCheck, RECHECK_TICK_MS);
}
