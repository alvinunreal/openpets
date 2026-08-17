const { contextBridge, ipcRenderer } = require("electron");

// Keep SDK route strings in sync with src/plugin-sdk-routes.ts. The desktop
// conformance check extracts call()/callSync()/subscription() route literals
// from this preload and compares them to the canonical route table.

const tokenArg = process.argv.find((arg) => arg.startsWith("--openpets-plugin-token="));
const channel = tokenArg ? `openpets:plugin-sdk:${tokenArg.slice("--openpets-plugin-token=".length)}` : "";
let callbackId = 0;
const callbacks = new Map();

async function call(path, args) {
  if (!channel) throw new Error("OpenPets plugin SDK is unavailable.");
  return unwrapSdkResult(await ipcRenderer.invoke(channel, path, normalizeForIpc(args)));
}

function callSync(path, args) {
  if (!channel) throw new Error("OpenPets plugin SDK is unavailable.");
  const result = ipcRenderer.sendSync(channel, path, normalizeForIpc(args));
  return unwrapSdkResult(result);
}

function unwrapSdkResult(result) {
  if (!result || typeof result !== "object" || !result.__openPetsError || typeof result.__openPetsError !== "object") return result;
  const { message, code } = result.__openPetsError;
  if (typeof message !== "string") return result;
  const error = new Error(message);
  if (typeof code === "string") error.code = code;
  throw error;
}

function normalizeForIpc(value, depth = 0) {
  if (depth > 20) return null;
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => normalizeForIpc(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, 100)) {
      const normalized = normalizeForIpc(nested, depth + 1);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return String(value);
}

function registerCallback(fn) {
  if (typeof fn !== "function") return undefined;
  const id = `cb-${++callbackId}`;
  callbacks.set(id, fn);
  return id;
}

// Subscription helper: fire-and-forget subscribe that resolves to a
// subscription id; returns a disposer that unsubscribes once resolved.
function subscription(onPath, offPath, args, fn) {
  const id = registerCallback(fn);
  const pending = call(onPath, [...args, id]).catch(() => undefined);
  return () => {
    callbacks.delete(id);
    void pending.then((result) => {
      const subscriptionId = result && result.subscriptionId;
      if (subscriptionId) void call(offPath, [subscriptionId]).catch(() => undefined);
    });
  };
}

function makeBubbleHandle(result) {
  const bubbleId = result && result.bubbleId;
  return {
    id: String(bubbleId),
    update: (patch) => call("ui.bubbleUpdate", [bubbleId, patch]),
    dismiss: () => call("ui.bubbleDismiss", [bubbleId]),
    pin: () => call("ui.bubblePin", [bubbleId]),
    unpin: () => call("ui.bubbleUnpin", [bubbleId]),
    onAction: (fn) => { void call("ui.bubbleSubscribe", [bubbleId, "action", registerCallback(fn)]).catch(() => undefined); },
    onSubmit: (fn) => { void call("ui.bubbleSubscribe", [bubbleId, "submit", registerCallback(fn)]).catch(() => undefined); },
    onDismiss: (fn) => { void call("ui.bubbleSubscribe", [bubbleId, "dismiss", registerCallback(fn)]).catch(() => undefined); },
  };
}

function makePanelHandle(result) {
  const panelId = result && result.panelId;
  return {
    id: String(panelId),
    show: () => call("ui.panelShow", [panelId]),
    hide: () => call("ui.panelHide", [panelId]),
    postMessage: (msg) => call("ui.panelPost", [panelId, msg]),
    onMessage: (fn) => { void call("ui.panelOnMessage", [panelId, registerCallback(fn)]).catch(() => undefined); },
    close: () => call("ui.panelClose", [panelId]),
  };
}

function makeDeliveryHandle(result) {
  const deliveryId = result && result.deliveryId;
  return {
    dismiss: () => call("ui.deliveryDismiss", [deliveryId]),
    onDismiss: (fn) => { void call("ui.deliverySubscribe", [deliveryId, registerCallback(fn)]).catch(() => undefined); },
  };
}

function wrapPickedFile(file) {
  return {
    name: String(file.name),
    sizeBytes: Number(file.sizeBytes),
    readText: () => call("files.read", [file.fileId, "text"]),
    readBytes: () => call("files.read", [file.fileId, "bytes"]),
  };
}

function wrapEventPayload(event, payload) {
  if (event !== "pet:drop" || !payload || !Array.isArray(payload.files)) return payload;
  return {
    ...payload,
    files: payload.files.map((file) => ({
      name: String(file.name),
      sizeBytes: Number(file.sizeBytes),
      readText: () => call("files.read", [file.fileId, "text"]),
    })),
  };
}

function makePetHandle(petId) {
  return {
    id: String(petId),
    speak: (spec) => call("pet.speak", [petId, spec]).then(makeBubbleHandle),
    react: (reaction, options) => call("pet.react", [petId, reaction, options]),
    setAnimation: (state) => call("pet.setAnimation", [petId, state]),
    setScale: (scale) => call("pet.setScale", [petId, scale]),
    setStatusReaction: (reaction) => call("pet.setStatusReaction", [petId, reaction]),
    moveBy: (options) => call("pet.moveBy", [petId, options]),
    wander: (options) => call("pet.wander", [petId, options]),
    moveToHome: () => call("pet.moveToHome", [petId]),
    moveTo: (point, opts) => call("pet.moveTo", [petId, point, opts]),
    followCursor: (opts) => call("pet.followCursor", [petId, opts]),
    physics: (opts) => call("pet.physics", [petId, opts]),
    onTick: (fn) => subscription("pet.onTick", "pet.offTick", [petId], fn),
    getState: () => call("pet.getState", [petId]),
    show: () => call("pet.show", [petId]),
    hide: () => call("pet.hide", [petId]),
    close: () => call("pet.close", [petId]),
  };
}

const defaultPet = makePetHandle("default");

const sdk = {
  pet: defaultPet,
  pets: {
    default: defaultPet,
    list: () => call("pets.list", []),
    get: (petId) => makePetHandle(petId),
    spawn: (spec) => call("pets.spawn", [spec]).then((result) => makePetHandle(result && result.petHandleId)),
    onChange: (fn) => subscription("pets.onChange", "pets.offChange", [], fn),
  },
  ui: {
    bubble: (spec) => call("ui.bubble", [spec]).then(makeBubbleHandle),
    alert: (spec) => call("ui.alert", [spec]).then((handle) => {
      const bubble = makeBubbleHandle(handle);
      bubble.acknowledge = () => call("ui.bubbleDismiss", [handle.bubbleId]);
      return bubble;
    }),
    toast: (spec) => call("ui.toast", [spec]),
    panel: (spec) => call("ui.panel", [spec]).then(makePanelHandle),
    delivery: (spec) => call("ui.delivery", [spec]).then(makeDeliveryHandle),
    menu: {
      setItems: (items) => call("ui.menuSetItems", [items]),
      onSelect: (fn) => subscription("ui.menuOnSelect", "ui.menuOffSelect", [], fn),
    },
  },
  audio: {
    play: (sound, options) => call("audio.play", [sound, options]),
    importUserSound: (file, opts) => call("audio.importUserSound", [file && file.fileId ? file.fileId : file, opts]),
    forgetUserSound: (ref) => call("audio.forgetUserSound", [ref]),
    stop: (handle) => call("audio.stop", [handle]),
  },
  events: {
    on: (event, fn) => subscription("events.on", "events.off", [event], (payload) => fn(wrapEventPayload(event, payload))),
  },
  assets: {
    icon: (name) => ({ kind: "icon", name: String(name) }),
    image: (name) => ({ kind: "image", name: String(name) }),
    svg: (name) => ({ kind: "svg", name: String(name) }),
    sprite: (name) => ({ kind: "sprite", name: String(name) }),
    sound: (name) => ({ kind: "sound", name: String(name) }),
  },
  bus: {
    publish: (topic, payload) => call("bus.publish", [topic, payload]),
    subscribe: (topic, fn) => subscription("bus.subscribe", "bus.unsubscribe", [topic], fn),
  },
  schedule: {
    once: (id, delayMs, callback) => call("schedule.once", [id, delayMs, registerCallback(callback)]),
    every: (id, intervalMs, callback) => call("schedule.every", [id, intervalMs, registerCallback(callback)]),
    daily: (id, spec, callback) => call("schedule.daily", [id, spec, registerCallback(callback)]),
    cron: (id, expr, callback) => call("schedule.cron", [id, expr, registerCallback(callback)]),
    at: (id, isoTimestamp, callback) => call("schedule.at", [id, isoTimestamp, registerCallback(callback)]),
    list: () => call("schedule.list", []),
    cancel: (id) => call("schedule.cancel", [id]),
    cancelAll: () => call("schedule.cancelAll", []),
  },
  storage: {
    get: (key) => call("storage.get", [key]),
    set: (key, value) => call("storage.set", [key, value]),
    delete: (key) => call("storage.delete", [key]),
    keys: () => call("storage.keys", []),
    subscribe: (key, fn) => subscription("storage.subscribe", "storage.unsubscribe", [key], fn),
  },
  config: {
    get: () => call("config.get", []),
    onChange: (listener) => {
      const id = registerCallback(listener);
      void call("config.onChange", [id]);
      return () => { callbacks.delete(id); void call("config.offChange", [id]); };
    },
  },
  net: {
    fetch: (url, options) => call("net.fetch", [url, options]),
    stream: (url, options, onChunk) => call("net.stream", [url, options, registerCallback(onChunk)]),
  },
  notify: {
    notify: (spec) => call("notify.notify", [spec]),
  },
  ai: {
    available: () => call("ai.available", []),
    complete: (req) => call("ai.complete", [req]),
    stream: (req, onToken) => call("ai.stream", [req, registerCallback(onToken)]),
  },
  secrets: {
    set: (key, value) => call("secrets.set", [key, value]),
    get: (key) => call("secrets.get", [key]),
    delete: (key) => call("secrets.delete", [key]),
    has: (key) => call("secrets.has", [key]),
  },
  voice: {
    speak: (text, opts) => call("voice.speak", [text, opts]),
    listen: (opts) => call("voice.listen", [opts]),
  },
  auth: {
    oauth: (config) => call("auth.oauth", [config]),
    refresh: (provider) => call("auth.refresh", [provider]),
    signOut: (provider) => call("auth.signOut", [provider]),
  },
  files: {
    pick: (opts) => call("files.pick", [opts]).then((files) => (Array.isArray(files) ? files.map(wrapPickedFile) : [])),
    save: (opts) => call("files.save", [opts]),
  },
  system: {
    info: () => call("system.info", []),
    metrics: () => call("system.metrics", []),
    openExternal: (url) => call("system.openExternal", [url]),
    readClipboardText: () => call("system.readClipboardText", []),
    writeClipboardText: (text) => call("system.writeClipboardText", [text]),
  },
  commands: {
    register: (command, handler) => call("commands.register", [command, registerCallback(handler)]),
    unregister: (id) => call("commands.unregister", [id]),
  },
  status: {
    set: (status) => call("status.set", [status]),
    clear: () => call("status.clear", []),
  },
  assistant: {
    registerCapability: (capability, handler) => call("assistant.registerCapability", [capability, registerCallback(handler)]),
    unregisterCapability: (id) => call("assistant.unregisterCapability", [id]),
  },
  http: {
    fetch: (url, options) => call("http.fetch", [url, options]),
  },
  log: Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...args) => call(`log.${level}`, args)])),
  t: (key, vars) => callSync("i18n.t", [key, vars]),
};

Object.defineProperty(sdk, "locale", {
  enumerable: true,
  get: () => callSync("i18n.locale", []),
});

contextBridge.exposeInMainWorld("__openPetsSdk", sdk);
contextBridge.exposeInMainWorld("__openPetsRunCallback", async (id, args) => {
  const callback = callbacks.get(id);
  if (callback) return callback(...(Array.isArray(args) ? args : []));
  return undefined;
});
