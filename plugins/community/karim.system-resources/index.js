/// <reference types="@open-pets/plugin-sdk" />

export const SCHEDULE_ID = "system-resources-tick";
export const ALERT_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_POLL_SECONDS = 10;
export const DEFAULT_ALERT_PERCENT = 90;
export const DEFAULT_LANGUAGE = "auto";

export const CATALOGS = {
    "en": {
      "plugin.name": "System Resources",
      "plugin.description": "Show live CPU and RAM meters to the left of your pet.",
      "hud.cpu": "CPU",
      "hud.ram": "RAM",
      "hud.gpu": "GPU",
      "hud.ssd": "SSD",
      "value.na": "—",
      "config.showHud.label": "Show resource HUD",
      "hud.satelliteName": "Resources",
      "config.showHud.description": "Keep a compact CPU and RAM overlay to the left of the pet. Virtual Pet stats stay on the pet.",
      "config.pollSeconds.label": "Refresh interval (seconds)",
      "config.pollSeconds.description": "How often to sample host CPU and RAM metrics.",
      "config.alertPercent.label": "Alert threshold (%)",
      "config.alertPercent.description": "Speak when any meter stays at or above this value.",
      "config.speakAlerts.label": "Speak on high load",
      "config.speakAlerts.description": "Let the pet call out when a meter crosses the alert threshold.",
      "config.language.label": "Language",
      "config.language.description": "Language for meters, status, and pet speech.",
      "config.language.auto": "Automatic (OpenPets)",
      "config.language.nl": "Nederlands",
      "config.language.en": "English",
      "config.language.fr": "Français",
      "config.language.de": "Deutsch",
      "command.show.title": "Show resource HUD",
      "command.show.description": "Show the live CPU and RAM meters to the left of the pet.",
      "command.hide.title": "Hide resource HUD",
      "command.hide.description": "Hide the resource meters to the left of the pet.",
      "command.snapshot.title": "Read resources",
      "command.snapshot.description": "Have the pet read the current CPU and RAM levels.",
      "speech.snapshot": "CPU {cpu}, RAM {ram}.",
      "speech.snapshotFull": "CPU {cpu}, RAM {ram}, GPU {gpu}, SSD {ssd}.",
      "speech.alert": "{label} is at {value} percent.",
      "status.line": "CPU {cpu} · RAM {ram}",
      "status.lineFull": "CPU {cpu} · RAM {ram} · GPU {gpu} · SSD {ssd}"
    },
    "nl": {
      "plugin.name": "Systeembronnen",
      "plugin.description": "Toon live CPU- en RAM-meters links van je pet.",
      "hud.cpu": "CPU",
      "hud.ram": "RAM",
      "hud.gpu": "GPU",
      "hud.ssd": "SSD",
      "value.na": "—",
      "config.showHud.label": "Toon bronnen-HUD",
      "hud.satelliteName": "Bronnen",
      "config.showHud.description": "Houd een compact CPU- en RAM-overzicht links van de pet. Virtual Pet (food, energy, play, bond) blijft staan.",
      "config.pollSeconds.label": "Verversinterval (seconden)",
      "config.pollSeconds.description": "Hoe vaak host-CPU en -RAM worden bemonsterd.",
      "config.alertPercent.label": "Drempel voor melding (%)",
      "config.alertPercent.description": "Spreek als een meter op of boven deze waarde blijft.",
      "config.speakAlerts.label": "Spreek bij hoge load",
      "config.speakAlerts.description": "Laat de pet waarschuwen als een meter de drempel overschrijdt.",
      "config.language.label": "Taal",
      "config.language.description": "Taal voor meters, status en pet-spraak.",
      "config.language.auto": "Automatisch (OpenPets)",
      "config.language.nl": "Nederlands",
      "config.language.en": "English",
      "config.language.fr": "Français",
      "config.language.de": "Deutsch",
      "command.show.title": "Toon bronnen-HUD",
      "command.show.description": "Toon de live CPU- en RAM-meters links van de pet.",
      "command.hide.title": "Verberg bronnen-HUD",
      "command.hide.description": "Verberg de bronnenmeters links van de pet.",
      "command.snapshot.title": "Lees bronnen",
      "command.snapshot.description": "Laat de pet de huidige CPU en RAM voorlezen.",
      "speech.snapshot": "CPU {cpu}, RAM {ram}.",
      "speech.snapshotFull": "CPU {cpu}, RAM {ram}, GPU {gpu}, SSD {ssd}.",
      "speech.alert": "{label} zit op {value} procent.",
      "status.line": "CPU {cpu} · RAM {ram}",
      "status.lineFull": "CPU {cpu} · RAM {ram} · GPU {gpu} · SSD {ssd}"
    },
    "fr": {
      "plugin.name": "Ressources système",
      "plugin.description": "Affiche CPU et RAM à gauche du familier.",
      "hud.cpu": "CPU",
      "hud.ram": "RAM",
      "hud.gpu": "GPU",
      "hud.ssd": "SSD",
      "value.na": "—",
      "config.showHud.label": "Afficher le HUD des ressources",
      "hud.satelliteName": "Ressources",
      "config.showHud.description": "Garde un overlay CPU et RAM à gauche du familier. Les stats Virtual Pet restent sur le familier.",
      "config.pollSeconds.label": "Intervalle d'actualisation (secondes)",
      "config.pollSeconds.description": "Fréquence d'échantillonnage du CPU et de la RAM hôte.",
      "config.alertPercent.label": "Seuil d'alerte (%)",
      "config.alertPercent.description": "Parler lorsqu'un compteur reste à cette valeur ou au-dessus.",
      "config.speakAlerts.label": "Parler en cas de charge élevée",
      "config.speakAlerts.description": "Le familier prévient lorsqu'un compteur dépasse le seuil.",
      "config.language.label": "Langue",
      "config.language.description": "Langue des compteurs, du statut et des messages du familier.",
      "config.language.auto": "Automatique (OpenPets)",
      "config.language.nl": "Nederlands",
      "config.language.en": "English",
      "config.language.fr": "Français",
      "config.language.de": "Deutsch",
      "command.show.title": "Afficher le HUD des ressources",
      "command.show.description": "Afficher les compteurs CPU et RAM à gauche du familier.",
      "command.hide.title": "Masquer le HUD des ressources",
      "command.hide.description": "Masquer les compteurs de ressources à gauche du familier.",
      "command.snapshot.title": "Lire les ressources",
      "command.snapshot.description": "Faire lire au familier le CPU et la RAM actuels.",
      "speech.snapshot": "CPU {cpu}, RAM {ram}.",
      "speech.snapshotFull": "CPU {cpu}, RAM {ram}, GPU {gpu}, SSD {ssd}.",
      "speech.alert": "{label} est à {value} pour cent.",
      "status.line": "CPU {cpu} · RAM {ram}",
      "status.lineFull": "CPU {cpu} · RAM {ram} · GPU {gpu} · SSD {ssd}"
    },
    "de": {
      "plugin.name": "Systemressourcen",
      "plugin.description": "Zeigt Live-CPU und RAM links neben dem Haustier.",
      "hud.cpu": "CPU",
      "hud.ram": "RAM",
      "hud.gpu": "GPU",
      "hud.ssd": "SSD",
      "value.na": "—",
      "config.showHud.label": "Ressourcen-HUD anzeigen",
      "hud.satelliteName": "Ressourcen",
      "config.showHud.description": "Hält CPU und RAM links neben dem Haustier. Virtual-Pet-Werte bleiben am Haustier.",
      "config.pollSeconds.label": "Aktualisierungsintervall (Sekunden)",
      "config.pollSeconds.description": "Wie oft Host-CPU und RAM abgefragt werden.",
      "config.alertPercent.label": "Warnschwelle (%)",
      "config.alertPercent.description": "Sprechen, wenn eine Anzeige auf oder über diesem Wert bleibt.",
      "config.speakAlerts.label": "Bei hoher Last sprechen",
      "config.speakAlerts.description": "Das Haustier warnt, wenn eine Anzeige die Schwelle überschreitet.",
      "config.language.label": "Sprache",
      "config.language.description": "Sprache für Anzeigen, Status und Haustier-Sprache.",
      "config.language.auto": "Automatisch (OpenPets)",
      "config.language.nl": "Nederlands",
      "config.language.en": "English",
      "config.language.fr": "Français",
      "config.language.de": "Deutsch",
      "command.show.title": "Ressourcen-HUD anzeigen",
      "command.show.description": "Live-CPU- und RAM-Anzeigen links neben dem Haustier zeigen.",
      "command.hide.title": "Ressourcen-HUD ausblenden",
      "command.hide.description": "Die Ressourcenanzeigen links neben dem Haustier ausblenden.",
      "command.snapshot.title": "Ressourcen vorlesen",
      "command.snapshot.description": "Das Haustier liest die aktuelle CPU und RAM vor.",
      "speech.snapshot": "CPU {cpu}, RAM {ram}.",
      "speech.snapshotFull": "CPU {cpu}, RAM {ram}, GPU {gpu}, SSD {ssd}.",
      "speech.alert": "{label} liegt bei {value} Prozent.",
      "status.line": "CPU {cpu} · RAM {ram}",
      "status.lineFull": "CPU {cpu} · RAM {ram} · GPU {gpu} · SSD {ssd}"
    }
  }

export function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] == null ? `{${key}}` : String(vars[key]),
  );
}

export function resolveLanguage(raw, hostLocale = "en") {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "auto";
  if (value !== "auto" && CATALOGS[value]) return value;
  const lang = String(hostLocale || "en").split(/[-_]/)[0];
  return CATALOGS[lang] ? lang : "en";
}

export function t(language, key, vars) {
  const catalog = CATALOGS[language] ?? CATALOGS.en;
  const template = catalog[key] ?? CATALOGS.en[key] ?? key;
  return interpolate(template, vars);
}

export const SATELLITE_OFFSET_X = -180;
export const SATELLITE_SCALE = 0.5;
const pinnedBubbles = new WeakMap();
const lastAlerts = new WeakMap();
const hudSatellites = new WeakMap();
const hudInflight = new WeakMap();
const pollActive = new WeakMap();
const scheduleGenerations = new WeakMap();

export function clampPercent(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function toneFor(percent) {
  if (percent == null) return "slate";
  if (percent >= 90) return "red";
  if (percent >= 70) return "amber";
  return "green";
}

export function formatPercent(language, percent) {
  return percent == null ? t(language, "value.na") : `${percent}%`;
}

export function hottestMetric(snapshot) {
  const rows = [
    ["cpu", snapshot.cpu],
    ["ram", snapshot.ram],
    ["gpu", snapshot.gpu],
    ["ssd", snapshot.ssd],
  ];
  let hottest = null;
  for (const [key, value] of rows) {
    if (value == null) continue;
    if (!hottest || value > hottest.value) hottest = { key, value };
  }
  return hottest;
}

export function mergeSnapshot(hostMetrics = {}, now = Date.now()) {
  const gpu = clampPercent(hostMetrics.gpuPercent);
  const ssd = clampPercent(hostMetrics.diskUsedPercent);
  return {
    cpu: clampPercent(hostMetrics.cpuPercent),
    ram: clampPercent(hostMetrics.memUsedPercent),
    gpu,
    ssd,
    battery: hostMetrics.battery,
    sampledAt: now,
  };
}

export function readConfig(raw = {}, hostLocale = "en") {
  const pollSeconds = Number(raw.pollSeconds ?? DEFAULT_POLL_SECONDS);
  const alertPercent = Number(raw.alertPercent ?? DEFAULT_ALERT_PERCENT);
  return {
    showHud: raw.showHud !== false,
    speakAlerts: raw.speakAlerts !== false,
    pollSeconds: Math.max(5, Math.min(60, Number.isFinite(pollSeconds) ? pollSeconds : DEFAULT_POLL_SECONDS)),
    alertPercent: Math.max(70, Math.min(99, Number.isFinite(alertPercent) ? alertPercent : DEFAULT_ALERT_PERCENT)),
    language: resolveLanguage(raw.language ?? DEFAULT_LANGUAGE, hostLocale),
  };
}

async function configOf(ctx) {
  return readConfig((await ctx.config.get()) ?? {}, ctx.locale);
}

function getPinned(ctx) {
  return pinnedBubbles.get(ctx) ?? null;
}

function setPinned(ctx, handle) {
  if (handle) pinnedBubbles.set(ctx, handle);
  else pinnedBubbles.delete(ctx);
}

function hudItem(ctx, language, key, percent) {
  if (percent == null) return null;
  return {
    icon: ctx.assets.icon(key),
    value: percent,
    tone: toneFor(percent),
    label: percent == null ? `${t(language, `hud.${key}`)} ${t(language, "value.na")}` : t(language, `hud.${key}`),
  };
}

export function hudSpec(ctx, snapshot, language = "en") {
  const items = [
    hudItem(ctx, language, "cpu", snapshot.cpu),
    hudItem(ctx, language, "ram", snapshot.ram),
    hudItem(ctx, language, "gpu", snapshot.gpu),
    hudItem(ctx, language, "ssd", snapshot.ssd),
  ].filter((item) => item !== null);
  return {
    tone: "info",
    sticky: true,
    pin: true,
    dismissOn: [],
    priority: "normal",
    hud: { items },
  };
}

export function snapshotCopy(language, snapshot, kind) {
  const vars = {
    cpu: formatPercent(language, snapshot.cpu),
    ram: formatPercent(language, snapshot.ram),
    gpu: formatPercent(language, snapshot.gpu),
    ssd: formatPercent(language, snapshot.ssd),
  };
  const hasExtendedMetrics = snapshot.gpu != null || snapshot.ssd != null;
  const key = hasExtendedMetrics
    ? kind === "speech"
      ? "speech.snapshotFull"
      : "status.lineFull"
    : kind === "speech"
      ? "speech.snapshot"
      : "status.line";
  return t(language, key, vars);
}

export function satellitePosition(state) {
  const x = Number(state?.position?.x) || 0;
  const y = Number(state?.position?.y) || 0;
  return { x: x + SATELLITE_OFFSET_X, y };
}

export function resolveCatalogPetId(ctx, _listed = []) {
  const candidate = ctx.pets?.default?.id;
  if (typeof candidate === "string" && candidate && candidate !== "default") return candidate;
  return undefined;
}

async function dismissPinned(ctx) {
  const pinned = getPinned(ctx);
  if (!pinned) return;
  try {
    await pinned.dismiss();
  } catch {}
  setPinned(ctx, null);
}

async function closeHudSatellite(ctx) {
  const record = hudSatellites.get(ctx);
  hudSatellites.delete(ctx);
  if (!record) return;
  for (const unsub of record.unsubs ?? []) {
    try {
      unsub();
    } catch {}
  }
  try {
    await record.pet.close();
  } catch {}
}

async function ensureHudSatellite(ctx, language) {
  const existing = hudSatellites.get(ctx);
  if (existing?.pet) return existing.pet;
  if (hudInflight.has(ctx)) return hudInflight.get(ctx);

  const work = (async () => {
    let listed = [];
    try {
      listed = await ctx.pets.list();
    } catch {}
    const petId = resolveCatalogPetId(ctx, listed);
    if (!petId) return null;
    let position = { x: 80, y: 120 };
    try {
      position = satellitePosition(await ctx.pets.default.getState());
    } catch {}
    const pet = await ctx.pets.spawn({
      petId,
      name: t(language, "hud.satelliteName"),
      position,
      ephemeral: true,
    });
    try {
      await pet.setScale(SATELLITE_SCALE);
    } catch {}

    const record = { pet, lastX: position.x, lastY: position.y, unsubs: [] };
    const follow = async () => {
      try {
        const state = await ctx.pets.default.getState();
        if (state.dragging) return;
        const next = satellitePosition(state);
        if (next.x === record.lastX && next.y === record.lastY) return;
        record.lastX = next.x;
        record.lastY = next.y;
        await pet.moveTo(next, { durationMs: 100 });
      } catch {}
    };
    try {
      let lastAt = 0;
      record.unsubs.push(
        ctx.pets.default.onTick(() => {
          const now = Date.now();
          if (now - lastAt < 80) return;
          lastAt = now;
          void follow();
        }),
      );
    } catch {}
    try {
      record.unsubs.push(
        ctx.events.on("pet:dragEnd", () => {
          void follow();
        }),
      );
    } catch {}
    hudSatellites.set(ctx, record);
    return pet;
  })();

  hudInflight.set(ctx, work);
  try {
    return await work;
  } catch {
    return null;
  } finally {
    hudInflight.delete(ctx);
  }
}

export async function collectSnapshot(ctx, now = Date.now()) {
  let hostMetrics = {};
  try {
    hostMetrics = (await ctx.system.metrics()) ?? {};
  } catch {
    hostMetrics = {};
  }
  return mergeSnapshot(hostMetrics, now);
}

export async function updateHud(ctx, snapshot, cfg) {
  const settings = cfg ?? (await configOf(ctx));
  if (!settings.showHud) {
    await dismissPinned(ctx);
    await closeHudSatellite(ctx);
    return;
  }

  const host = await ensureHudSatellite(ctx, settings.language);
  const spec = hudSpec(ctx, snapshot, settings.language);
  const pinned = getPinned(ctx);
  if (pinned) {
    try {
      await pinned.update(spec);
      return;
    } catch {
      setPinned(ctx, null);
    }
  }

  try {
    const bubble = host ? await host.speak(spec) : await ctx.ui.bubble(spec);
    bubble.onDismiss(() => {
      if (getPinned(ctx)?.id === bubble.id) setPinned(ctx, null);
    });
    setPinned(ctx, bubble);
  } catch {}
}

export async function publishStatus(ctx, snapshot, language = "en") {
  const text = snapshotCopy(language, snapshot, "status");
  const hottest = hottestMetric(snapshot);
  const tone = hottest && hottest.value >= 90 ? "error" : hottest && hottest.value >= 70 ? "warning" : "info";
  try {
    await ctx.status.set({ text, tone });
  } catch {}
}

export async function maybeAlert(ctx, snapshot, now = Date.now(), cfg) {
  const settings = cfg ?? (await configOf(ctx));
  if (!settings.speakAlerts) return null;
  const hottest = hottestMetric(snapshot);
  if (!hottest || hottest.value < settings.alertPercent) return null;

  const previous = lastAlerts.get(ctx) ?? 0;
  if (now - previous < ALERT_COOLDOWN_MS) return null;
  lastAlerts.set(ctx, now);
  await ctx.storage.set("lastAlertAt", now);

  try {
    await ctx.pet.react("error", { showMessage: false });
    await ctx.pet.speak(
      t(settings.language, "speech.alert", {
        label: t(settings.language, `hud.${hottest.key}`),
        value: String(hottest.value),
      }),
    );
  } catch {}
  return hottest;
}

export async function tick(ctx, now = Date.now()) {
  const cfg = await configOf(ctx);
  const snapshot = await collectSnapshot(ctx, now);
  await ctx.storage.set("snapshot", snapshot);
  await updateHud(ctx, snapshot, cfg);
  await publishStatus(ctx, snapshot, cfg.language);
  await maybeAlert(ctx, snapshot, now, cfg);
  return snapshot;
}

export async function showHud(ctx) {
  const snapshot = await tick(ctx);
  return snapshot;
}

export async function hideHud(ctx) {
  await dismissPinned(ctx);
  await closeHudSatellite(ctx);
}

export async function speakSnapshot(ctx) {
  const cfg = await configOf(ctx);
  const snapshot = await collectSnapshot(ctx, Date.now());
  await updateHud(ctx, snapshot, cfg);
  await publishStatus(ctx, snapshot, cfg.language);
  try {
    await ctx.pet.speak(snapshotCopy(cfg.language, snapshot, "speech"));
  } catch {}
  return snapshot;
}

async function armSchedule(ctx) {
  const cfg = await configOf(ctx);
  const intervalMs = cfg.pollSeconds * 1000;
  const generation = (scheduleGenerations.get(ctx) ?? 0) + 1;
  scheduleGenerations.set(ctx, generation);
  try {
    await ctx.schedule.cancel(SCHEDULE_ID);
  } catch {}
  if (!pollActive.get(ctx) || scheduleGenerations.get(ctx) !== generation) return;
  try {
    await ctx.schedule.once(SCHEDULE_ID, intervalMs, async () => {
      if (!pollActive.get(ctx) || scheduleGenerations.get(ctx) !== generation) return;
      await tick(ctx);
      if (pollActive.get(ctx) && scheduleGenerations.get(ctx) === generation) await armSchedule(ctx);
    });
  } catch {}
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      pollActive.set(ctx, true);
      const storedAlert = await ctx.storage.get("lastAlertAt");
      if (typeof storedAlert === "number") lastAlerts.set(ctx, storedAlert);

      await tick(ctx);
      await armSchedule(ctx);

      try {
        ctx.events.on("pet:clicked", () => speakSnapshot(ctx));
      } catch {}

      ctx.config.onChange(async () => {
        if (!pollActive.get(ctx)) return;
        await armSchedule(ctx);
        await tick(ctx);
      });

      const icon = ctx.assets.icon("system-resources");
      await ctx.commands.register(
        {
          id: "show",
          title: "$t:command.show.title",
          description: "$t:command.show.description",
          icon,
        },
        () => showHud(ctx),
      );
      await ctx.commands.register(
        {
          id: "hide",
          title: "$t:command.hide.title",
          description: "$t:command.hide.description",
          icon,
        },
        () => hideHud(ctx),
      );
      await ctx.commands.register(
        {
          id: "snapshot",
          title: "$t:command.snapshot.title",
          description: "$t:command.snapshot.description",
          icon,
        },
        () => speakSnapshot(ctx),
      );

      if (ctx.assistant?.registerCapability) {
        await ctx.assistant.registerCapability(
          {
            id: "resources.get",
            description: "Read current CPU, RAM, and optional GPU and system-volume disk usage percents from the host.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          async () => {
            const snapshot = await collectSnapshot(ctx);
            return {
              cpuPercent: snapshot.cpu,
              ramPercent: snapshot.ram,
              gpuPercent: snapshot.gpu,
              ssdPercent: snapshot.ssd,
            };
          },
        );
      }
    },
    async stop(ctx) {
      if (!ctx) return;
      pollActive.set(ctx, false);
      scheduleGenerations.set(ctx, (scheduleGenerations.get(ctx) ?? 0) + 1);
      try {
        await ctx.schedule.cancel(SCHEDULE_ID);
      } catch {}
      await hideHud(ctx);
    },
  });
}
