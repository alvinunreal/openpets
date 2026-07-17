import type { PluginConfig } from "./plugin-config.js";
import type { PluginCommand, PluginBubbleDismissReason, PluginBubbleHostHandle, PluginDeliveryDismissReason, PluginDeliveryHostHandle, PluginMenuItem, PluginPanelHostHandle, PluginStatus } from "./plugin-sdk-bridge.js";
import type { PluginTimerHandle } from "./plugin-runtime.js";

export type ScheduleSpec =
  | { type: "once"; delayMs: number }
  | { type: "every"; intervalMs: number }
  | { type: "daily"; daily: { time: string; days?: number[] } }
  | { type: "cron"; expr: string }
  | { type: "at"; timestamp: number };

export type ScheduleSlot = { spec: ScheduleSpec; callback: () => unknown; handle: PluginTimerHandle; nextRunMs: number };
export type BubbleSlot = { host: PluginBubbleHostHandle; onAction?: (actionId: string) => void; onSubmit?: (values: Record<string, string | number>) => void; onDismiss?: (reason: PluginBubbleDismissReason) => void; dismissed: boolean };
export type DeliverySlot = { key: string; host?: PluginDeliveryHostHandle; onDismiss?: (reason: PluginDeliveryDismissReason) => void; dismissed: boolean };

export class WindowCounter {
  count = 0;
  started = Date.now();
  tick(max: number, label: string): void { const now = Date.now(); if (now - this.started >= 60_000) this.reset(); this.count += 1; if (this.count > max) throw new Error(`Plugin ${label} quota exceeded.`); }
  reset(): void { this.count = 0; this.started = Date.now(); }
}

export type PluginRuntimeState = {
  commands: Map<string, { meta: PluginCommand; handler: (values?: Record<string, unknown>) => unknown | Promise<unknown> }>;
  menuItems: PluginMenuItem[];
  menuHandlers: Set<(id: string) => void>;
  status?: PluginStatus;
  schedules: Map<string, ScheduleSlot>;
  configListeners: Set<(config: PluginConfig) => void>;
  storageSubscriptions: Map<string, { key: string; handler: (value: unknown) => void }>;
  busSubscriptions: Map<string, { topic: string; handler: (payload: unknown) => void }>;
  eventSubscriptions: Map<string, () => void>;
  tickSubscriptions: Map<string, () => void>;
  bubbles: Map<string, BubbleSlot>;
  deliveries: Map<string, DeliverySlot>;
  panels: Map<string, PluginPanelHostHandle & { onMessage?: (msg: unknown) => void }>;
  spawnedPets: Set<string>;
  pickedFiles: Set<string>;
  userCommandDepth: number;
  lastError?: string;
  petWindow: WindowCounter;
  logWindow: WindowCounter;
  httpWindow: WindowCounter;
  busWindow: WindowCounter;
  audioWindow: WindowCounter;
  notifyWindow: WindowCounter;
  toastWindow: WindowCounter;
  deliveryWindow: WindowCounter;
  companionWindow: WindowCounter;
  aiWindow: WindowCounter;
  voiceWindow: WindowCounter;
};

export type PluginInspectorState = {
  schedules: Array<{ id: string; type: ScheduleSpec["type"]; nextRunMs: number }>;
  commands: readonly PluginCommand[];
  menuItems: readonly PluginMenuItem[];
  status?: PluginStatus;
  activeBubbles: number;
  activePanels: number;
  eventSubscriptions: number;
  lastError?: string;
  quotaCounters: Record<string, number>;
};
