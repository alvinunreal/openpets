import type { PluginPermission } from "./plugin-manifest.js";
import type { PluginStorageStore } from "./plugin-sdk-bridge.js";
import type { PluginRuntimeState } from "./plugin-sdk-state.js";

export function createPluginStorageApi(options: {
  readonly pluginId: string;
  readonly state: PluginRuntimeState;
  readonly storage: PluginStorageStore;
  readonly requireActive: () => void;
  readonly requirePermission: (permission: PluginPermission) => void;
  readonly guardCallback: <A extends unknown[]>(fn: (...args: A) => unknown) => ((...args: A) => void);
  readonly validateStorageKey: (key: string) => string;
  readonly onError: (reason: string) => void;
  readonly safeError: (error: unknown) => string;
  readonly storageSubscriptionsQuota: number;
}) {
  const { pluginId, state, storage, requireActive, requirePermission, guardCallback, validateStorageKey, onError, safeError, storageSubscriptionsQuota } = options;
  const notify = (storageKey: string, value: unknown) => {
    for (const sub of state.storageSubscriptions.values()) if (sub.key === storageKey) { try { sub.handler(value); } catch (error) { onError(safeError(error)); } }
  };
  return {
    get: (key: string) => { requirePermission("storage"); return storage.get(pluginId, validateStorageKey(key)); },
    set: (key: string, value: unknown) => {
      requirePermission("storage");
      const storageKey = validateStorageKey(key);
      storage.set(pluginId, storageKey, value);
      notify(storageKey, value);
    },
    delete: (key: string) => {
      requirePermission("storage");
      const storageKey = validateStorageKey(key);
      storage.delete(pluginId, storageKey);
      notify(storageKey, undefined);
    },
    keys: () => { requirePermission("storage"); return storage.keys?.(pluginId) ?? []; },
    subscribe: (key: string, handler: (value: unknown) => void) => {
      requirePermission("storage");
      if (state.storageSubscriptions.size >= storageSubscriptionsQuota) throw new Error("Plugin storage subscription quota exceeded.");
      const subId = opaqueId("storage");
      state.storageSubscriptions.set(subId, { key: validateStorageKey(key), handler: guardCallback(handler) });
      return { subscriptionId: subId };
    },
    unsubscribe: (subscriptionId: unknown) => { requireActive(); state.storageSubscriptions.delete(String(subscriptionId)); },
  };
}

function opaqueId(prefix: string): string { return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`; }
