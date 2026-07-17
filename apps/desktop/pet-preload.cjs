const { ipcRenderer } = require("electron");

const allowedMotionStates = new Set(["idle", "run-left", "run-right"]);
const allowedReactionStates = new Set(["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]);
let lastInteractiveHit = null;
let dragging = false;

const dismissBubble = (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const bubble = target.closest(".bubble");
  if (!bubble) return;

  const dismissToken = bubble.dataset.dismissToken;
  if (!dismissToken) return;

  event.preventDefault();
  event.stopPropagation();

  bubble.remove();

  const newTarget = document.elementFromPoint(event.clientX, event.clientY);
  const stillInteractive = Boolean(newTarget && newTarget.closest(".pet-hitbox, .pet-shell, .bubble")) || dragging;
  reportInteractiveHit(stillInteractive, "bubble-dismiss", true);

  ipcRenderer.send("openpets:bubble-dismissed", dismissToken);
};

ipcRenderer.on("openpets:pet-motion", (_event, state) => {
  if (!allowedMotionStates.has(state)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.motionState = state;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

ipcRenderer.on("openpets:pet-reaction-state", (_event, state) => {
  if (!allowedReactionStates.has(state)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.reactionState = state;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

ipcRenderer.on("openpets:pet-content-state", (_event, state) => {
  if (!state || typeof state.bodyHtml !== "string" || state.bodyHtml.length > 64 * 1024 || !allowedReactionStates.has(state.reactionState)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.reactionState = state.reactionState;
    document.body.innerHTML = state.bodyHtml;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

const getInteractiveTarget = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return target && target.closest(".pet-hitbox, .pet-shell, .bubble");
};

const reportInteractiveHit = (interactive, source, force = false) => {
  if (!force && lastInteractiveHit === interactive) return;
  lastInteractiveHit = interactive;
  ipcRenderer.send("openpets:pet-hit-test", interactive, source);
};

const setInteractiveHit = (interactive, source = "mouse") => {
  if (lastInteractiveHit === interactive) return;
  reportInteractiveHit(interactive, source);
};

const updateInteractiveHit = (event) => {
  setInteractiveHit(Boolean(getInteractiveTarget(event)) || dragging);
};

ipcRenderer.on("openpets:pet-probe-hit-test", (_event, point) => {
  if (!point || typeof point.clientX !== "number" || typeof point.clientY !== "number" || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
  const clientX = point.clientX;
  const clientY = point.clientY;
  const target = document.elementFromPoint(clientX, clientY);
  reportInteractiveHit(Boolean(target && target.closest(".pet-hitbox, .pet-shell, .bubble")) || dragging, typeof point.reason === "string" ? point.reason.slice(0, 80) : "probe", true);
});

// --- Plugin bubble interactions (actions, inline inputs) -------------------

const collectBubbleInputValues = (bubble) => {
  const values = {};
  for (const control of bubble.querySelectorAll(".bubble-input-control")) {
    const id = control.dataset.inputId;
    if (!id) continue;
    values[id] = control.type === "number" ? Number(control.value) : String(control.value);
  }
  return values;
};

const handleBubbleInteraction = (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const actionButton = target.closest("[data-bubble-action]");
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.send("openpets:bubble-action", actionButton.dataset.bubbleToken, actionButton.dataset.bubbleAction);
    return true;
  }
  const submitButton = target.closest("[data-bubble-submit]");
  if (submitButton) {
    event.preventDefault();
    event.stopPropagation();
    const bubble = submitButton.closest(".bubble");
    ipcRenderer.send("openpets:bubble-submit", submitButton.dataset.bubbleSubmit, bubble ? collectBubbleInputValues(bubble) : {});
    return true;
  }
  if (target.closest(".bubble-input-control")) return true;
  return false;
};

// --- Pet senses: clicks, hover, drops ---------------------------------------

let lastHoverSentAt = 0;
let suppressClickUntil = 0;

const sendPetEvent = (name, payload) => {
  ipcRenderer.send("openpets:pet-event", name, payload || {});
};

const installPetSenses = () => {
  document.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".pet-hitbox, .pet-shell")) return;
    if (Date.now() < suppressClickUntil) return;
    sendPetEvent("pet:clicked", {});
  });
  document.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".pet-hitbox, .pet-shell")) return;
    sendPetEvent("pet:doubleClicked", {});
  });
  document.addEventListener("mouseover", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".pet-hitbox, .pet-shell")) return;
    const now = Date.now();
    if (now - lastHoverSentAt < 2000) return;
    lastHoverSentAt = now;
    sendPetEvent("pet:hover", {});
  }, { passive: true });

  const maxDropTextBytes = 256 * 1024;
  const maxDropFileBytes = 5 * 1024 * 1024;
  document.addEventListener("dragover", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".pet-hitbox, .pet-shell")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".pet-hitbox, .pet-shell")) return;
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const files = [...(transfer.files || [])].slice(0, 4);
    if (files.length > 0) {
      Promise.all(files.map(async (file) => ({
        name: String(file.name).slice(0, 200),
        sizeBytes: file.size,
        text: file.size <= maxDropFileBytes ? await file.text().catch(() => "") : "",
        truncated: file.size > maxDropFileBytes,
      }))).then((read) => sendPetEvent("pet:drop", { kind: "files", droppedFiles: read })).catch(() => undefined);
      return;
    }
    const text = String(transfer.getData("text/plain") || "").slice(0, maxDropTextBytes);
    if (text) sendPetEvent("pet:drop", { kind: "text", text });
  });
};

// --- Plugin sprite/scale overrides ------------------------------------------

let spriteOverrideElement = null;
ipcRenderer.on("openpets:pet-sprite-override", (_event, override) => {
  const shell = document.querySelector(".pet-shell");
  if (!shell) return;
  const base = shell.querySelector(".sprite, .installed-card");
  if (spriteOverrideElement) { spriteOverrideElement.remove(); spriteOverrideElement = null; }
  if (!override || typeof override.fileUrl !== "string" || !override.fileUrl.startsWith("file://")) {
    if (base) base.style.visibility = "";
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    const frame = probe.naturalHeight;
    const frames = Math.max(1, Math.floor(probe.naturalWidth / Math.max(1, frame)));
    const fps = Math.min(30, Math.max(1, Number(override.fps) || 8));
    const el = document.createElement("div");
    el.className = "plugin-sprite-override";
    el.style.cssText = `position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:${frame}px;height:${frame}px;background-image:url("${override.fileUrl.replace(/"/g, "%22")}");background-repeat:no-repeat;background-size:${probe.naturalWidth}px ${frame}px;animation:plugin-sprite-frames ${(frames / fps).toFixed(3)}s steps(${frames}) ${override.loop === false ? "1" : "infinite"};pointer-events:none;`;
    let style = document.getElementById("plugin-sprite-override-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "plugin-sprite-override-style";
      document.head.appendChild(style);
    }
    style.textContent = `@keyframes plugin-sprite-frames { from { background-position: 0 0; } to { background-position: -${frames * frame}px 0; } }`;
    if (base) base.style.visibility = "hidden";
    shell.appendChild(el);
    spriteOverrideElement = el;
  };
  probe.src = override.fileUrl;
});

ipcRenderer.on("openpets:pet-scale-override", (_event, scale) => {
  const value = Number(scale);
  if (!Number.isFinite(value) || value < 0.25 || value > 3) return;
  const sprite = document.querySelector(".sprite, .installed-sprite");
  if (sprite) sprite.style.transform = `scale(${value})`;
});

// --- Plugin audio (named WebAudio recipes + bundled data URLs) ---------------

let audioContext = null;
let activeAudioNodes = [];
let activeAudioElements = [];

const audioLog = (level, message, fields) => {
  try {
    const safeFields = fields && Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const line = `[openpets:pet-audio] ${message}`;
    if (level === "warn") console.warn(line, safeFields || {});
    else console.debug(line, safeFields || {});
  } catch { /* diagnostics must never affect playback */ }
};

const getAudioContext = () => {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return audioContext;
};

const namedSoundRecipes = {
  chime: [{ freq: 880, type: "sine", start: 0, duration: 0.35 }, { freq: 1318.5, type: "sine", start: 0.12, duration: 0.4 }],
  pop: [{ freq: 420, type: "square", start: 0, duration: 0.08 }],
  nom: [{ freq: 220, type: "triangle", start: 0, duration: 0.1 }, { freq: 180, type: "triangle", start: 0.12, duration: 0.1 }],
  alert: [{ freq: 660, type: "sawtooth", start: 0, duration: 0.18 }, { freq: 660, type: "sawtooth", start: 0.26, duration: 0.18 }],
  "level-up": [{ freq: 523.25, type: "sine", start: 0, duration: 0.12 }, { freq: 659.25, type: "sine", start: 0.12, duration: 0.12 }, { freq: 783.99, type: "sine", start: 0.24, duration: 0.22 }],
  tick: [{ freq: 1000, type: "square", start: 0, duration: 0.03 }],
  success: [{ freq: 587.33, type: "sine", start: 0, duration: 0.14 }, { freq: 880, type: "sine", start: 0.14, duration: 0.24 }],
  error: [{ freq: 311.13, type: "sine", start: 0, duration: 0.18 }, { freq: 233.08, type: "sine", start: 0.2, duration: 0.28 }],
  "voice-start": [{ freq: 659.25, type: "sine", start: 0, duration: 0.08 }, { freq: 880, type: "sine", start: 0.08, duration: 0.12 }],
  "voice-stop": [{ freq: 880, type: "sine", start: 0, duration: 0.08 }, { freq: 659.25, type: "sine", start: 0.08, duration: 0.12 }],
  "voice-wake": [{ freq: 523.25, type: "sine", start: 0, duration: 0.08 }, { freq: 783.99, type: "sine", start: 0.08, duration: 0.16 }],
};

ipcRenderer.on("openpets:play-audio", (_event, payload) => {
  try {
    if (!payload) return;
    const volume = Math.min(1, Math.max(0, Number(payload.volume) || 0.6));
    audioLog("debug", "play requested", { kind: payload.kind, volume });
    if (payload.kind === "named") {
      const recipe = namedSoundRecipes[payload.name];
      if (!recipe) { audioLog("warn", "named sound skipped", { name: payload.name, reason: "unknown-sound" }); return; }
      const ctxAudio = getAudioContext();
      if (ctxAudio.state === "suspended") void ctxAudio.resume().catch((error) => audioLog("warn", "audio context resume failed", { reason: error && error.message ? error.message : String(error) }));
      const now = ctxAudio.currentTime;
      for (const note of recipe) {
        const osc = ctxAudio.createOscillator();
        const gain = ctxAudio.createGain();
        osc.type = note.type;
        osc.frequency.value = note.freq;
        gain.gain.setValueAtTime(0, now + note.start);
        gain.gain.linearRampToValueAtTime(volume * 0.35, now + note.start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
        osc.connect(gain).connect(ctxAudio.destination);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
        activeAudioNodes.push(osc);
      }
      audioLog("debug", "named sound scheduled", { name: payload.name, notes: recipe.length, contextState: ctxAudio.state });
      return;
    }
    if (payload.kind === "data" && typeof payload.dataUrl === "string" && payload.dataUrl.startsWith("data:audio/")) {
      const element = new Audio(payload.dataUrl);
      element.volume = volume;
      activeAudioElements.push(element);
      element.addEventListener("ended", () => { activeAudioElements = activeAudioElements.filter((entry) => entry !== element); audioLog("debug", "data sound ended", { remaining: activeAudioElements.length }); });
      element.addEventListener("error", () => audioLog("warn", "data sound element error", { code: element.error ? element.error.code : undefined, message: element.error ? element.error.message : undefined }));
      void element.play().then(() => audioLog("debug", "data sound playback started", { volume })).catch((error) => {
        activeAudioElements = activeAudioElements.filter((entry) => entry !== element);
        audioLog("warn", "data sound playback failed", { reason: error && error.message ? error.message : String(error), name: error && error.name ? error.name : undefined });
      });
    } else {
      audioLog("warn", "play request ignored", { kind: payload.kind, reason: "invalid-payload" });
    }
  } catch (error) { audioLog("warn", "play request threw", { reason: error && error.message ? error.message : String(error) }); }
});

ipcRenderer.on("openpets:stop-audio", () => {
  audioLog("debug", "stop requested", { nodes: activeAudioNodes.length, elements: activeAudioElements.length });
  for (const node of activeAudioNodes) { try { node.stop(); } catch { /* already stopped */ } }
  activeAudioNodes = [];
  for (const element of activeAudioElements) { try { element.pause(); } catch { /* noop */ } }
  activeAudioElements = [];
});

// --- Host voice output (isolated from plugin audio) --------------------------

let activeVoiceAudioEntries = [];
let activeVoiceUtteranceEntries = [];

const createVoicePlaybackFinish = (requestId) => {
  let finished = false;
  return (ok) => {
    if (finished) return false;
    finished = true;
    if (requestId) ipcRenderer.send("openpets:voice-playback-finished", { requestId, ok });
    return true;
  };
};

ipcRenderer.on("openpets:voice-play-audio", (_event, payload) => {
  const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
  const finish = createVoicePlaybackFinish(requestId);
  let entry = null;
  const settle = (ok) => {
    if (!finish(ok)) return;
    if (entry) activeVoiceAudioEntries = activeVoiceAudioEntries.filter((candidate) => candidate !== entry);
  };
  try {
    if (!requestId || typeof payload.dataUrl !== "string" || !payload.dataUrl.startsWith("data:audio/")) { settle(false); return; }
    const element = new Audio(payload.dataUrl);
    element.volume = Math.min(1, Math.max(0, Number(payload.volume) || 1));
    entry = { requestId, element, finish: settle };
    activeVoiceAudioEntries.push(entry);
    element.addEventListener("ended", () => settle(true), { once: true });
    element.addEventListener("error", () => settle(false), { once: true });
    void element.play().catch(() => settle(false));
  } catch { settle(false); }
});

ipcRenderer.on("openpets:voice-system-speak", (_event, payload) => {
  const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
  const finish = createVoicePlaybackFinish(requestId);
  let entry = null;
  const settle = (ok) => {
    if (!finish(ok)) return;
    if (entry) activeVoiceUtteranceEntries = activeVoiceUtteranceEntries.filter((candidate) => candidate !== entry);
  };
  try {
    if (!requestId || typeof payload.text !== "string" || !window.speechSynthesis) { settle(false); return; }
    const utterance = new SpeechSynthesisUtterance(payload.text.slice(0, 4000));
    if (typeof payload.rate === "number" && payload.rate >= 0.5 && payload.rate <= 2) utterance.rate = payload.rate;
    if (typeof payload.voice === "string" && payload.voice) {
      const match = window.speechSynthesis.getVoices().find((voice) => voice.name === payload.voice || voice.voiceURI === payload.voice || voice.lang === payload.voice);
      if (match) utterance.voice = match;
    }
    entry = { requestId, utterance, finish: settle };
    activeVoiceUtteranceEntries.push(entry);
    utterance.addEventListener("end", () => settle(true), { once: true });
    utterance.addEventListener("error", () => settle(false), { once: true });
    window.speechSynthesis.speak(utterance);
  } catch { settle(false); }
});

ipcRenderer.on("openpets:voice-stop", () => {
  const audioEntries = activeVoiceAudioEntries;
  activeVoiceAudioEntries = [];
  for (const entry of audioEntries) {
    entry.finish(false);
    try { entry.element.pause(); } catch { /* noop */ }
  }
  const utteranceEntries = activeVoiceUtteranceEntries;
  activeVoiceUtteranceEntries = [];
  // Settle cancellation before invoking browser APIs: speechSynthesis.cancel()
  // may synchronously emit an end/error event on some platforms.
  for (const entry of utteranceEntries) entry.finish(false);
  try { if (utteranceEntries.length > 0 && window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* noop */ }
});

ipcRenderer.on("openpets:voice-system-list-voices", (_event, payload) => {
  const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
  if (!requestId) return;
  const synthesis = window.speechSynthesis;
  let sent = false;
  let timer = null;
  let onVoicesChanged = null;
  const send = () => {
    if (sent) return;
    sent = true;
    if (timer !== null) clearTimeout(timer);
    if (synthesis && onVoicesChanged) synthesis.removeEventListener("voiceschanged", onVoicesChanged);
    const discovered = synthesis ? synthesis.getVoices().map((voice) => ({ id: voice.voiceURI || voice.name, label: voice.name, language: voice.lang })) : [];
    const voices = [...new Map(discovered.map((voice) => [voice.id, voice])).values()]
      .sort((a, b) => String(a.language).localeCompare(String(b.language)) || a.label.localeCompare(b.label))
      .slice(0, 300);
    ipcRenderer.send("openpets:voice-system-voices-result", { requestId, voices });
  };
  if (synthesis && synthesis.getVoices().length === 0) {
    onVoicesChanged = send;
    timer = setTimeout(send, 500);
    synthesis.addEventListener("voiceschanged", onVoicesChanged, { once: true });
  } else send();
});

ipcRenderer.on("openpets:voice-listening-state", (_event, state) => {
  const allowed = ["idle", "listening", "transcribing", "thinking"];
  document.documentElement.dataset.voiceState = allowed.includes(state) ? state : "idle";
});

ipcRenderer.on("openpets:voice-cue", (_event, payload) => {
  const recipe = payload && namedSoundRecipes[payload.cue];
  if (!recipe) return;
  const ctxAudio = getAudioContext();
  const now = ctxAudio.currentTime;
  for (const note of recipe) {
    const osc = ctxAudio.createOscillator();
    const gain = ctxAudio.createGain();
    osc.type = note.type;
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(0, now + note.start);
    gain.gain.linearRampToValueAtTime(0.22, now + note.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
    osc.connect(gain).connect(ctxAudio.destination);
    osc.start(now + note.start);
    osc.stop(now + note.start + note.duration + 0.04);
  }
});

// --- Plugin TTS ---------------------------------------------------------------

ipcRenderer.on("openpets:tts-speak", (_event, payload) => {
  try {
    if (!payload || typeof payload.text !== "string" || !window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(payload.text.slice(0, 500));
    if (typeof payload.rate === "number" && payload.rate >= 0.5 && payload.rate <= 2) utterance.rate = payload.rate;
    if (typeof payload.voice === "string" && payload.voice) {
      const match = window.speechSynthesis.getVoices().find((voice) => voice.name === payload.voice || voice.lang === payload.voice);
      if (match) utterance.voice = match;
    }
    window.speechSynthesis.speak(utterance);
  } catch { /* tts is best-effort */ }
});

ipcRenderer.on("openpets:tts-stop", () => {
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ }
});

const installMouseInterop = () => {
  lastInteractiveHit = null;
  dragging = false;

  const usesNativePetDrag = () => document.documentElement?.dataset?.nativePetDrag === "wayland";

  document.addEventListener("click", (event) => {
    if (handleBubbleInteraction(event)) return;
    dismissBubble(event);
  });
  installPetSenses();

  let dragStartPoint = null;

  document.addEventListener("mousemove", (event) => {
    updateInteractiveHit(event);
    if (dragging && !usesNativePetDrag()) ipcRenderer.send("openpets:pet-drag-move", { screenX: event.screenX, screenY: event.screenY });
  }, { passive: true });

  document.addEventListener("mousedown", (event) => {
    const target = getInteractiveTarget(event);
    setInteractiveHit(Boolean(target));
    if (event.button !== 0 || !target?.closest(".pet-hitbox, .pet-shell")) return;
    if (usesNativePetDrag()) return;
    event.preventDefault();
    dragging = true;
    dragStartPoint = { screenX: event.screenX, screenY: event.screenY };
    setInteractiveHit(true);
    ipcRenderer.send("openpets:pet-drag-start", { screenX: event.screenX, screenY: event.screenY });
  });

  document.addEventListener("mouseup", (event) => {
    if (!dragging) return;
    dragging = false;
    if (dragStartPoint && Math.hypot(event.screenX - dragStartPoint.screenX, event.screenY - dragStartPoint.screenY) > 4) {
      suppressClickUntil = Date.now() + 300;
    }
    dragStartPoint = null;
    if (!usesNativePetDrag()) ipcRenderer.send("openpets:pet-drag-end");
  });

  document.addEventListener("mouseleave", () => {
    if (!dragging) setInteractiveHit(false);
  }, { passive: true });

  setInteractiveHit(false, "ready");
  ipcRenderer.send("openpets:pet-ready");
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installMouseInterop, { once: true });
} else {
  installMouseInterop();
}
