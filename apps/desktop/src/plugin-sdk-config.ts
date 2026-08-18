import type { PluginConfig } from "./plugin-config.js";
import type { PluginRuntimeState } from "./plugin-sdk-state.js";

export function createPluginConfigApi(options: {
  readonly state: PluginRuntimeState;
  readonly getConfig: () => PluginConfig;
  readonly requireActive: () => void;
}) {
  const { state, getConfig, requireActive } = options;
  return {
    get: () => { requireActive(); return getConfig(); },
    onChange: (listener: (config: PluginConfig) => void) => {
      requireActive();
      state.configListeners.add(listener);
      return () => state.configListeners.delete(listener);
    },
  };
}

export function registerConfigChangedEvent(options: {
  readonly state: PluginRuntimeState;
  readonly subscriptionId: string;
  readonly handler: (payload: Record<string, unknown>) => void;
  readonly guardCallback: <A extends unknown[]>(fn: (...args: A) => unknown) => ((...args: A) => void);
}): void {
  const listener = (config: PluginConfig) => options.guardCallback(options.handler)(config as Record<string, unknown>);
  options.state.configListeners.add(listener);
  options.state.eventSubscriptions.set(options.subscriptionId, () => options.state.configListeners.delete(listener));
}
