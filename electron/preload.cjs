const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__ELECTRON__", true);
contextBridge.exposeInMainWorld("__ELECTRON_API__", {
  fetch: (url, options) => ipcRenderer.invoke("desktop:fetch", url, options),
  log: (level, message) => ipcRenderer.invoke("desktop:log", level, message),
  debugLog: (message) => ipcRenderer.invoke("desktop:debugLog", message),
  clearDebugLog: () => ipcRenderer.invoke("desktop:clearDebugLog"),
  getAudioDirPath: () => ipcRenderer.invoke("desktop:getAudioDirPath"),
  listAudioFiles: () => ipcRenderer.invoke("desktop:listAudioFiles"),
  readAudioFile: (fileName) => ipcRenderer.invoke("desktop:readAudioFile", fileName),
  openUrl: (url) => ipcRenderer.invoke("desktop:openUrl", url),
});
