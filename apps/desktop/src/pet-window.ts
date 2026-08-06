import { app, BrowserWindow, ipcMain, Menu, screen, type IpcMainEvent } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getAppStateSnapshot, markPetBroken, type PetScaleValue } from "./app-state.js";
import { clampToNearestDisplayIfOffscreen, clampToVisibleWorkArea, defaultPetWindowSize, getDefaultPetInitialPosition, isCrossDisplayRoamingEnabled, type Point } from "./display.js";
import { builtInPet } from "./built-in-pet.js";
import { getInstalledPetDir } from "./pet-paths.js";
import { getActiveLocale, getActiveLocaleLang, t } from "./i18n/index.js";
import { defaultMediaDurationMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { pickReactionMessage } from "./reaction-messages.js";
import { debug, error as logError, info, warn } from "./logger.js";
import { executeDefaultPetPluginCommand, executeDefaultPetPluginMenuSelect, getDefaultPetPluginCommands, getDefaultPetPluginMenuItems } from "./plugin-service.js";
import type { ActiveBubble } from "./plugin-bubble-arbiter.js";
import type { PluginBubbleIndicator, PluginCommandForm, PluginBubbleHud, PluginBubbleHudItem } from "./plugin-sdk-bridge.js";
import { defaultPetSprite, getConfiguredSpriteCacheKey, getConfiguredSpriteStates, motionToSpriteState, resolveReactionSpriteState, type PetMotionState, type SpriteStateDefinition, type UniversalSpriteState } from "./reaction-animation-mapping.js";
import { isFocusActionAvailable } from "./capabilities.js";
import { canForwardMouseEvents as platformCanForwardMouseEvents, shouldWatchForwardedMouseEvents } from "./mouse-forwarding.js";
import { computeEffectiveWaylandBackend, shouldPetWindowBeFocusable } from "./wayland-backend.js";

export interface PetWindowInteractionHooks {
  readonly onBubbleDismissed?: (dismissToken: string) => void;
  readonly onBubbleAction?: (dismissToken: string, actionId: string) => void;
  readonly onBubbleSubmit?: (dismissToken: string, values: Record<string, string | number>) => void;
  readonly onPetEvent?: (name: string, payload: Record<string, unknown>) => void;
}

export interface DefaultPetWindowOptions extends PetWindowInteractionHooks {
  readonly position: Point;
  readonly paused: boolean;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly pluginBubbles?: PetPluginBubbles | null;
  readonly onPositionChanged: (position: Point) => void;
  readonly onHideRequested: () => void;
}

export interface AgentPetWindowOptions extends PetWindowInteractionHooks {
  readonly petId: string;
  readonly displayName: string;
  readonly scale: PetScaleValue;
  readonly position: Point;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly onCloseRequested: () => void;
  /** Skip the right-click plugin command section (plugin-spawned pets). */
  readonly plainContextMenu?: boolean;
  /**
   * Optional callback to bring the associated terminal session window to focus.
   * When provided, a "Focus session window" item is added to the right-click menu.
   */
  readonly onFocusSessionWindow?: () => void;
}

/** Plugin-arbiter bubble content for one pet surface (both slots). */
export interface PetPluginBubbles {
  readonly transient: ActiveBubble | null;
  readonly pinned: ActiveBubble | null;
}

export interface PetTransientDisplay {
  readonly reaction?: OpenPetsReaction;
  readonly message?: string;
  readonly reactionMessage?: string;
  readonly suppressReactionMessage?: boolean;
  readonly dismissToken?: string;
  /** Absolute path to a validated local image shown inside the bubble (pet.showMedia). */
  readonly mediaPath?: string;
  /** Explicit display duration override for media bubbles, already clamped by the IPC layer. */
  readonly displayDurationMs?: number;
  /** Validated URL opened via shell when the media bubble is clicked (pet.showMedia). */
  readonly clickUrl?: string;
}

/** Validated pet.showMedia request payload shared by the default/agent controllers. */
export interface PetShowMediaOptions {
  readonly mediaPath: string;
  readonly message?: string;
  readonly reaction?: OpenPetsReaction;
  readonly durationMs?: number;
  readonly clickUrl?: string;
}

export type PetStatusBadgeReaction = Exclude<OpenPetsReaction, "idle">;

interface PetContentRender {
  readonly html: string;
  readonly bodyHtml: string;
  readonly reactionState: UniversalSpriteState;
  readonly cacheKey: string;
}

const petWindowRenderCache = new WeakMap<BrowserWindow, string>();

const windowLoadChains = new WeakMap<BrowserWindow, Promise<void>>();
const windowLoadSequences = new WeakMap<BrowserWindow, number>();
const petWindowFocusPolicy = new WeakMap<BrowserWindow, boolean>();
const petMouseInteropRecovery = new WeakMap<BrowserWindow, (reason: string) => void>();
const petWindowDragging = new WeakMap<BrowserWindow, boolean>();

/**
 * Returns true when Electron is effectively running on the native Wayland
 * backend (ozone-platform=wayland). Under x11/XWayland this returns false
 * even on a Wayland session, because the positioning and z-order APIs work.
 *
 * Must be called after app is ready (after main.ts has appended the switch).
 * Cached on first call so window-creation cost is negligible.
 */
let _effectiveWaylandBackendCache: boolean | undefined;
export function isEffectiveWaylandBackend(): boolean {
  if (_effectiveWaylandBackendCache !== undefined) return _effectiveWaylandBackendCache;
  // Delegate to the pure, Electron-free decision in wayland-backend.ts so the
  // exact production logic is unit-testable without importing this module.
  const result = computeEffectiveWaylandBackend(
    process.platform,
    app.commandLine.getSwitchValue("ozone-platform"),
    process.env.XDG_SESSION_TYPE,
    process.env.WAYLAND_DISPLAY,
  );
  _effectiveWaylandBackendCache = result;
  return result;
}

export function _resetEffectiveWaylandBackendCache(): void {
  _effectiveWaylandBackendCache = undefined;
}

/**
 * Whether to use Wayland native window-move drag instead of the manual
 * setBounds drag path.  Under x11/XWayland the manual path works correctly.
 */
export function shouldUseWaylandNativePetDrag(): boolean {
  return isEffectiveWaylandBackend();
}

export function isPetWindowDragging(window: BrowserWindow): boolean {
  return petWindowDragging.get(window) === true;
}

export function createDefaultPetWindow(options: DefaultPetWindowOptions, dismissToken?: string): BrowserWindow {
  const window = createBasePetWindow("OpenPets — Default Pet", options.position, {
    hasInteractiveInput: petPluginBubblesHaveInteractiveInput(options.pluginBubbles ?? null),
  });
  info("pet.window", "default window create", { windowId: window.id, position: options.position, paused: options.paused, hasDisplay: Boolean(options.display), badge: options.badge });
  installMousePassthroughAndDrag(window, options);
  installMotionStatePublisher(window);
  installPetContextMenu(window, { label: t("pet.menu.hidePet"), click: options.onHideRequested, defaultPet: true });

  const savePosition = debounce(() => {
    if (window.isDestroyed()) {
      return;
    }

    options.onPositionChanged(readWindowPosition(window));
  }, 150);

  window.on("move", savePosition);
  window.on("moved", savePosition);
  window.on("close", () => {
    info("pet.window", "default window close", { windowId: window.id, position: readWindowPosition(window) });
    options.onPositionChanged(readWindowPosition(window));
  });

  void loadDefaultPetContent(window, options.paused, options.display, options.badge, dismissToken, options.pluginBubbles ?? null);

  return window;
}

export function createAgentPetWindow(options: AgentPetWindowOptions, dismissToken?: string): BrowserWindow {
  const window = createBasePetWindow(`OpenPets — ${options.displayName}`, options.position);
  info("pet.window", "agent window create", { windowId: window.id, petId: options.petId, displayName: options.displayName, position: options.position, hasDisplay: Boolean(options.display), badge: options.badge });
  installMousePassthroughAndDrag(window, options);
  installMotionStatePublisher(window);
  installPetContextMenu(window, { label: t("pet.menu.closePet"), click: options.onCloseRequested, focusSessionWindow: options.onFocusSessionWindow });
  void loadExplicitPetContent(window, options.petId, options.display, options.badge, dismissToken, options.scale);
  return window;
}

export function recoverPetMouseInterop(window: BrowserWindow, reason: string): void {
  if (window.isDestroyed()) return;
  const recover = petMouseInteropRecovery.get(window);
  if (recover) {
    recover(reason);
    return;
  }

  debug("pet.window", "mouse interop recovery skipped", { windowId: window.id, reason, skippedReason: "unregistered-window" });
}

function installPetContextMenu(window: BrowserWindow, action: { readonly label: string; readonly click: () => void; readonly defaultPet?: boolean; readonly focusSessionWindow?: () => void }): void {
  const webContents = window.webContents;
  const handleContextMenu = (event: Electron.Event): void => {
    event.preventDefault();
    if (window.isDestroyed()) return;
    void buildPetContextMenuTemplate(action).then((template) => Menu.buildFromTemplate(template).popup({ window })).catch((error) => { logError("pet.window", "context menu build failed", error); Menu.buildFromTemplate([{ label: action.label, click: action.click }]).popup({ window }); });
  };
  webContents.on("context-menu", handleContextMenu);
  window.once("closed", () => {
    if (!webContents.isDestroyed()) webContents.off("context-menu", handleContextMenu);
  });
}

async function buildPetContextMenuTemplate(action: { readonly label: string; readonly click: () => void; readonly defaultPet?: boolean; readonly focusSessionWindow?: () => void }): Promise<Electron.MenuItemConstructorOptions[]> {
  if (!action.defaultPet) {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (action.focusSessionWindow) {
      const a11yReady = isFocusActionAvailable();
      const focusLabel = a11yReady
        ? t("pet.menu.focusSessionWindow")
        : t("pet.menu.focusSessionWindowNoA11y");
      template.push({ label: focusLabel, click: action.focusSessionWindow }, { type: "separator" });
    }
    template.push({ label: action.label, click: action.click });
    return template;
  }
  const commands = await getDefaultPetPluginCommands();
  const topLevel: Electron.MenuItemConstructorOptions[] = [];
  const plugins = new Map<string, { name: string; commands: Electron.MenuItemConstructorOptions[] }>();
  const sorted = [...commands].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const command of sorted) {
    const item: Electron.MenuItemConstructorOptions = { label: command.commandTitle, click: () => { if (command.form) openPluginCommandForm(command).catch((error) => logError("pet.window", "plugin command form failed", error)); else executeDefaultPetPluginCommand(command.pluginId, command.commandId).catch((error) => logError("pet.window", "plugin command failed", error)); } };
    if (command.placement === "top" || command.featured) { topLevel.push(item); continue; }
    const group = plugins.get(command.pluginId) ?? { name: command.pluginName, commands: [] };
    group.commands.push(item);
    plugins.set(command.pluginId, group);
  }
  // Fully dynamic per-plugin menu sections (ui.menu.setItems).
  const menuItems = await getDefaultPetPluginMenuItems();
  for (const item of menuItems) {
    const group = plugins.get(item.pluginId) ?? { name: item.pluginName, commands: [] };
    group.commands.push({ label: item.title, enabled: item.enabled !== false, type: item.checked === true ? "checkbox" : "normal", checked: item.checked === true ? true : undefined, click: () => { executeDefaultPetPluginMenuSelect(item.pluginId, item.itemId).catch((error) => logError("pet.window", "plugin menu select failed", error)); } });
    plugins.set(item.pluginId, group);
  }
  const template: Electron.MenuItemConstructorOptions[] = [];
  const openControlCenter = (route: "dashboard" | "plugins"): void => {
    import("./windows.js").then(({ openControlCenterWindow }) => openControlCenterWindow(route)).catch((error) => logError("pet.window", "open control center failed", error));
  };
  if (topLevel.length > 0) template.push(...topLevel.slice(0, 8), { type: "separator" });
  if (plugins.size > 0) template.push(...[...plugins.values()].map((plugin) => ({ label: plugin.name, submenu: plugin.commands })), { type: "separator" });
  template.push(
    { label: t("tray.plugins"), click: () => openControlCenter("plugins") },
    { label: t("pet.menu.openControlCenter"), click: () => openControlCenter("dashboard") },
    { label: action.label, click: action.click },
  );
  return template;
}

async function openPluginCommandForm(command: { readonly pluginId: string; readonly commandId: string; readonly commandTitle: string; readonly form?: PluginCommandForm }): Promise<void> {
  if (!command.form) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) ?? screen.getPrimaryDisplay();
  const maxWidth = Math.max(420, display.workArea.width - 48);
  const maxHeight = Math.max(360, display.workArea.height - 48);
  const width = Math.min(620, maxWidth);
  const height = Math.min(Math.max(380, estimatePluginCommandFormHeight(command.form)), maxHeight);
  const window = new BrowserWindow({
    title: command.commandTitle,
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: BrowserWindow.getFocusedWindow() ?? undefined,
    modal: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: `${app.getAppPath()}/plugin-command-form-preload.cjs` },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const token = `plugin-command-form-${window.id}`;
  const resizeToken = `plugin-command-form-resize-${window.id}`;
  ipcMain.handle(token, async (event, values: unknown) => {
    if (event.sender !== window.webContents) throw new Error("Invalid command form sender.");
    const result = await executeDefaultPetPluginCommand(command.pluginId, command.commandId, isRecord(values) ? values : {});
    if (!window.isDestroyed()) window.close();
    return result;
  });
  ipcMain.on(resizeToken, (event, size: unknown) => {
    if (event.sender !== window.webContents || window.isDestroyed() || !isRecord(size)) return;
    const nextWidth = clampNumber(Number(size.width), 420, maxWidth);
    const nextHeight = clampNumber(Number(size.height), 260, maxHeight);
    const [currentWidth, currentHeight] = window.getContentSize();
    if (Math.abs(currentWidth - nextWidth) < 8 && Math.abs(currentHeight - nextHeight) < 8) return;
    window.setContentSize(Math.round(nextWidth), Math.round(nextHeight));
    const bounds = window.getBounds();
    const nextX = Math.min(Math.max(bounds.x, display.workArea.x), display.workArea.x + display.workArea.width - bounds.width);
    const nextY = Math.min(Math.max(bounds.y, display.workArea.y), display.workArea.y + display.workArea.height - bounds.height);
    if (nextX !== bounds.x || nextY !== bounds.y) window.setPosition(Math.round(nextX), Math.round(nextY));
  });
  window.once("closed", () => {
    ipcMain.removeHandler(token);
    ipcMain.removeAllListeners(resizeToken);
  });
  await window.loadURL(buildPluginCommandFormUrl(command.commandTitle, command.form, token, resizeToken));
  window.show();
}

function estimatePluginCommandFormHeight(form: PluginCommandForm): number {
  const fieldHeight = form.fields.reduce((total, field) => total + (field.type === "textarea" || field.type === "list" ? 170 : field.type === "boolean" ? 76 : 100), 0);
  return 170 + fieldHeight;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildPluginCommandFormUrl(title: string, form: PluginCommandForm, channel: string, resizeChannel: string): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const data = JSON.stringify({ title, form, channel, resizeChannel }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}html,body{margin:0;min-width:0}body{font:14px system-ui,"Hiragino Sans","Yu Gothic","Malgun Gothic","Apple SD Gothic Neo","PingFang SC","PingFang TC","Microsoft YaHei","Microsoft JhengHei","Noto Sans CJK JP","Noto Sans CJK KR","Noto Sans CJK SC","Noto Sans CJK TC",sans-serif;background:#fff;color:#161616;overflow:hidden}.wrap{padding:24px}h1{font-size:20px;line-height:1.2;margin:0 0 18px}.field{margin-top:14px}label{display:block;font-weight:700;margin:0 0 7px}.hint{display:block;color:#64748b;font-size:12px;line-height:1.35;margin-top:5px}input,textarea,select{width:100%;border:1px solid #aeb8c8;border-radius:10px;padding:11px 12px;font:inherit;outline:none;background:white;color:#161616}input:focus,textarea:focus,select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.16)}textarea{min-height:148px;resize:vertical}.check{display:flex;align-items:center;gap:10px;font-weight:700}.check input{width:auto}.error{color:#b00020;min-height:20px;margin-top:10px}.buttons{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}button{border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:700}button.primary{background:#2563eb;color:white}</style></head><body><form class="wrap"><h1></h1><div id="fields"></div><div class="error" role="alert"></div><div class="buttons"><button type="button" id="cancel">${escapeHtml(t("common.cancel"))}</button><button class="primary" type="submit"></button></div></form><script>const data=${data};const api=window.openPetsCommandForm;const form=document.querySelector('form'),fields=document.getElementById('fields'),err=document.querySelector('.error');document.querySelector('h1').textContent=data.title;document.querySelector('.primary').textContent=data.form.submitLabel||'Set';const values={};function resize(){requestAnimationFrame(()=>{const root=document.documentElement;api.resize(data.resizeChannel,{width:Math.ceil(Math.max(root.scrollWidth,document.body.scrollWidth)+2),height:Math.ceil(Math.max(root.scrollHeight,document.body.scrollHeight)+2)});});}function addOption(select,option){const el=document.createElement('option');el.value=option.value;el.textContent=option.label||option.value;select.appendChild(el);}for(const f of data.form.fields){const box=document.createElement('div');box.className='field';const label=document.createElement('label');label.textContent=f.label;label.htmlFor=f.id;let input;if(f.type==='textarea'){input=document.createElement('textarea');}else if(f.type==='select'){input=document.createElement('select');for(const option of f.options||[])addOption(input,option);}else if(f.type==='boolean'){label.className='check';input=document.createElement('input');input.type='checkbox';label.prepend(input);}else{input=document.createElement('input');if(f.type==='number')input.type='number';else if(f.type==='time')input.type='time';else if(f.type==='date')input.type='date';else input.type='text';}input.id=f.id;input.name=f.id;if(f.default!==undefined){if(input.type==='checkbox')input.checked=Boolean(f.default);else input.value=f.default;}if(f.min!==undefined)input.min=f.min;if(f.max!==undefined)input.max=f.max;if(f.maxLength!==undefined)input.maxLength=f.maxLength;if(f.required)input.required=true;if(f.type==='boolean'){box.append(label);}else{box.append(label,input);}fields.append(box);input.addEventListener('input',resize);}new ResizeObserver(resize).observe(document.body);resize();form.addEventListener('submit',async(event)=>{event.preventDefault();err.textContent='';for(const f of data.form.fields){const el=form.elements[f.id];values[f.id]=el.type==='number'?Number(el.value):el.type==='checkbox'?Boolean(el.checked):el.value;}try{await api.submit(data.channel,values);}catch(error){err.textContent=String(error&&error.message||error);resize();}});document.getElementById('cancel').addEventListener('click',()=>api.close());</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function installMousePassthroughAndDrag(window: BrowserWindow, hooks: PetWindowInteractionHooks = {}): void {
  const { onBubbleDismissed, onBubbleAction, onBubbleSubmit, onPetEvent } = hooks;
  const windowId = window.id;
  const useWaylandNativeDrag = shouldUseWaylandNativePetDrag();
  if (useWaylandNativeDrag) {
    debug("pet.window", "Wayland native pet drag enabled", { windowId });
  }
  let dragging: { readonly startScreenX: number; readonly startScreenY: number; readonly startWindowX: number; readonly startWindowY: number; readonly width: number; readonly height: number } | null = null;
  let rendererReady = false;
  let listenersRemoved = false;
  let lastInteractive = false;
  let forwardingWatchTimer: NodeJS.Timeout | null = null;
  const rearmTimers = new Set<NodeJS.Timeout>();
  const webContents = window.webContents;
  const canForwardMouseEvents = platformCanForwardMouseEvents(process.platform);

  const scheduleMouseInteropRecovery = (reason: string): void => {
    if (window.isDestroyed()) return;
    dragging = null;
    rendererReady = false;
    lastInteractive = false;
    clearRearmTimers();
    debug("pet.window", "mouse interop recovery", { windowId, reason });
    setPassthrough(false);
    if (process.platform === "win32") {
      requestCursorHitTestProbe(reason);
      scheduleWindowsMouseForwardingRearm(`${reason}+250ms`, 250);
      scheduleWindowsMouseForwardingRearm(`${reason}+500ms`, 500);
      scheduleWindowsMouseForwardingRearm(`${reason}+1000ms`, 1_000);
      scheduleWindowsMouseForwardingRearm(`${reason}+1500ms`, 1_500);
      return;
    }

    rearmPassthrough(reason);
  };

  const isFromWindow = (event: IpcMainEvent): boolean => event.sender === webContents;
  const setPassthrough = (passthrough: boolean): void => {
    if (window.isDestroyed()) return;
    if (process.platform === "linux") {
      // Electron does not support forwarded mouse events on Linux, so ignored
      // windows cannot receive the renderer events required to start dragging.
      // Keep Linux pet windows interactive; this trades click-through for reliable drag.
      window.setIgnoreMouseEvents(false);
      return;
    }

    if (passthrough && canForwardMouseEvents) window.setIgnoreMouseEvents(true, { forward: true });
    else if (passthrough) window.setIgnoreMouseEvents(true);
    else window.setIgnoreMouseEvents(false);
  };

  const clearRearmTimers = (): void => {
    for (const timer of rearmTimers) clearTimeout(timer);
    rearmTimers.clear();
  };

  const clearForwardingWatch = (): void => {
    if (!forwardingWatchTimer) return;
    clearTimeout(forwardingWatchTimer);
    forwardingWatchTimer = null;
  };

  const getCursorProbe = (): { readonly inside: boolean; readonly cursor: Point; readonly bounds: Electron.Rectangle; readonly clientX: number; readonly clientY: number } => {
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getContentBounds();
    const clientX = cursor.x - bounds.x;
    const clientY = cursor.y - bounds.y;
    return {
      cursor,
      bounds,
      clientX,
      clientY,
      inside: clientX >= 0 && clientX < bounds.width && clientY >= 0 && clientY < bounds.height,
    };
  };

  const requestCursorHitTestProbe = (reason: string, logProbe = true): void => {
    if (window.isDestroyed() || webContents.isDestroyed()) return;
    const probe = getCursorProbe();
    if (logProbe) debug("pet.window", "cursor hit-test probe", { windowId, reason, inside: probe.inside, cursor: probe.cursor, bounds: probe.bounds });
    if (!probe.inside) return;
    webContents.send("openpets:pet-probe-hit-test", { clientX: probe.clientX, clientY: probe.clientY, reason });
  };

  const rearmMouseForwarding = (reason: string, logRearm = true): void => {
    if (window.isDestroyed()) return;
    if (dragging || lastInteractive) {
      if (logRearm) debug("pet.window", "mouse forwarding rearm skipped", { windowId, reason, dragging: Boolean(dragging), interactive: lastInteractive });
      return;
    }
    if (logRearm) debug("pet.window", "mouse forwarding rearm", { windowId, reason });
    window.setIgnoreMouseEvents(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    requestCursorHitTestProbe(reason, logRearm);
  };

  const scheduleWindowsMouseForwardingRearm = (reason: string, delayMs: number): void => {
    const timer = setTimeout(() => {
      rearmTimers.delete(timer);
      rearmMouseForwarding(reason);
    }, delayMs);
    rearmTimers.add(timer);
  };

  const scheduleForwardingWatch = (reason: string): void => {
    if (!shouldWatchForwardedMouseEvents(process.platform) || forwardingWatchTimer || dragging || lastInteractive || window.isDestroyed()) return;
    forwardingWatchTimer = setTimeout(() => {
      forwardingWatchTimer = null;
      if (window.isDestroyed() || dragging || lastInteractive) return;
      if (getCursorProbe().inside) rearmMouseForwarding(reason, false);
      scheduleForwardingWatch(reason);
    }, 750);
    forwardingWatchTimer.unref?.();
  };

  const rearmPassthrough = (reason: string): void => {
    if (window.isDestroyed()) return;
    if (process.platform !== "win32") {
      setPassthrough(true);
      // macOS also depends on forwarded mouse events, and the WindowServer can
      // stop delivering them across Space switches / display sleep. Probe the
      // cursor now and keep the watchdog armed so the pet cannot get stuck
      // click-through with no way back to interactive.
      if (canForwardMouseEvents) {
        requestCursorHitTestProbe(reason);
        scheduleForwardingWatch(reason);
      }
      return;
    }

    // On Windows, rapid pet HTML reloads can leave Chromium's forwarded mouse
    // tracking stale while the cursor is already over the transparent window.
    // Toggle immediately, probe the current cursor hit target, then repeat the
    // toggle shortly after load because Windows sometimes re-registers mouse
    // forwarding after Chromium finishes late compositing work.
    rearmMouseForwarding(reason);
    scheduleWindowsMouseForwardingRearm(`${reason}+75ms`, 75);
    scheduleWindowsMouseForwardingRearm(`${reason}+175ms`, 175);
  };

  const rearmPassthroughAfterLoad = (): void => {
    rearmPassthrough("did-finish-load");
  };

  const handleHitTest = (event: IpcMainEvent, interactive: unknown, source: unknown): void => {
    if (!isFromWindow(event)) return;
    rendererReady = true;
    lastInteractive = Boolean(interactive);
    const sourceName = typeof source === "string" ? source : undefined;
    if (sourceName !== "idle-forwarding-watch" || lastInteractive) debug("pet.window", "hit test", { windowId, interactive: lastInteractive, dragging, source: sourceName });
    setPassthrough(!lastInteractive && !dragging);
    if (lastInteractive || dragging) clearForwardingWatch();
    else scheduleForwardingWatch("idle-forwarding-watch");
  };

  const handleReady = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    rendererReady = true;
    setPassthrough(true);
    scheduleForwardingWatch("ready-forwarding-watch");
  };

  const handleDragStart = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !isScreenPoint(point) || window.isDestroyed()) return;
    if (useWaylandNativeDrag) {
      debug("pet.window", "manual drag start ignored on Wayland native drag", { windowId });
      return;
    }
    const startBounds = window.getBounds();
    dragging = { startScreenX: point.screenX, startScreenY: point.screenY, startWindowX: startBounds.x, startWindowY: startBounds.y, width: startBounds.width, height: startBounds.height };
    petWindowDragging.set(window, true);
    debug("pet.window", "drag start", { windowId, point, startBounds });
    clearForwardingWatch();
    setPassthrough(false);
    onPetEvent?.("pet:dragStart", {});
  };

  const handleDragMove = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !dragging || !isScreenPoint(point) || window.isDestroyed()) return;
    if (useWaylandNativeDrag) {
      debug("pet.window", "manual drag move ignored on Wayland native drag", { windowId });
      return;
    }
    const nextX = dragging.startWindowX + Math.round(point.screenX - dragging.startScreenX);
    const nextY = dragging.startWindowY + Math.round(point.screenY - dragging.startScreenY);
    window.setBounds({ x: nextX, y: nextY, width: dragging.width, height: dragging.height }, false);
  };

  const handleDragEnd = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    if (useWaylandNativeDrag) {
      debug("pet.window", "manual drag end ignored on Wayland native drag", { windowId });
      return;
    }
    const wasDragging = dragging !== null;
    dragging = null;
    petWindowDragging.set(window, false);
    debug("pet.window", "drag end", { windowId, position: window.isDestroyed() ? null : readWindowPosition(window) });
    if (wasDragging) onPetEvent?.("pet:dragEnd", {});
  };

  const handleBubbleDismissed = (event: IpcMainEvent, dismissToken: unknown): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "bubble dismissed", { windowId, dismissToken });
    if (typeof dismissToken === "string") onBubbleDismissed?.(dismissToken);
  };

  const handleBubbleAction = (event: IpcMainEvent, dismissToken: unknown, actionId: unknown): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "bubble action", { windowId, dismissToken, actionId });
    if (typeof dismissToken === "string" && typeof actionId === "string" && actionId.length <= 64) onBubbleAction?.(dismissToken, actionId);
  };

  const handleBubbleSubmit = (event: IpcMainEvent, dismissToken: unknown, values: unknown): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "bubble submit", { windowId, dismissToken });
    if (typeof dismissToken !== "string" || typeof values !== "object" || values === null) return;
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>).slice(0, 8)) {
      if (typeof value === "string" && value.length <= 1000) out[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    onBubbleSubmit?.(dismissToken, out);
  };

  const allowedPetEventNames = new Set(["pet:clicked", "pet:doubleClicked", "pet:hover", "pet:drop"]);
  const handlePetEvent = (event: IpcMainEvent, name: unknown, payload: unknown): void => {
    if (!isFromWindow(event)) return;
    if (typeof name !== "string" || !allowedPetEventNames.has(name)) return;
    const data = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (name !== "pet:hover") debug("pet.window", "pet event", { windowId, name });
    onPetEvent?.(name, data);
  };

  const resetForNavigation = (): void => {
    dragging = null;
    petWindowDragging.set(window, false);
    rendererReady = false;
    lastInteractive = false;
    clearRearmTimers();
    debug("pet.window", "navigation reset passthrough", { windowId });
    setPassthrough(false);
  };

  const rearmAfterLoad = (): void => {
    dragging = null;
    petWindowDragging.set(window, false);
    lastInteractive = false;
    debug("pet.window", "load rearm passthrough", { windowId });
    rearmPassthroughAfterLoad();
  };

  const handleDomReady = (): void => {
    if (!rendererReady) setPassthrough(true);
  };

  const handleLoadFailure = (): void => {
    dragging = null;
    lastInteractive = false;
    debug("pet.window", "load failure rearm passthrough", { windowId });
    setPassthrough(true);
  };

  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    ipcMain.off("openpets:pet-ready", handleReady);
    ipcMain.off("openpets:pet-hit-test", handleHitTest);
    ipcMain.off("openpets:pet-drag-start", handleDragStart);
    ipcMain.off("openpets:pet-drag-move", handleDragMove);
    ipcMain.off("openpets:pet-drag-end", handleDragEnd);
    ipcMain.off("openpets:bubble-dismissed", handleBubbleDismissed);
    ipcMain.off("openpets:bubble-action", handleBubbleAction);
    ipcMain.off("openpets:bubble-submit", handleBubbleSubmit);
    ipcMain.off("openpets:pet-event", handlePetEvent);
    clearRearmTimers();
    clearForwardingWatch();
    petMouseInteropRecovery.delete(window);
    petWindowDragging.delete(window);
    if (!webContents.isDestroyed()) {
      webContents.off("did-start-navigation", resetForNavigation);
      webContents.off("did-start-loading", resetForNavigation);
      webContents.off("did-finish-load", rearmAfterLoad);
      webContents.off("dom-ready", handleDomReady);
      webContents.off("did-fail-load", handleLoadFailure);
    }
  };

  petMouseInteropRecovery.set(window, scheduleMouseInteropRecovery);

  ipcMain.on("openpets:pet-ready", handleReady);
  ipcMain.on("openpets:pet-hit-test", handleHitTest);
  ipcMain.on("openpets:pet-drag-start", handleDragStart);
  ipcMain.on("openpets:pet-drag-move", handleDragMove);
  ipcMain.on("openpets:pet-drag-end", handleDragEnd);
  ipcMain.on("openpets:bubble-dismissed", handleBubbleDismissed);
  ipcMain.on("openpets:bubble-action", handleBubbleAction);
  ipcMain.on("openpets:bubble-submit", handleBubbleSubmit);
  ipcMain.on("openpets:pet-event", handlePetEvent);
  webContents.on("did-start-navigation", resetForNavigation);
  webContents.on("did-start-loading", resetForNavigation);
  webContents.on("did-finish-load", rearmAfterLoad);
  webContents.on("dom-ready", handleDomReady);
  webContents.on("did-fail-load", handleLoadFailure);
  window.on("close", removeListeners);
  window.once("closed", removeListeners);
}

function isScreenPoint(value: unknown): value is { readonly screenX: number; readonly screenY: number } {
  return typeof value === "object" && value !== null && typeof (value as { readonly screenX?: unknown }).screenX === "number" && typeof (value as { readonly screenY?: unknown }).screenY === "number";
}

function createBasePetWindow(title: string, position: Point, focusOptions: { readonly hasInteractiveInput?: boolean } = {}): BrowserWindow {
  const effectiveWaylandBackend = isEffectiveWaylandBackend();
  const focusable = shouldPetWindowBeFocusable(process.platform, effectiveWaylandBackend, focusOptions.hasInteractiveInput === true);
  const window = new BrowserWindow({
    title,
    width: defaultPetWindowSize.width,
    height: defaultPetWindowSize.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), "pet-preload.cjs"),
    },
  });

  petWindowFocusPolicy.set(window, focusable);
  window.setMenu(null);
  applyPetAlwaysOnTop(window);
  window.on("show", () => applyPetAlwaysOnTop(window));
  window.on("restore", () => applyPetAlwaysOnTop(window));

  // Windows silently strips HWND_TOPMOST from other windows when an app
  // enters fullscreen (browser video, games) and never restores it, and no
  // Electron event fires when that happens — the pet stays buried behind
  // normal windows until the user manually toggles it. Periodic re-assertion
  // is the only reliable recovery, and matches the macOS visibleOnFullScreen
  // intent below. The shell's demotion sweep re-strips the flag every ~2-4s
  // while a fullscreen app is foreground (measured: a forced re-assert held
  // for ~2-3s before being swept), so a 1s cadence keeps the pet on top of
  // fullscreen content with sub-second gaps at worst; the two SetWindowPos
  // calls per tick are negligible.
  if (process.platform === "win32") {
    const topmostTimer = setInterval(() => {
      if (window.isDestroyed()) {
        clearInterval(topmostTimer);
        return;
      }
      if (window.isVisible()) applyPetAlwaysOnTop(window);
    }, 1_000);
    window.on("closed", () => clearInterval(topmostTimer));
  }

  // Show the pet window on all macOS Spaces (desktop workspaces).
  // Without this, the window is bound to the Space where it was created
  // and disappears when the user switches to another Space.
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedPetDocumentUrl(url)) return;
    event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    logError("pet.window", "renderer load failed", { windowId: window.id, errorCode, errorDescription });
    console.error("Failed to load default pet window.", { errorCode, errorDescription });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { windowId: window.id, level, line, sourceId, message };
    if (level >= 3) logError("pet.window", "renderer console", fields);
    else if (level === 2) warn("pet.window", "renderer console", fields);
    else debug("pet.window", "renderer console", fields);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("pet.window", "renderer process gone", { windowId: window.id, details });
    console.error("Default pet renderer process gone.", details);
  });

  return window;
}

function applyPetAlwaysOnTop(window: BrowserWindow): void {
  if (window.isDestroyed()) return;

  // On Windows the shell strips WS_EX_TOPMOST behind Electron's back
  // (fullscreen apps), but Electron's cached always-on-top state still says
  // "on", so a plain setAlwaysOnTop(true) short-circuits without reaching the
  // OS — verified live: the flag stayed off for minutes of re-asserts. Drop
  // the cached flag first so the re-assert issues a real SetWindowPos.
  if (process.platform === "win32" && window.isAlwaysOnTop()) {
    window.setAlwaysOnTop(false);
  }

  window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");

  if (process.platform === "linux") {
    window.setVisibleOnAllWorkspaces(true);
  }
}

export async function loadDefaultPetContent(window: BrowserWindow, paused: boolean, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): Promise<void> {
  const sequence = allocateWindowLoadSequence(window);
  debug("pet.window", "default content render begin", { windowId: window.id, sequence, paused, hasDisplay: Boolean(display), reaction: display?.reaction, hasMessage: Boolean(display?.message), badge, hasPluginBubble: Boolean(pluginBubbles?.transient), hasPinned: Boolean(pluginBubbles?.pinned), defaultPetId: getAppStateSnapshot().preferences.defaultPetId });
  applyPetWindowFocusPolicy(window, petPluginBubblesHaveInteractiveInput(pluginBubbles));
  const render = await createDefaultPetRender(paused, display, badge, dismissToken, pluginBubbles);
  applyLinuxPetWindowShape(window, getAppStateSnapshot().preferences.petScale as PetScaleValue, Boolean(display?.message || display?.reactionMessage || display?.reaction || display?.mediaPath || badge || paused || pluginBubbles?.transient || pluginBubbles?.pinned));
  if (tryUpdateLoadedPetContent(window, render, "default", sequence)) return;
  await loadPetHtmlFile(window, render.html, "default", sequence).then(() => {
    petWindowRenderCache.set(window, render.cacheKey);
  }).catch((error: unknown) => {
    logError("pet.window", "default content load failed", error instanceof Error ? error : { error });
    console.error("Failed to load default pet URL.", error);
  });
}

export async function loadExplicitPetContent(window: BrowserWindow, petId: string, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null, dismissToken?: string, scaleOverride?: PetScaleValue, pluginBubbles: PetPluginBubbles | null = null): Promise<void> {
  const sequence = allocateWindowLoadSequence(window);
  try {
    applyPetWindowFocusPolicy(window, petPluginBubblesHaveInteractiveInput(pluginBubbles));
    const state = getAppStateSnapshot();
    const pet = state.pets.installed.find((candidate) => candidate.id === petId);
    if (!pet || pet.broken) {
      throw new Error(`Cannot render explicit pet: ${petId}`);
    }
    debug("pet.window", "explicit content render begin", { windowId: window.id, sequence, petId, displayName: pet.displayName, hasDisplay: Boolean(display), reaction: display?.reaction, hasMessage: Boolean(display?.message), badge });
    const scale = scaleOverride ?? state.preferences.petScale as PetScaleValue;
    const render = pet.id === builtInPet.id
      ? createBuiltInPetRender(false, display, badge, scale, `explicit:${pet.id}`, dismissToken, pluginBubbles)
      : await createInstalledPetRender(pet.id, pet.displayName, false, display, scale, badge, `explicit:${pet.id}`, dismissToken, pluginBubbles);
    applyLinuxPetWindowShape(window, scale, Boolean(display?.message || display?.reactionMessage || display?.reaction || display?.mediaPath || badge || pluginBubbles?.transient || pluginBubbles?.pinned));
    if (tryUpdateLoadedPetContent(window, render, `explicit-${pet.id}`, sequence)) return;
    await loadPetHtmlFile(window, render.html, `explicit-${pet.id}`, sequence);
    petWindowRenderCache.set(window, render.cacheKey);
  } catch (error: unknown) {
    logError("pet.window", "explicit content load failed", error instanceof Error ? error : { petId, error });
    console.error(`Failed to load explicit pet ${petId} URL.`, error);
  }
}

function petPluginBubblesHaveInteractiveInput(pluginBubbles: PetPluginBubbles | null | undefined): boolean {
  return Boolean(pluginBubbles?.transient?.bubble.input || pluginBubbles?.pinned?.bubble.input);
}

function applyPetWindowFocusPolicy(window: BrowserWindow, hasInteractiveInput: boolean): void {
  if (window.isDestroyed()) return;
  const effectiveWaylandBackend = isEffectiveWaylandBackend();
  const focusable = shouldPetWindowBeFocusable(process.platform, effectiveWaylandBackend, hasInteractiveInput);
  if (petWindowFocusPolicy.get(window) === focusable) return;
  try {
    window.setFocusable(focusable);
    petWindowFocusPolicy.set(window, focusable);
    debug("pet.window", "focus policy applied", { windowId: window.id, focusable, hasInteractiveInput, platform: process.platform, effectiveWaylandBackend });
  } catch (error) {
    logError("pet.window", "focus policy failed", error instanceof Error ? error : { windowId: window.id, focusable, hasInteractiveInput, error });
  }
}

export function preparePetTransientDisplay(display: PetTransientDisplay): PetTransientDisplay {
  if (display.suppressReactionMessage) return display;
  if (!display.reaction || display.message || display.reactionMessage) return display;
  return { ...display, reactionMessage: pickReactionMessage(display.reaction, Math.random, getActiveLocale()) };
}

export function mergePetTransientDisplay(current: PetTransientDisplay | null, next: PetTransientDisplay): PetTransientDisplay {
  if (next.message || next.mediaPath || !next.reaction || !current?.message) return preparePetTransientDisplay(next);
  return { ...current, reaction: next.reaction, dismissToken: next.dismissToken ?? current.dismissToken };
}

export function getTransientReactionAnimationMs(display: PetTransientDisplay): number | null {
  if (!display.reaction) return null;
  const state = getReactionSpriteState(display.reaction);
  const row = getConfiguredSpriteStates(getAppStateSnapshot().preferences.waitingAnimationDurationMs)[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  return typeof iterations === "number" ? row.durationMs * iterations : null;
}

export function getTransientDisplayDurationMs(display: PetTransientDisplay): number {
  if (display.displayDurationMs) return display.displayDurationMs;
  if (display.mediaPath) return defaultMediaDurationMs;
  const baseMs = display.reaction === "success" || display.reaction === "error" ? 5_000 : 4_000;
  const message = display.message ?? display.reactionMessage;
  if (!message) return baseMs;
  return Math.min(12_000, Math.max(baseMs, message.length * 70));
}

export function clearTransientReaction(display: PetTransientDisplay): PetTransientDisplay {
  if (!display.reaction) return display;
  return { ...display, reaction: undefined };
}

export function setPetReactionState(window: BrowserWindow, state: UniversalSpriteState): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:pet-reaction-state", state);
}

/** Override the pet sprite with a plugin-bundled spritesheet strip (§5), or clear with null. */
export function setPetSpriteOverride(window: BrowserWindow, override: { readonly filePath: string; readonly fps: number; readonly loop: boolean } | null): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:pet-sprite-override", override ? { fileUrl: pathToFileURL(override.filePath).toString(), fps: override.fps, loop: override.loop } : null);
}

/** Scale override for a single pet window (plugin setScale). */
export function setPetWindowScale(window: BrowserWindow, scale: number): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:pet-scale-override", scale);
}

export type PetWindowAudioPayload = { readonly kind: "named"; readonly name: string; readonly volume: number } | { readonly kind: "data"; readonly dataUrl: string; readonly volume: number };

/** Play a sound through the pet window's WebAudio pipeline. */
export function playPetWindowAudio(window: BrowserWindow, payload: PetWindowAudioPayload): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:play-audio", payload);
}

export function stopPetWindowAudio(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:stop-audio");
}

/** Speak text via the renderer speechSynthesis voice (plugin voice.speak). */
export function speakPetWindowTts(window: BrowserWindow, text: string, opts: { readonly voice?: string; readonly rate?: number }): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:tts-speak", { text, voice: opts.voice, rate: opts.rate });
}

export function stopPetWindowTts(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:tts-stop");
}

function tryUpdateLoadedPetContent(window: BrowserWindow, render: PetContentRender, name: string, sequence: number): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (petWindowRenderCache.get(window) !== render.cacheKey) return false;
  const url = window.webContents.getURL();
  if (!isAllowedPetDocumentUrl(url)) return false;
  debug("pet.window", "content update in place", { windowId: window.id, name, sequence, reactionState: render.reactionState });
  window.webContents.send("openpets:pet-content-state", { bodyHtml: render.bodyHtml, reactionState: render.reactionState });
  return true;
}

export function getSafeDefaultPetPosition(position: Point | undefined): Point {
  const pos = position ?? getDefaultPetInitialPosition();
  if (isCrossDisplayRoamingEnabled()) return clampToNearestDisplayIfOffscreen(pos, defaultPetWindowSize);
  return clampToVisibleWorkArea(pos, defaultPetWindowSize);
}

export function readWindowPosition(window: BrowserWindow): Point {
  const [x, y] = window.getPosition();
  if (isCrossDisplayRoamingEnabled()) return clampToNearestDisplayIfOffscreen({ x, y }, defaultPetWindowSize);
  return clampToVisibleWorkArea({ x, y }, defaultPetWindowSize);
}

function applyLinuxPetWindowShape(window: BrowserWindow, scale: PetScaleValue, hasBubble: boolean): void {
  if (process.platform !== "linux" || window.isDestroyed()) return;

  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const petBottom = 22;
  const hitPadding = 18;
  const petHitboxWidth = scaledWidth + hitPadding * 2;
  const petHitboxHeight = scaledHeight + hitPadding * 2;
  const shape: Electron.Rectangle[] = [
    {
      x: Math.round((defaultPetWindowSize.width - petHitboxWidth) / 2),
      y: Math.round(defaultPetWindowSize.height - Math.max(0, petBottom - hitPadding) - petHitboxHeight),
      width: petHitboxWidth,
      height: petHitboxHeight,
    },
  ];

  if (hasBubble) {
    const bubbleBottom = Math.ceil(petBottom + scaledHeight + 8);
    shape.push({
      x: 0,
      y: Math.max(0, defaultPetWindowSize.height - bubbleBottom - 156),
      width: defaultPetWindowSize.width,
      height: Math.min(156, defaultPetWindowSize.height),
    });
  }

  try {
    window.setShape(shape);
    debug("pet.window", "linux window shape applied", { windowId: window.id, scale, hasBubble, shape });
  } catch (error) {
    logError("pet.window", "linux window shape failed", error instanceof Error ? error : { error });
  }
}

async function createDefaultPetRender(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): Promise<PetContentRender> {
  const installedPetRender = await tryCreateInstalledPetRender(paused, display, badge, dismissToken, pluginBubbles);
  if (installedPetRender) {
    return installedPetRender;
  }

  const scale = getAppStateSnapshot().preferences.petScale as PetScaleValue;
  return createBuiltInPetRender(paused, display, badge, scale, "default:builtin", dismissToken, pluginBubbles);
}

function createBuiltInPetRender(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null, scale: PetScaleValue, cachePrefix: string, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): PetContentRender {
  const spriteUrl = pathToFileURL(join(app.getAppPath(), "assets", defaultPetSprite.fileName)).toString();
  const hasPinned = Boolean(pluginBubbles?.pinned);
  const bodyHtml = createPetBodyMarkup("OpenPets default pet", createBubbleMarkup(display, paused, badge, dismissToken, pluginBubbles), `<div class="sprite" role="img" aria-label="Claude animated default pet"></div>`, createPinnedBubbleMarkup(pluginBubbles), hasPinned);
  const reactionState = getReactionSpriteState(display?.reaction);
  const waitingAnimationDurationMs = getAppStateSnapshot().preferences.waitingAnimationDurationMs;
  const stateRows = getConfiguredSpriteStates(waitingAnimationDurationMs);

  return {
    cacheKey: `${cachePrefix}:${paused}:${scale}:${getConfiguredSpriteCacheKey(waitingAnimationDurationMs)}:${getActiveLocale()}`,
    bodyHtml,
    reactionState,
    html: `<!doctype html>
    <html lang="${getActiveLocaleLang()}" data-reaction-state="${reactionState}" data-motion-state="idle" data-native-pet-drag="${shouldUseWaylandNativePetDrag() ? "wayland" : "manual"}">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; font-src file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenPets Default Pet</title>
        <style>
          ${createPetWindowCss(paused, scale)}
          .sprite {
            width: ${defaultPetSprite.frameWidth}px;
            height: ${defaultPetSprite.frameHeight}px;
            background-image: url("${escapeCssUrl(spriteUrl)}");
            background-size: ${defaultPetSprite.frameWidth * defaultPetSprite.columns}px ${defaultPetSprite.frameHeight * defaultPetSprite.rows}px;
            background-repeat: no-repeat;
            --sprite-row-y: 0px;
            --sprite-frames: ${stateRows.idle.frames};
            --sprite-duration: ${stateRows.idle.durationMs}ms;
            --sprite-iterations: ${stateRows.idle.iterations};
            background-position: 0 var(--sprite-row-y);
            animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);
            animation-play-state: var(--play-state);
            transform: scale(${scale});
            transform-origin: top left;
          }
          ${createSpriteStateCss(".sprite", stateRows)}
          @keyframes pet-frames {
            from { background-position: 0 var(--sprite-row-y); }
            to { background-position: calc(-${defaultPetSprite.frameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
          }
        </style>
      </head>
      <body>
        ${bodyHtml}
      </body>
    </html>`,
  };
}

async function tryCreateInstalledPetRender(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): Promise<PetContentRender | null> {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);

  if (!selected || selected.id === builtInPet.id || selected.broken) {
    return null;
  }

  try {
    return await createInstalledPetRender(selected.id, selected.displayName, paused, display, state.preferences.petScale as PetScaleValue, badge, `default:${selected.id}`, dismissToken, pluginBubbles);
  } catch (error) {
    console.error(`Failed to render installed default pet ${selected.id}; falling back to built-in pet.`, error);
    try {
      markPetBroken(selected.id, error instanceof Error ? error.message : "Installed pet rendering failed.");
    } catch (markError) {
      console.error(`Failed to mark installed pet ${selected.id} broken.`, markError);
    }
    return null;
  }
}

async function createInstalledPetRender(petId: string, displayName: string, paused: boolean, display: PetTransientDisplay | null, scale: PetScaleValue, badge: PetStatusBadgeReaction | null, cachePrefix: string, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): Promise<PetContentRender> {
  const spritesheetPath = join(getInstalledPetDir(petId), "spritesheet.webp");
  const spritesheet = await stat(spritesheetPath);
  if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) {
    throw new Error("Installed pet spritesheet is missing or too large.");
  }

  const imageUrl = pathToFileURL(spritesheetPath).toString();
  const hasPinned = Boolean(pluginBubbles?.pinned);
  const bodyHtml = createPetBodyMarkup(escapeHtml(displayName), createBubbleMarkup(display, paused, badge, dismissToken, pluginBubbles), `<div class="installed-card" role="img" aria-label="${escapeHtml(displayName)}"><div class="installed-sprite"></div></div>`, createPinnedBubbleMarkup(pluginBubbles), hasPinned);
  const reactionState = getReactionSpriteState(display?.reaction);
  const waitingAnimationDurationMs = getAppStateSnapshot().preferences.waitingAnimationDurationMs;
  const stateRows = getConfiguredSpriteStates(waitingAnimationDurationMs);

  return {
    cacheKey: `${cachePrefix}:${paused}:${scale}:${spritesheet.mtimeMs}:${spritesheet.size}:${getConfiguredSpriteCacheKey(waitingAnimationDurationMs)}:${getActiveLocale()}`,
    bodyHtml,
    reactionState,
    html: `<!doctype html>
      <html lang="${getActiveLocaleLang()}" data-reaction-state="${reactionState}" data-motion-state="idle" data-native-pet-drag="${shouldUseWaylandNativePetDrag() ? "wayland" : "manual"}">
        <head>
          <meta charset="utf-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; font-src file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>OpenPets Default Pet</title>
          <style>
            ${createPetWindowCss(paused, scale)}
            .installed-card { width: ${Math.ceil(defaultPetSprite.frameWidth * scale)}px; height: ${Math.ceil(defaultPetSprite.frameHeight * scale)}px; overflow: visible; position: relative; }
            .installed-sprite {
              position: absolute;
              left: 0;
              top: 0;
              width: ${defaultPetSprite.frameWidth}px;
              height: ${defaultPetSprite.frameHeight}px;
              background-image: url("${escapeCssUrl(imageUrl)}");
              background-size: ${defaultPetSprite.frameWidth * defaultPetSprite.columns}px ${defaultPetSprite.frameHeight * defaultPetSprite.rows}px;
              background-repeat: no-repeat;
              --sprite-row-y: 0px;
              --sprite-frames: ${stateRows.idle.frames};
              --sprite-duration: ${stateRows.idle.durationMs}ms;
              --sprite-iterations: ${stateRows.idle.iterations};
              background-position: 0 var(--sprite-row-y);
              animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);
              animation-play-state: var(--play-state);
              transform: scale(${scale});
              transform-origin: top left;
            }
            ${createSpriteStateCss(".installed-sprite", stateRows)}
            @keyframes pet-frames {
              from { background-position: 0 var(--sprite-row-y); }
              to { background-position: calc(-${defaultPetSprite.frameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
            }
          </style>
        </head>
        <body>
          ${bodyHtml}
        </body>
      </html>`,
  };
}

function createPetBodyMarkup(stageLabel: string, bubble: string, spriteMarkup: string, pinnedBubble = "", hasPinned = false): string {
  return `<div class="stage${hasPinned ? " has-pinned" : ""}" aria-label="${stageLabel}">
    ${pinnedBubble}
    ${bubble}
    <div class="pet-hitbox" aria-hidden="true">
      <div class="pet-shell">
        ${spriteMarkup}
      </div>
    </div>
  </div>`;
}

function createPetWindowCss(paused: boolean, scale: PetScaleValue): string {
  const opacity = paused ? "0.62" : "1";
  const playState = paused ? "paused" : "running";
  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const petBottom = 22;
  const hitPadding = 18;
  const bubbleBottom = Math.ceil(petBottom + scaledHeight + 8);
  const emojiFontUrl = pathToFileURL(join(app.getAppPath(), "assets", "NotoColorEmoji.ttf")).toString();
  const petShellFilter = process.platform === "win32" ? "none" : "drop-shadow(0 10px 12px rgba(15, 23, 42, 0.24)) drop-shadow(0 2px 3px rgba(15, 23, 42, 0.18))";
  const bubbleBackdropFilter = process.platform === "win32" ? "none" : "blur(10px)";
  const petDragRegion = shouldUseWaylandNativePetDrag() ? "drag" : "no-drag";
  return `
    @font-face { font-family: "OpenPets Emoji"; src: url("${escapeCssUrl(emojiFontUrl)}") format("truetype"); font-display: block; }
    :root { color-scheme: dark; --pet-opacity: ${opacity}; --play-state: ${playState}; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; -webkit-font-smoothing: antialiased; }
    html { color: #172033; }
    body { -webkit-app-region: no-drag; pointer-events: none; }
    .stage { width: 100%; height: 100%; position: relative; box-sizing: border-box; overflow: visible; }
    .pet-hitbox { position: absolute; left: 50%; bottom: ${Math.max(0, petBottom - hitPadding)}px; z-index: 1; width: ${scaledWidth + hitPadding * 2}px; height: ${scaledHeight + hitPadding * 2}px; display: grid; place-items: center; transform: translateX(-50%); pointer-events: auto; -webkit-app-region: ${petDragRegion}; cursor: grab; }
    .pet-shell { position: relative; width: ${scaledWidth}px; height: ${scaledHeight}px; display: block; opacity: var(--pet-opacity); filter: ${petShellFilter}; transition-property: opacity, filter; transition-duration: 180ms; transition-timing-function: cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; -webkit-app-region: ${petDragRegion}; cursor: grab; }
    .bubble { position: absolute; left: 50%; bottom: ${bubbleBottom}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: 128px; padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82); white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 1; backdrop-filter: ${bubbleBackdropFilter}; transform: translateX(-50%); transform-origin: 64% 100%; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
    .bubble[data-dismiss-token] { cursor: pointer; }
    .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); box-shadow: 3px 3px 7px rgba(15, 23, 42, 0.08); }
    .bubble-header { display: inline-flex; align-items: center; min-width: 0; gap: 7px; color: currentColor; font: 780 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0.01em; }
    .bubble-status-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; width: 18px; min-width: 18px; height: 18px; border-radius: 999px; background: #3b82f6; color: #fff; font: 900 12px/18px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.3); }
    .bubble-status-icon::before { content: attr(data-icon); display: block; width: 18px; height: 18px; line-height: 18px; text-align: center; transform: none; }
    .bubble-status-icon.has-svg::before { content: none; }
    .bubble-status-icon svg { display: block; width: 14px; height: 14px; color: currentColor; }
    .bubble-status-icon img { display: block; width: 14px; height: 14px; object-fit: contain; }
    .bubble-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble-divider { height: 1px; width: 100%; margin: 8px 0; background: rgba(30, 58, 138, 0.12); }
    .bubble-body { min-width: 0; width: 100%; color: #172033; font: 720 10.5px/13.5px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Malgun Gothic", "Apple SD Gothic Neo", "PingFang SC", "PingFang TC", "Microsoft YaHei", "Microsoft JhengHei", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Sans CJK TC", sans-serif; }
    .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; text-wrap: normal; overflow-wrap: break-word; }
    .bubble.is-status-only { max-width: min(156px, calc(100vw - 18px)); padding: 8px 11px; border-radius: 999px; }
    .bubble.is-status-only .bubble-header { display: grid; grid-template-columns: 18px minmax(0, auto); align-items: center; justify-content: center; }
    .bubble.is-message-only { border-radius: 14px 14px 3px 14px; }
    .bubble.has-actions { min-width: min(176px, calc(100vw - 18px)); }
    .bubble.is-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 138px; }
    .bubble.is-long-message .bubble-text { -webkit-line-clamp: 6; font-size: 10px; line-height: 13px; }
    .bubble.is-very-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 156px; }
    .bubble.is-very-long-message .bubble-text { -webkit-line-clamp: 8; font-size: 9.5px; line-height: 12.5px; }
    .bubble.is-busy .bubble-status-icon { background: #3b82f6; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.34); }
    .bubble.is-waiting .bubble-status-icon { background: #f59e0b; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(245, 158, 11, 0.34); }
    .bubble.is-success .bubble-status-icon { background: #10b981; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(16, 185, 129, 0.34); }
    .bubble.is-error .bubble-status-icon { background: #ef4444; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(239, 68, 68, 0.34); }
    .bubble.is-info .bubble-status-icon { background: #38bdf8; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(56, 189, 248, 0.34); }
    .bubble-status-icon.is-success { background: #10b981; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(16, 185, 129, 0.34); }
    .bubble-status-icon.is-error { background: #ef4444; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(239, 68, 68, 0.34); }
    .bubble-status-icon.is-warning { background: #f59e0b; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(245, 158, 11, 0.34); }
    .bubble-status-icon.is-info { background: #38bdf8; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(56, 189, 248, 0.34); }
    .bubble.is-busy .bubble-status-icon::before { content: ""; position: absolute; inset: 0; width: 18px; height: 18px; background: radial-gradient(circle at 50% 50%, #fff 0 4px, transparent 4.5px); animation: status-pulse 820ms ease-in-out infinite; }
    .bubble.is-waiting .bubble-status-icon::before { content: ""; position: absolute; left: 3px; top: 3px; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, 0.96); border-top-color: rgba(255, 255, 255, 0.28); border-radius: 999px; }
    .bubble.is-plugin { gap: 6px; }
    .bubble.is-plugin .bubble-markdown strong { font-weight: 860; }
    .bubble.is-plugin .bubble-markdown em { font-style: italic; }
    .bubble.is-plugin .bubble-markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; background: rgba(30, 58, 138, 0.08); border-radius: 4px; padding: 0 3px; }
    .bubble-media { display: block; max-width: 96px; max-height: 64px; margin: 0 auto 2px; pointer-events: none; }
    .bubble.has-media { max-width: min(232px, calc(100vw - 18px)); max-height: 224px; }
    .bubble.is-link { cursor: pointer; }
    .bubble-media-preview { display: block; max-width: 100%; max-height: 150px; margin: 0 auto 2px; border-radius: 8px; pointer-events: none; object-fit: contain; }
    .bubble-plugin-icon { display: inline-block; font-size: 13px; line-height: 14px; margin-bottom: 2px; }
    .bubble-hud-item-icon, .bubble-plugin-icon, .bubble-status-icon::before, .bubble-action [aria-hidden="true"] { font-family: "OpenPets Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif; }
    .bubble-actions { display: flex; flex-wrap: nowrap; gap: 5px; width: 100%; margin-top: 6px; min-width: 0; }
    .bubble-action { flex: 1 1 0; min-width: 0; border: 0; border-radius: 8px; padding: 4px 7px; font: 760 10px/12px Inter, ui-sans-serif, system-ui, sans-serif; background: rgba(30, 58, 138, 0.10); color: #172033; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bubble-action:hover { background: rgba(30, 58, 138, 0.18); }
    .bubble-action.is-primary { background: #2563eb; color: #fff; }
    .bubble-action.is-primary:hover { background: #1d4ed8; }
    .bubble-action.is-danger { background: #ef4444; color: #fff; }
    .bubble-action.is-danger:hover { background: #dc2626; }
    .bubble-input { display: flex; gap: 5px; margin-top: 6px; align-items: center; }
    .bubble-input-control { box-sizing: border-box; flex: 1 1 auto; min-width: 0; border: 1px solid rgba(30, 58, 138, 0.25); border-radius: 8px; padding: 4px 7px; font: 700 10px/12px Inter, ui-sans-serif, system-ui, sans-serif; background: rgba(255, 255, 255, 0.9); color: #172033; pointer-events: auto; -webkit-app-region: no-drag; }
    .bubble.is-pinned {
      position: absolute;
      left: 50%;
      bottom: 6px;
      z-index: 4;
      transform: translateX(-50%);
      width: 188px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 6px 8px;
      background: linear-gradient(135deg, rgba(241, 245, 249, 0.94), rgba(226, 232, 240, 0.92));
      color: #334155;
      border: 1px solid rgba(255, 255, 255, 0.7);
      border-radius: 12px;
      box-shadow: 0 4px 10px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.5);
      backdrop-filter: blur(8px);
      text-align: center;
      max-height: none;
      max-width: none;
      animation: bubble-in 200ms cubic-bezier(0.2, 0, 0, 1);
    }
    .bubble.is-pinned::after { content: none !important; }
    .bubble.is-pinned .bubble-body { width: 100%; text-align: center; }
    .bubble.is-pinned .bubble-text { display: inline-block; -webkit-line-clamp: unset; -webkit-box-orient: initial; white-space: pre; overflow-wrap: normal; word-break: keep-all; font: 800 10px/13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; letter-spacing: -0.03em; color: #334155; text-align: left; }
    .bubble.is-pinned .bubble-actions { display: flex; flex-direction: row; flex-wrap: nowrap; gap: 4px; width: 100%; margin-top: 5px; justify-content: center; }
    .bubble.is-pinned .bubble-action { flex: 1 1 auto; min-width: 0; padding: 3px 6px; font-size: 9px; font-weight: 700; line-height: 11px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; background: rgba(30, 58, 138, 0.08); color: #1e293b; transition: background 150ms ease; }
    .bubble.is-pinned .bubble-action:hover { background: rgba(30, 58, 138, 0.14); }
    .bubble.is-pinned .bubble-action.is-primary { background: #2563eb; color: #ffffff; }
    .bubble.is-pinned .bubble-action.is-primary:hover { background: #1d4ed8; }
    .bubble.is-pinned .bubble-action.is-danger { background: #ef4444; color: #ffffff; }
    .bubble.is-pinned .bubble-action.is-danger:hover { background: #dc2626; }
    .bubble.is-pinned.accent-blue { background: linear-gradient(135deg, rgba(219, 234, 254, 0.94), rgba(191, 219, 254, 0.92)); }
    .bubble.is-pinned.accent-purple { background: linear-gradient(135deg, rgba(237, 233, 254, 0.94), rgba(221, 214, 254, 0.92)); }
    .bubble.is-pinned.accent-green { background: linear-gradient(135deg, rgba(220, 252, 231, 0.94), rgba(187, 247, 208, 0.92)); }
    .bubble.is-pinned.accent-amber { background: linear-gradient(135deg, rgba(254, 243, 199, 0.94), rgba(253, 230, 138, 0.92)); }
    .bubble.is-pinned.accent-red { background: linear-gradient(135deg, rgba(254, 226, 226, 0.94), rgba(254, 202, 202, 0.92)); }
    .bubble.is-pinned.accent-pink { background: linear-gradient(135deg, rgba(252, 231, 243, 0.94), rgba(251, 207, 232, 0.92)); }
    .bubble.is-pinned.accent-slate { background: linear-gradient(135deg, rgba(241, 245, 249, 0.94), rgba(226, 232, 240, 0.92)); }
    .stage.has-pinned .pet-hitbox { bottom: ${Math.max(0, petBottom - hitPadding) + 28}px; }
    .stage.has-pinned .bubble:not(.is-pinned) { bottom: ${bubbleBottom + 28}px; }
    .bubble.is-plugin.accent-blue { background: linear-gradient(135deg, rgba(219, 234, 254, 0.97), rgba(191, 219, 254, 0.94)); }
    .bubble.is-plugin.accent-purple { background: linear-gradient(135deg, rgba(237, 233, 254, 0.97), rgba(221, 214, 254, 0.94)); }
    .bubble.is-plugin.accent-green { background: linear-gradient(135deg, rgba(220, 252, 231, 0.97), rgba(187, 247, 208, 0.94)); }
    .bubble.is-plugin.accent-amber { background: linear-gradient(135deg, rgba(254, 243, 199, 0.97), rgba(253, 230, 138, 0.94)); }
    .bubble.is-plugin.accent-red { background: linear-gradient(135deg, rgba(254, 226, 226, 0.97), rgba(254, 202, 202, 0.94)); }
    .bubble.is-plugin.accent-pink { background: linear-gradient(135deg, rgba(252, 231, 243, 0.97), rgba(251, 207, 232, 0.94)); }
    .bubble.is-plugin.accent-slate { background: linear-gradient(135deg, rgba(241, 245, 249, 0.97), rgba(226, 232, 240, 0.94)); }
    .bubble-hud {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 8px;
      width: 100%;
      margin: 2px 0;
      box-sizing: border-box;
    }
    .bubble-hud.items-1 {
      grid-template-columns: 1fr;
    }
    .bubble-hud.items-3 .bubble-hud-item:last-child {
      grid-column: span 2;
    }
    .bubble-hud-item {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      width: 100%;
    }
    .bubble-hud-item-icon {
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      line-height: 1;
      font-family: "OpenPets Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif;
    }
    .bubble-hud-item-icon img, .bubble-hud-item-icon svg {
      width: 12px;
      height: 12px;
      object-fit: contain;
      display: block;
    }
    .bubble-hud-item-content {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .bubble-hud-item-meta {
      display: flex;
      justify-content: flex-start;
      align-items: baseline;
      gap: 2px;
      font-size: 8px;
      font-weight: 700;
      line-height: 1;
      color: #475569;
    }
    .bubble-hud-item-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bubble-hud-item-bar {
      height: 4px;
      background: rgba(71, 85, 105, 0.15);
      border-radius: 99px;
      overflow: hidden;
      position: relative;
      width: 100%;
    }
    .bubble-hud-item-fill {
      height: 100%;
      border-radius: 99px;
      width: 0%;
      transition: width 200ms ease;
    }
    .bubble-hud-item-fill.tone-amber { background: #d97706; }
    .bubble-hud-item-fill.tone-blue { background: #2563eb; }
    .bubble-hud-item-fill.tone-green { background: #16a34a; }
    .bubble-hud-item-fill.tone-pink { background: #db2777; }
    .bubble-hud-item-fill.tone-slate { background: #475569; }
    .bubble-hud-item-fill.tone-red { background: #dc2626; }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    @keyframes status-pulse { 0%, 100% { opacity: 0.52; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .sprite, .installed-sprite, .bubble, .bubble-status-icon::before { animation: none !important; } }
  `;
}

function createSpriteStateCss(selector: ".sprite" | ".installed-sprite", stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>): string {
  const reactionRules = Object.keys(stateRows).map((state) => createSpriteRule(`html[data-reaction-state="${state}"] ${selector}`, state as UniversalSpriteState, stateRows));
  const motionRules = (Object.entries(motionToSpriteState) as Array<[PetMotionState, UniversalSpriteState]>)
    .filter(([motion]) => motion !== "idle")
    .map(([motion, state]) => createSpriteRule(`html[data-motion-state="${motion}"] ${selector}`, state, stateRows));
  return [...reactionRules, ...motionRules].join("\n");
}

function createSpriteRule(selector: string, state: UniversalSpriteState, stateRows: Readonly<Record<UniversalSpriteState, SpriteStateDefinition>>): string {
  const row = stateRows[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  return `${selector} { --sprite-row-y: -${row.row * defaultPetSprite.frameHeight}px; --sprite-frames: ${row.frames}; --sprite-duration: ${row.durationMs}ms; --sprite-iterations: ${iterations}; }`;
}

function getReactionSpriteState(reaction: OpenPetsReaction | undefined): UniversalSpriteState {
  return resolveReactionSpriteState(reaction, getAppStateSnapshot().preferences.reactionAnimationOverrides);
}

const namedHostIconGlyphs: Record<string, string> = {
  info: "ℹ", check: "✓", alert: "⚠", heart: "💛", star: "★", bell: "🔔", coffee: "☕", timer: "⏱",
  droplet: "💧", sparkles: "✨", zap: "⚡", moon: "☾", sun: "☀", food: "🍖", play: "🎾", pause: "⏸",
};

function createHudIconMarkup(item: PluginBubbleHudItem): string {
  if (item.svgPath) {
    const svg = readSafePluginSvg(item.svgPath);
    if (svg) return svg;
  }
  if (item.iconName) {
    return escapeHtml(namedHostIconGlyphs[item.iconName] ?? "•");
  }
  return "•";
}

function createPluginHudMarkup(hud: PluginBubbleHud): string {
  const itemsHtml = hud.items.map((item) => {
    const value = Math.round(Math.max(0, Math.min(100, item.value)));
    const iconMarkup = createHudIconMarkup(item);
    const labelHtml = item.label ? `<span class="bubble-hud-item-label">${escapeHtml(item.label)}</span>` : "";
    const tone = item.tone ?? "slate";
    const ariaLabel = item.label ? ` aria-label="${escapeHtml(`${item.label} ${value}%`)}"` : "";
    return `<div class="bubble-hud-item"${ariaLabel}><div class="bubble-hud-item-icon" aria-hidden="true">${iconMarkup}</div><div class="bubble-hud-item-content"><div class="bubble-hud-item-meta">${labelHtml}</div><div class="bubble-hud-item-bar"><div class="bubble-hud-item-fill tone-${tone}" style="width:${value}%"></div></div></div></div>`;
  }).join("");
  return `<div class="bubble-hud items-${hud.items.length}">${itemsHtml}</div>`;
}

/** Render a plugin-arbiter bubble descriptor into host markup (descriptor-only — no plugin markup). */
function createPluginBubbleMarkup(active: ActiveBubble, pinned: boolean): string {
  const bubble = active.bubble;
  const token = escapeHtml(active.token);
  const toneClass = bubble.tone ? ` is-${bubble.tone}` : "";
  const accentClass = bubble.accent ? ` accent-${escapeHtml(bubble.accent)}` : "";
  const interactive = Boolean(bubble.actions?.length || bubble.input);
  const clickDismiss = bubble.dismissOn ? bubble.dismissOn.includes("click") : !interactive;
  const dismissAttr = clickDismiss ? ` data-dismiss-token="${token}"` : "";
  const parts: string[] = [];
  if (bubble.indicator) parts.push(createPluginIndicatorMarkup(bubble.indicator));
  if (bubble.iconName || bubble.svgPath || bubble.imagePath) {
    const media = bubble.svgPath || bubble.imagePath;
    if (media) parts.push(`<img class="bubble-media" src="${escapeHtml(pathToFileURL(media).toString())}" alt="" draggable="false">`);
    else if (bubble.iconName) parts.push(`<span class="bubble-plugin-icon" aria-hidden="true">${escapeHtml(namedHostIconGlyphs[bubble.iconName] ?? "•")}</span>`);
  }
  const body = bubble.markdownHtml !== undefined
    ? `<div class="bubble-body"><span class="bubble-text bubble-markdown">${bubble.markdownHtml}</span></div>`
    : bubble.text !== undefined
      ? `<div class="bubble-body"><span class="bubble-text">${escapeHtml(bubble.text)}</span></div>`
      : "";
  if (bubble.indicator && body) parts.push(`<div class="bubble-divider" aria-hidden="true"></div>`);
  if (body) parts.push(body);
  if (bubble.hud) {
    parts.push(createPluginHudMarkup(bubble.hud));
  }
  if (bubble.input) {
    const input = bubble.input;
    const inputId = escapeHtml(input.id);
    const placeholder = input.placeholder ? ` placeholder="${escapeHtml(input.placeholder)}"` : "";
    const defaultValue = input.default !== undefined ? ` value="${escapeHtml(String(input.default))}"` : "";
    const control = input.type === "select"
      ? `<select class="bubble-input-control" data-input-id="${inputId}">${(input.options ?? []).map((option) => `<option value="${escapeHtml(option.value)}"${String(input.default ?? "") === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select>`
      : `<input class="bubble-input-control" data-input-id="${inputId}" type="${input.type === "number" ? "number" : "text"}"${placeholder}${defaultValue}>`;
    parts.push(`<div class="bubble-input" data-bubble-token="${token}">${control}<button type="button" class="bubble-action is-primary" data-bubble-submit="${token}">${escapeHtml(input.submitLabel ?? "OK")}</button></div>`);
  }
  if (bubble.actions?.length) {
    const buttons = bubble.actions.map((action) => `<button type="button" class="bubble-action is-${action.style}" data-bubble-token="${token}" data-bubble-action="${escapeHtml(action.id)}">${action.iconName ? `<span aria-hidden="true">${escapeHtml(namedHostIconGlyphs[action.iconName] ?? "")}</span> ` : ""}${escapeHtml(action.label)}</button>`).join("");
    parts.push(`<div class="bubble-actions">${buttons}</div>`);
  }
  const actionsClass = bubble.actions?.length ? " has-actions" : "";
  const hudClass = bubble.hud ? " has-hud" : "";
  return `<div class="bubble is-plugin${pinned ? " is-pinned" : ""}${actionsClass}${hudClass}${toneClass}${accentClass}" role="status" aria-live="polite"${dismissAttr} data-bubble-token="${token}">${parts.join("")}</div>`;
}

function createPluginIndicatorMarkup(indicator: PluginBubbleIndicator): string {
  const toneClass = indicator.tone ? ` is-${indicator.tone}` : " is-info";
  const style = createIndicatorStyle(indicator);
  const styleAttr = style ? ` style="${escapeHtml(style)}"` : "";
  const label = indicator.label ?? "";
  const icon = createIndicatorIconMarkup(indicator);
  return `<div class="bubble-header"><span class="bubble-status-icon${icon.hasSvg ? " has-svg" : ""}${toneClass}" data-icon="${escapeHtml(icon.glyph)}" aria-hidden="true"${styleAttr}>${icon.markup}</span>${label ? `<span class="bubble-status-label">${escapeHtml(label)}</span>` : ""}</div>`;
}

function createIndicatorIconMarkup(indicator: PluginBubbleIndicator): { glyph: string; markup: string; hasSvg: boolean } {
  if (indicator.iconSvgPath) {
    const svg = readSafePluginSvg(indicator.iconSvgPath);
    if (svg) return { glyph: "", markup: svg, hasSvg: true };
  }
  if (indicator.imagePath) return { glyph: "", markup: `<img src="${escapeHtml(pathToFileURL(indicator.imagePath).toString())}" alt="" draggable="false">`, hasSvg: true };
  if (indicator.iconName) return { glyph: namedHostIconGlyphs[indicator.iconName] ?? "•", markup: "", hasSvg: false };
  return { glyph: "", markup: "", hasSvg: false };
}

function readSafePluginSvg(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch { return ""; }
}

function createIndicatorStyle(indicator: PluginBubbleIndicator): string {
  const declarations: string[] = [];
  if (indicator.color) declarations.push(`color:${indicator.color}`);
  if (indicator.background) declarations.push(`background:${indicator.background}`);
  if (indicator.borderColor) declarations.push(`border:1px solid ${indicator.borderColor}`);
  return declarations.join(";");
}

function createPinnedBubbleMarkup(pluginBubbles: PetPluginBubbles | null): string {
  if (!pluginBubbles?.pinned) return "";
  return createPluginBubbleMarkup(pluginBubbles.pinned, true);
}

export function pluginBubblesCacheKey(pluginBubbles: PetPluginBubbles | null): string {
  if (!pluginBubbles) return "none";
  return `${pluginBubbles.transient?.token ?? "-"}:${pluginBubbles.pinned?.token ?? "-"}`;
}

function createBubbleMarkup(display: PetTransientDisplay | null, paused: boolean, badgeReaction: PetStatusBadgeReaction | null, dismissToken?: string, pluginBubbles: PetPluginBubbles | null = null): string {
  if (pluginBubbles?.transient) return createPluginBubbleMarkup(pluginBubbles.transient, false);
  const suppressReactionMessage = display?.suppressReactionMessage === true;
  const text = display?.message ?? display?.reactionMessage ?? (!suppressReactionMessage && display?.reaction ? pickReactionMessage(display.reaction, Math.random, getActiveLocale()) : undefined) ?? (paused ? t("pet.paused") : "");
  const status = !paused && !suppressReactionMessage && badgeReaction ? getStatusBadge(badgeReaction) : null;
  const media = !paused && display?.mediaPath ? `<img class="bubble-media-preview" src="${escapeHtml(pathToFileURL(display.mediaPath).toString())}" alt="" draggable="false">` : "";
  if (!text && !status && !media) return "";
  const isExplicitMessage = Boolean(display?.message && !display?.reactionMessage);
  const className = getBubbleClassName(text, isExplicitMessage, status?.className) + (media ? " has-media" : "") + (media && display?.clickUrl ? " is-link" : "");
  const header = status ? `<div class="bubble-header"><span class="bubble-status-icon${status.iconSvg ? " has-svg" : ""}" data-icon="${escapeHtml(status.icon ?? "")}" aria-hidden="true">${status.iconSvg ?? ""}</span><span class="bubble-status-label">${escapeHtml(status.label)}</span></div>` : "";
  const divider = status && (text || media) ? `<div class="bubble-divider" aria-hidden="true"></div>` : "";
  const body = text ? `<div class="bubble-body"><span class="bubble-text">${escapeHtml(text)}</span></div>` : "";
  // Use provided dismissToken, fallback to display's dismissToken for transient messages
  const token = dismissToken ?? display?.dismissToken;
  const dismissAttr = token ? ` data-dismiss-token="${escapeHtml(token)}"` : "";
  return `<div class="${className}" role="status" aria-live="polite"${dismissAttr}>${header}${divider}${media}${body}</div>`;
}

const statusBadgeIcons = {
  check: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17l-5-5"/></svg>',
  alert: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>',
  wavingHand: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" fill-rule="evenodd" d="M4.771 1.197A.625.625 0 1 0 4.266.053a3.5 3.5 0 0 0-1.494 1.258a.625.625 0 0 0 1.04.694c.247-.37.582-.642.96-.808m8.563.739a.625.625 0 0 0-1.01.738c.244.332.399.736.427 1.18A.625.625 0 0 0 14 3.771a3.5 3.5 0 0 0-.665-1.836M2.685 7.304a.488.488 0 0 0-.904.367l.687 1.835c.229.61.566 1.173.996 1.663l.346.393a.625.625 0 1 1-.939.825l-.345-.393a6.6 6.6 0 0 1-1.228-2.05L.61 8.11a1.738 1.738 0 0 1 3.075-1.574l1.006-3.755a1.75 1.75 0 0 1 2.635-1.022a1.751 1.751 0 0 1 3.272 1.206l-.149.554a1.75 1.75 0 0 1 1.741 2.204L10.482 12.1a2.63 2.63 0 0 1-1.223 1.594l-.385.222a.625.625 0 1 1-.625-1.082l.385-.223c.316-.182.547-.483.64-.835l1.71-6.377a.5.5 0 0 0-.968-.26l-.758 2.828a.625.625 0 0 1-1.207-.323l.758-2.828l.582-2.175a.5.5 0 0 0-.967-.259l-.35 1.305L7.2 6.949a.625.625 0 0 1-1.207-.323l.874-3.263a.5.5 0 0 0-.968-.259L4.59 7.997c.567.267 1.289.753 1.732 1.522a.625.625 0 1 1-1.082.624c-.383-.66-1.163-1.043-1.53-1.15l-.033-.008a.62.62 0 0 1-.419-.372z" clip-rule="evenodd"/></svg>',
} as const;

function getStatusBadge(reaction: PetStatusBadgeReaction): { readonly className: string; readonly icon?: string; readonly iconSvg?: string; readonly label: string } | null {
  if (reaction === "thinking") return { className: "is-busy", icon: "", label: t("pet.status.thinking") };
  if (reaction === "working" || reaction === "running") return { className: "is-busy", icon: "", label: t("pet.status.working") };
  if (reaction === "editing") return { className: "is-busy", icon: "", label: t("pet.status.editing") };
  if (reaction === "testing") return { className: "is-busy", icon: "", label: t("pet.status.testing") };
  if (reaction === "waiting") return { className: "is-waiting", icon: "", label: t("pet.status.waiting") };
  if (reaction === "success" || reaction === "celebrating") return { className: "is-success", iconSvg: statusBadgeIcons.check, label: t("pet.status.done") };
  if (reaction === "error") return { className: "is-error", iconSvg: statusBadgeIcons.alert, label: t("pet.status.oops") };
  if (reaction === "waving") return { className: "is-info", iconSvg: statusBadgeIcons.wavingHand, label: t("pet.status.hi") };
  return null;
}

function getBubbleClassName(text: string, isExplicitMessage: boolean, statusClassName: string | undefined): string {
  const statusClass = statusClassName ? ` ${statusClassName}` : "";
  if (!text) return `bubble is-status-only${statusClass}`;
  if (!statusClassName) return `bubble is-message-only${isExplicitMessage ? getBubbleLengthClass(text) : ""}`;
  const lengthClass = text.length > 95 ? " is-very-long-message" : text.length > 56 ? " is-long-message" : "";
  return `bubble is-message${statusClass}${lengthClass}`;
}

function getBubbleLengthClass(text: string): string {
  return text.length > 95 ? " is-very-long-message" : text.length > 56 ? " is-long-message" : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeCssUrl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "");
}

function installMotionStatePublisher(window: BrowserWindow): void {
  let lastX = window.getPosition()[0];
  let lastSent: PetMotionState = "idle";
  let idleTimer: NodeJS.Timeout | null = null;

  const sendMotionState = (state: PetMotionState): void => {
    if (window.isDestroyed() || lastSent === state) return;
    lastSent = state;
    window.webContents.send("openpets:pet-motion", state);
  };

  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      sendMotionState("idle");
    }, 180);
  };

  const handleMove = (): void => {
    if (window.isDestroyed()) return;
    const [x] = window.getPosition();
    const deltaX = x - lastX;
    lastX = x;

    if (Math.abs(deltaX) >= 3) {
      sendMotionState(deltaX > 0 ? "run-right" : "run-left");
    }
    scheduleIdle();
  };

  window.on("move", handleMove);
  window.on("moved", handleMove);
  window.webContents.on("did-finish-load", () => {
    lastSent = "idle";
    window.webContents.send("openpets:pet-motion", "idle");
  });
  window.on("closed", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });
}

function isAllowedPetDocumentUrl(url: string): boolean {
  return url.startsWith("data:text/html") || url.startsWith("file://");
}

function allocateWindowLoadSequence(window: BrowserWindow): number {
  const sequence = (windowLoadSequences.get(window) ?? 0) + 1;
  windowLoadSequences.set(window, sequence);
  return sequence;
}

async function loadPetHtmlFile(window: BrowserWindow, html: string, name: string, sequence: number): Promise<void> {
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "pet";

  const previous = windowLoadChains.get(window) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (window.isDestroyed()) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, reason: "destroyed" });
      return;
    }

    if (windowLoadSequences.get(window) !== sequence) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, latestSequence: windowLoadSequences.get(window), reason: "superseded" });
      return;
    }

    const dir = join(app.getPath("userData"), "rendered-pets");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${safeName}.html`);
    await writeFile(filePath, html, "utf8");
    if (window.isDestroyed()) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, reason: "destroyed-after-write" });
      return;
    }
    debug("pet.window", "load file begin", { windowId: window.id, name: safeName, sequence, filePath });
    window.setIgnoreMouseEvents(false);
    try {
      await window.loadFile(filePath);
      debug("pet.window", "load file complete", { windowId: window.id, name: safeName, sequence, url: window.webContents.getURL() });
    } catch (error) {
      if (!window.isDestroyed()) {
        if (process.platform === "linux") window.setIgnoreMouseEvents(false);
        else window.setIgnoreMouseEvents(true, { forward: true });
      }
      logError("pet.window", "load file rejected", error instanceof Error ? error : { windowId: window.id, name: safeName, sequence, error });
      throw error;
    }
  });

  windowLoadChains.set(window, next);
  void next.catch(() => {}).finally(() => {
    if (windowLoadChains.get(window) === next) windowLoadChains.delete(window);
  });

  return next;
}

function debounce(callback: () => void, delayMs: number): () => void {
  let timeout: NodeJS.Timeout | undefined;

  return () => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(callback, delayMs);
  };
}
