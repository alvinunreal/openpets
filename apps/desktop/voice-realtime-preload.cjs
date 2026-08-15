"use strict";

const COMMAND_CHANNEL = "openpets:voice-realtime-command";
const EVENT_CHANNEL = "openpets:voice-realtime-event";
const MAX_EVENT_BYTES = 512 * 1024;
const commandListeners = new Set();

require("electron").ipcRenderer.on(COMMAND_CHANNEL, (_event, command) => {
  for (const listener of commandListeners) {
    try { listener(command); } catch { /* renderer command handlers are isolated from the host */ }
  }
});

require("electron").contextBridge.exposeInMainWorld("openPetsVoiceRealtime", Object.freeze({
  onCommand(listener) {
    if (typeof listener !== "function") throw new TypeError("Voice realtime command listener must be a function.");
    commandListeners.add(listener);
    return () => commandListeners.delete(listener);
  },
  emit(event) {
    if (!event || typeof event !== "object") return;
    let size;
    try { size = Buffer.byteLength(JSON.stringify(event), "utf8"); } catch { return; }
    if (size > MAX_EVENT_BYTES) return;
    require("electron").ipcRenderer.send(EVENT_CHANNEL, event);
  },
}));
