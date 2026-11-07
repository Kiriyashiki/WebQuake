const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__ELECTRON__", true);
contextBridge.exposeInMainWorld("__ELECTRON_API__", {
  fetch: (url, options) => ipcRenderer.invoke("desktop:fetch", url, options),
  log: (level, message) => ipcRenderer.invoke("desktop:log", level, message),
  debugLog: (message) => ipcRenderer.invoke("desktop:debugLog", message),
  clearDebugLog: () => ipcRenderer.invoke("desktop:clearDebugLog"),
  openUrl: (url) => ipcRenderer.invoke("desktop:openUrl", url),
});
