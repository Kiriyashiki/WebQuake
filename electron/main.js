import { app, BrowserWindow, protocol, net, shell, session, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const iconPath = path.join(rootDir, "src-tauri/icons/icon.png");

const isDev = process.env.NODE_ENV === "development" || process.argv.includes("--dev");

const testQuitArg = process.argv.find((arg) => arg.startsWith("--test-quit-after="));
if (testQuitArg) {
  const ms = Number.parseInt(testQuitArg.split("=")[1], 10) || 3000;
  setTimeout(() => {
    console.log(`[Electron] Auto-quitting after ${ms}ms test period.`);
    app.quit();
  }, ms);
}

// ─── Log file rotation (matching Tauri directory) ──────────────────────────
function getLogDir() {
  if (process.platform === "linux") {
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "xyz.hainaut.kyoquake", "logs");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "xyz.hainaut.kyoquake", "logs");
  }
  return path.join(os.homedir(), "Library", "Application Support", "xyz.hainaut.kyoquake", "logs");
}

const logDir = getLogDir();
fs.mkdirSync(logDir, { recursive: true });

const latestLogFile = path.join(logDir, "latest.log");
const oldLogFile = path.join(logDir, "old.log");

if (fs.existsSync(latestLogFile)) {
  try {
    fs.copyFileSync(latestLogFile, oldLogFile);
    fs.unlinkSync(latestLogFile);
  } catch (err) {
    console.warn("[Electron] Failed to rotate log file:", err);
  }
}

function writeLog(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(latestLogFile, line, "utf8");
  } catch (err) {
    console.error("[Electron] Failed to write to log file:", err);
  }
}

// ─── Register custom privileged scheme for production assets ───────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Allow audio to autoplay without requiring an initial user click
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Linux Wayland compatibility fix for Vulkan warning
if (process.platform === "linux") {
  app.commandLine.appendSwitch("disable-features", "Vulkan");
}

let mainWindow = null;
let viteServer = null;

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * Checks whether an HTTP URL is actively responding.
 */
async function isUrlResponding(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok || res.status === 200 || res.status === 304;
  } catch {
    return false;
  }
}

/**
 * Creates the primary application window.
 */
async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "KyoQuake",
    width: 900,
    height: 650,
    minWidth: 400,
    minHeight: 300,
    resizable: true,
    fullscreen: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      webSecurity: true,
    },
  });

  // Hide default menu bar for clean app UI matching Tauri
  mainWindow.setMenuBarVisibility(false);

  // Keyboard shortcuts: F12 / Ctrl+Shift+I for DevTools, Ctrl+R / F5 for reload
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (input.control && input.shift && input.key.toLowerCase() === "i" && input.type === "keyDown") {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (input.control && input.key.toLowerCase() === "r" && input.type === "keyDown") {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  // Open external links in user's default web browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isDevUrl = isDev && url.startsWith("http://localhost:5173");
    if (!isDevUrl && (url.startsWith("http://") || url.startsWith("https://"))) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (isDev) {
    const devUrl = "http://localhost:5173";
    const alreadyRunning = await isUrlResponding(devUrl);

    if (!alreadyRunning) {
      console.log("[Electron] Starting internal Vite dev server...");
      const { createServer } = await import("vite");
      viteServer = await createServer({
        root: rootDir,
        server: {
          port: 5173,
        },
      });
      await viteServer.listen();
      console.log("[Electron] Vite dev server ready at", devUrl);
    } else {
      console.log("[Electron] Connected to existing Vite dev server at", devUrl);
    }

    await mainWindow.loadURL(devUrl).catch(() => {});
  } else {
    // Production mode: ensure frontend is built
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath)) {
      console.log("[Electron] Production build not found. Running vite build...");
      const { build } = await import("vite");
      await build({
        root: rootDir,
      });
      console.log("[Electron] Build finished.");
    }

    await mainWindow.loadURL("app://localhost/index.html").catch(() => {});
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── App Lifecycle & IPC Handlers ───────────────────────────────────────────
app.whenReady().then(() => {
  // IPC: Logging
  ipcMain.handle("desktop:log", (event, level, message) => {
    writeLog(level, message);
  });

  // IPC: Desktop HTTP bypass
  ipcMain.handle("desktop:fetch", async (event, url, options = {}) => {
    try {
      const fetchOptions = {
        method: options.method || "GET",
        headers: options.headers || {},
      };
      if (options.body && options.method && options.method.toUpperCase() !== "GET" && options.method.toUpperCase() !== "HEAD") {
        fetchOptions.body = options.body;
      }
      const res = await fetch(url, fetchOptions);

      const headers = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const body = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers,
        body,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        statusText: err.message,
        headers: {},
        body: null,
        error: err.message,
      };
    }
  });

  // IPC: External URL opener
  ipcMain.handle("desktop:openUrl", async (event, url) => {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      await shell.openExternal(url);
    }
  });

  // Block web analytics tracking requests inside desktop app to avoid CORS errors
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["*://stats.hainaut.xyz/*"] },
    (details, callback) => {
      callback({ cancel: true });
    }
  );

  // Serve production dist files through app:// protocol
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath === "/" || decodedPath === "") {
      decodedPath = "/index.html";
    }
    const relativePath = decodedPath.replace(/^\/+/, "");
    let filePath = path.join(distDir, relativePath);

    if (!fs.existsSync(filePath)) {
      filePath = path.join(distDir, "index.html");
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (viteServer) {
    await viteServer.close();
    viteServer = null;
  }
});
