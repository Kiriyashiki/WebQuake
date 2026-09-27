const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__ELECTRON__", true);
contextBridge.exposeInMainWorld("__ELECTRON_API__", {
  fetch: (url, options) => ipcRenderer.invoke("desktop:fetch", url, options),
  log: (level, message) => ipcRenderer.invoke("desktop:log", level, message),
  openUrl: (url) => ipcRenderer.invoke("desktop:openUrl", url),
});
