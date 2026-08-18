import type { OpenPetsJavascriptPluginManifest, PluginPermission } from "./plugin-manifest.js";
import type { PluginAudioApi } from "./plugin-sdk-audio.js";
import type { BubbleSlot, DeliverySlot, PluginRuntimeState } from "./plugin-sdk-state.js";
import type { PluginBubbleDescriptor, PluginBubbleDismissReason, PluginBubbleHostHandle, PluginDeliveryDescriptor, PluginDeliveryDismissReason, PluginHostCapabilities, PluginLogLevel, PluginMenuItem, PluginStatus } from "./plugin-sdk-bridge.js";

export function createPluginUiApi(options: {
  readonly pluginId: string;
  readonly manifest: OpenPetsJavascriptPluginManifest;
  readonly installPath: string;
  readonly state: PluginRuntimeState;
  readonly capabilities: PluginHostCapabilities;
  readonly audio: PluginAudioApi;
  readonly requirePermission: (permission: PluginPermission) => void;
  readonly guardCallback: <A extends unknown[]>(fn: (...args: A) => unknown) => ((...args: A) => void);
  readonly validateBubbleSpec: (spec: unknown, forUpdate?: boolean) => PluginBubbleDescriptor;
  readonly validatePetHandleId: (value: unknown) => string;
  readonly resolvePanelPath: (name: string) => string;
  readonly normalizeJson: (value: unknown, maxBytes: number, label: string) => unknown;
  readonly validateMenuItems: (value: unknown) => PluginMenuItem[];
  readonly validateSayMessage: (message: string) => string;
  readonly safeError: (error: unknown) => string;
  readonly logger: (level: PluginLogLevel, message: string, fields?: Record<string, unknown>) => void;
  readonly onError: (reason: string) => void;
  readonly quotas: { petActionsPerMinute: number; activeBubbles: number; notifyPerMinute: number; toastPerMinute: number; activePanels: number; deliveriesPerMinute: number; busPayloadBytes: number };
}) {
  const { pluginId, manifest, state, capabilities, audio, requirePermission, guardCallback, validateBubbleSpec, validatePetHandleId, resolvePanelPath, normalizeJson, validateMenuItems, validateSayMessage, safeError, logger, onError, quotas } = options;

  const showBubble = async (petHandleId: string, spec: unknown): Promise<{ bubbleId: string }> => {
    requirePermission("pet:speak");
    state.petWindow.tick(quotas.petActionsPerMinute, "pet action");
    const bubble = validateBubbleSpec(spec);
    check(state.bubbles.size < quotas.activeBubbles, "Plugin active bubble quota exceeded.");
    const bubbleId = opaqueId("bubble");
    const slot: BubbleSlot = { host: undefined as unknown as PluginBubbleHostHandle, dismissed: false };
    const callbacks = {
      onAction: (actionId: string) => { try { slot.onAction?.(actionId); } catch (error) { onError(safeError(error)); } },
      onSubmit: (values: Record<string, string | number>) => { try { slot.onSubmit?.(values); } catch (error) { onError(safeError(error)); } },
      onDismiss: (reason: PluginBubbleDismissReason) => { slot.dismissed = true; state.bubbles.delete(bubbleId); try { slot.onDismiss?.(reason); } catch (error) { onError(safeError(error)); } },
    };
    slot.host = await capabilities.bubbles.show({ petId: validatePetHandleId(petHandleId), pluginId, bubble, callbacks });
    if (!slot.dismissed) state.bubbles.set(bubbleId, slot);
    return { bubbleId };
  };

  const requireBubble = (bubbleId: unknown): BubbleSlot => {
    const slot = state.bubbles.get(String(bubbleId));
    if (!slot) throw new Error("Plugin bubble is no longer live.");
    return slot;
  };

  const sendNotify = async (spec: unknown) => {
    requirePermission("notify");
    state.notifyWindow.tick(quotas.notifyPerMinute, "notification");
    if (!isRecord(spec)) throw new Error("Invalid notification spec.");
    const title = validateSayMessage(String(spec.title ?? ""));
    const body = spec.body === undefined ? undefined : validateSayMessage(String(spec.body));
    await capabilities.notify({ title, body, sound: spec.sound === true && capabilities.settings.audioAllowed() && !capabilities.settings.inQuietHours() });
  };

  const delivery = async (spec: unknown): Promise<{ deliveryId: string }> => {
    requirePermission("ui:delivery");
    state.deliveryWindow.tick(quotas.deliveriesPerMinute, "delivery");
    const descriptor = validateDelivery(spec);
    const deliveryId = opaqueId("delivery");
    const previousId = [...state.deliveries.entries()].find(([, current]) => current.key === descriptor.key)?.[0];
    if (previousId) {
      const previous = state.deliveries.get(previousId);
      if (previous) previous.dismissed = true;
      state.deliveries.delete(previousId);
    }
    const slot: DeliverySlot = { key: descriptor.key, dismissed: false };
    state.deliveries.set(deliveryId, slot);
    try {
      slot.host = await capabilities.delivery.register(pluginId, descriptor);
    } catch (error) {
      if (state.deliveries.get(deliveryId) === slot) {
        state.deliveries.delete(deliveryId);
      }
      throw error;
    }
    // A newer registration for this key won while the host call was pending.
    // Its handle exclusively owns dismissal callbacks and host interactions.
    if (slot.dismissed || state.deliveries.get(deliveryId) !== slot) {
      slot.dismissed = true;
      try { slot.host.dismiss(); } catch { /* late host handles are best effort */ }
      return { deliveryId };
    }
    slot.host.onDismiss((reason) => {
      if (slot.dismissed || !state.deliveries.has(deliveryId)) return;
      slot.dismissed = true;
      state.deliveries.delete(deliveryId);
      try { slot.onDismiss?.(reason); } catch (error) { onError(safeError(error)); }
    });
    return { deliveryId };
  };

  const validateDelivery = (value: unknown): PluginDeliveryDescriptor => {
    if (!isRecord(value)) throw new Error("Invalid delivery descriptor.");
    check(Object.keys(value).every((key) => ["key", "courier", "title", "detail", "expiresAt"].includes(key)), "Invalid delivery descriptor field.");
    const key = typeof value.key === "string" ? value.key : "";
    const courier = value.courier;
    const title = typeof value.title === "string" ? value.title : "";
    const detail = typeof value.detail === "string" ? value.detail : "";
    const expiresAt = Number(value.expiresAt);
    const now = Date.now();
    check(/^[A-Za-z0-9._:-]{1,96}$/.test(key), "Invalid delivery key.");
    check(isRecord(courier) && courier.kind === "sprite" && typeof courier.name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(courier.name) && Object.keys(courier).every((key) => key === "kind" || key === "name"), "Invalid delivery courier.");
    check(title.length >= 1 && title.length <= 160 && !/[\u0000-\u001f\u007f]/.test(title), "Invalid delivery title.");
    check(detail.length <= 200 && !/[\u0000-\u001f\u007f]/.test(detail), "Invalid delivery detail.");
    check(Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 7 * 24 * 60 * 60 * 1000, "Invalid delivery expiresAt.");
    return { key, courier: { kind: "sprite", name: courier.name }, title, detail, expiresAt };
  };

  return {
    api: {
      bubble: (spec: unknown) => showBubble("default", spec),
      alert: async (spec: unknown) => {
        const alertOptions = isRecord(spec) ? spec : { text: spec };
        const { indicator, ...bubbleOptions } = alertOptions;
        const handle = await showBubble("default", { ...bubbleOptions, ...(indicator === false ? {} : { indicator }), sticky: true, priority: "high" });
        if (alertOptions.sound !== undefined) {
          void Promise.resolve().then(async () => {
            try { await audio.play(alertOptions.sound, { volume: alertOptions.volume }); }
            catch (error) { logger("warn", "plugin alert sound skipped", { id: manifest.id, reason: safeError(error) }); }
          });
        }
        if (alertOptions.notify !== undefined) {
          void Promise.resolve().then(async () => {
            try { await sendNotify(alertOptions.notify === true ? { title: alertOptions.title ?? alertOptions.text ?? manifest.name, body: alertOptions.body } : alertOptions.notify); }
            catch (error) { logger("warn", "plugin alert notify skipped", { id: manifest.id, reason: safeError(error) }); }
          });
        }
        return handle;
      },
      bubbleUpdate: async (bubbleId: unknown, patch: unknown) => { const slot = requireBubble(bubbleId); await slot.host.update(validateBubbleSpec(patch, true)); },
      bubbleDismiss: async (bubbleId: unknown) => { const slot = state.bubbles.get(String(bubbleId)); if (slot) await slot.host.dismiss().catch(() => undefined); },
      bubblePin: async (bubbleId: unknown) => { requirePermission("pet:pin"); await requireBubble(bubbleId).host.pin(); },
      bubbleUnpin: async (bubbleId: unknown) => { const slot = state.bubbles.get(String(bubbleId)); if (slot) await slot.host.unpin().catch(() => undefined); },
      bubbleSubscribe: (bubbleId: unknown, kind: unknown, handler: (...args: never[]) => void) => {
        const slot = state.bubbles.get(String(bubbleId));
        if (!slot) { logger("debug", "plugin bubble subscribe skipped", { id: manifest.id, bubbleId: String(bubbleId), reason: "not-live" }); return { ok: false }; }
        if (kind === "action") slot.onAction = handler as (actionId: string) => void;
        else if (kind === "submit") slot.onSubmit = handler as (values: Record<string, string | number>) => void;
        else if (kind === "dismiss") slot.onDismiss = handler as (reason: PluginBubbleDismissReason) => void;
        else throw new Error("Invalid bubble subscription kind.");
        return { ok: true };
      },
      toast: async (spec: unknown) => {
        requirePermission("ui:toast");
        state.toastWindow.tick(quotas.toastPerMinute, "toast");
        if (!isRecord(spec)) throw new Error("Invalid toast spec.");
        const text = validateSayMessage(String(spec.text ?? ""));
        const tone = spec.tone === undefined ? undefined : (check(["info", "success", "warning", "error"].includes(String(spec.tone)), "Invalid toast tone."), spec.tone as PluginStatus["tone"]);
        const durationMs = spec.durationMs === undefined ? undefined : clampNumber(Number(spec.durationMs), 1_000, 15_000);
        await capabilities.toast({ text, tone, durationMs });
      },
      panel: async (spec: unknown) => {
        requirePermission("ui:panel");
        check(state.panels.size < quotas.activePanels, "Plugin panel quota exceeded.");
        if (!isRecord(spec) || typeof spec.panel !== "string") throw new Error("Invalid panel spec.");
        const width = spec.width === undefined ? 420 : clampNumber(Number(spec.width), 200, 1200);
        const height = spec.height === undefined ? 480 : clampNumber(Number(spec.height), 160, 900);
        const title = spec.title === undefined ? manifest.name : String(spec.title).slice(0, 80);
        const panelId = opaqueId("panel");
        const holder: { onMessage?: (msg: unknown) => void } = {};
        const host = await capabilities.panels.open({ pluginId, installPath: options.installPath, panelPath: resolvePanelPath(String(spec.panel)), title, width, height, onMessage: (msg) => { try { holder.onMessage?.(msg); } catch (error) { onError(safeError(error)); } }, onClosed: () => { state.panels.delete(panelId); } });
        state.panels.set(panelId, Object.assign(host, holder));
        return { panelId };
      },
      panelShow: async (panelId: unknown) => { await requirePanel(state, panelId).show(); },
      panelHide: async (panelId: unknown) => { await requirePanel(state, panelId).hide(); },
      panelPost: async (panelId: unknown, msg: unknown) => { await requirePanel(state, panelId).postMessage(normalizeJson(msg, quotas.busPayloadBytes, "panel message")); },
      panelClose: async (panelId: unknown) => { const panel = state.panels.get(String(panelId)); if (panel) { await panel.close(); state.panels.delete(String(panelId)); } },
      panelOnMessage: (panelId: unknown, handler: (msg: unknown) => void) => { requirePanel(state, panelId).onMessage = guardCallback(handler); },
      delivery,
      deliveryDismiss: async (deliveryId: unknown) => { await Promise.resolve(state.deliveries.get(String(deliveryId))?.host?.dismiss()); },
      deliverySubscribe: (deliveryId: unknown, handler: (reason: PluginDeliveryDismissReason) => void) => {
        const slot = state.deliveries.get(String(deliveryId));
        if (!slot) return { ok: false };
        slot.onDismiss = handler;
        return { ok: true };
      },
      menuSetItems: async (items: unknown) => { requirePermission("commands"); state.menuItems = validateMenuItems(items); },
      menuOnSelect: (handler: (id: string) => void) => { requirePermission("commands"); const wrapped = guardCallback(handler); state.menuHandlers.add(wrapped); return { subscriptionId: registerDisposer(state, () => state.menuHandlers.delete(wrapped)) }; },
      menuOffSelect: (subscriptionId: unknown) => { state.eventSubscriptions.get(String(subscriptionId))?.(); state.eventSubscriptions.delete(String(subscriptionId)); },
    },
    showBubble,
  };
}

function requirePanel(state: PluginRuntimeState, panelId: unknown) {
  const panel = state.panels.get(String(panelId));
  if (!panel) throw new Error("Plugin panel is no longer open.");
  return panel;
}

function registerDisposer(state: PluginRuntimeState, dispose: () => void): string {
  const subId = opaqueId("sub");
  state.eventSubscriptions.set(subId, dispose);
  return subId;
}

function opaqueId(prefix: string): string { return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`; }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function clampNumber(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
