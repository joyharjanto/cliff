const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliff", {
  onVideoReady: (cb) => ipcRenderer.on("videoUrl:ready", (_e, payload) => cb(payload)),
  onTranscriptReady: (cb) => ipcRenderer.on("transcript:ready", (_e, payload) => cb(payload)),
  onSummaryReady: (cb) => ipcRenderer.on("summary:ready", (_e, payload) => cb(payload)),
});