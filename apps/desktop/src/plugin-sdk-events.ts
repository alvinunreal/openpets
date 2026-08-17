import type { PluginPermission } from "./plugin-manifest.js";
import type { PluginHostCapabilities } from "./plugin-sdk-bridge.js";
import type { PluginRuntimeState } from "./plugin-sdk-state.js";
import { registerConfigChangedEvent } from "./plugin-sdk-config.js";

export function createPluginEventsApi(options: {
  readonly state: PluginRuntimeState;
  readonly capabilities: PluginHostCapabilities;
  readonly requireActive: () => void;
  readonly requirePermission: (permission: PluginPermission) => void;
  readonly guardCallback: <A extends unknown[]>(fn: (...args: A) => unknown) => ((...args: A) => void);
  readonly allowedEventNames: ReadonlySet<string>;
  readonly eventSubscriptionsQuota: number;
}) {
  const { state, capabilities, requireActive, requirePermission, guardCallback, allowedEventNames, eventSubscriptionsQuota } = options;
  return {
    on: (event: unknown, handler: (payload: Record<string, unknown>) => void) => {
      requirePermission("events");
      const name = String(event);
      if (!allowedEventNames.has(name)) throw new Error(`Unknown plugin event: ${name}`);
      if (name === "pet:drop") requirePermission("pet:drop");
      if (state.eventSubscriptions.size >= eventSubscriptionsQuota) throw new Error("Plugin event subscription quota exceeded.");
      const subId = opaqueId("event");
      if (name === "config:changed") {
        registerConfigChangedEvent({ state, subscriptionId: subId, handler, guardCallback });
      } else if (name === "pet:drop") {
        const wrapped = guardCallback((payload: Record<string, unknown>) => {
          if (Array.isArray(payload.files)) for (const file of payload.files) { if (isRecord(file) && typeof file.fileId === "string") state.pickedFiles.add(file.fileId); }
          handler(payload);
        });
        state.eventSubscriptions.set(subId, capabilities.events.subscribe(name, wrapped));
      } else {
        state.eventSubscriptions.set(subId, capabilities.events.subscribe(name, guardCallback(handler)));
      }
      return { subscriptionId: subId };
    },
    off: (subscriptionId: unknown) => { requireActive(); state.eventSubscriptions.get(String(subscriptionId))?.(); state.eventSubscriptions.delete(String(subscriptionId)); },
  };
}

function opaqueId(prefix: string): string { return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
