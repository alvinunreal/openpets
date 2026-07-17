import { app } from "electron";

import { getAppStateSnapshot, getDesktopAnalyticsConsentState, recordDesktopAppStarted } from "./app-state.js";
import { debug, error as logError, info } from "./logger.js";

type DesktopAnalyticsEvent =
  | "desktop_app_started"
  | "desktop_first_run_seen"
  | "desktop_analytics_consent_changed"
  | "desktop_default_pet_shown"
  | "desktop_control_center_opened"
  | "desktop_companion_enabled"
  | "desktop_companion_disabled"
  | "desktop_pet_catalog_opened"
  | "desktop_pet_install_started"
  | "desktop_pet_install_completed"
  | "desktop_pet_install_failed"
  | "desktop_pet_local_import_started"
  | "desktop_pet_local_import_completed"
  | "desktop_pet_local_import_failed"
  | "desktop_default_pet_changed"
  | "desktop_agent_setup_started"
  | "desktop_agent_setup_completed"
  | "desktop_agent_setup_failed"
  | "desktop_ipc_server_started"
  | "desktop_ipc_server_failed"
  | "desktop_agent_connected"
  | "desktop_integration_activity_received"
  | "desktop_lease_acquired"
  | "desktop_plugin_catalog_opened"
  | "desktop_plugin_install_started"
  | "desktop_plugin_installed"
  | "desktop_plugin_install_failed"
  | "desktop_plugin_enabled"
  | "desktop_plugin_disabled"
  | "desktop_plugin_command_run"
  | "desktop_plugin_runtime_error"
  | "desktop_update_check_completed"
  | "desktop_update_check_failed"
  | "desktop_catalog_fetch_failed"
  | "desktop_renderer_error";

type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

const defaultPostHogHost = "https://hug.boringdystopia.ai";
const defaultPostHogKey = "phc_uUVf9cW3HXjSyx6sxbNRk9T3pdHCrNgkm2Jm6NX9fDcb";
const analyticsSchemaVersion = 2;
const flushIntervalMs = 10_000;
const maxQueueSize = 100;
const reservedPropertyKeys = new Set(["surface", "analytics_schema_version", "app_version", "platform", "arch", "locale", "packaged", "token", "distinct_id"]);

let flushTimer: NodeJS.Timeout | null = null;
let queue: Array<{ readonly event: DesktopAnalyticsEvent; readonly properties: AnalyticsProps; readonly timestamp: string }> = [];
let initialized = false;
let flushInFlight: Promise<void> | null = null;
const integrationActivityKeys = new Set<string>();

export function initializeDesktopAnalytics(): void {
  if (initialized) return;
  initialized = true;
  if (!isCaptureRuntimeEnabled()) {
    debug("app", "desktop analytics capture disabled", { packaged: app.isPackaged });
    return;
  }
  flushTimer = setInterval(() => void flushDesktopAnalytics(), flushIntervalMs);
  flushTimer.unref?.();
  info("app", "desktop analytics initialized", { host: getPostHogHost(), consent: getDesktopAnalyticsConsentState().consent });
}

export function trackDesktopStartup(): void {
  const result = recordDesktopAppStarted(Date.now(), getDesktopAnalyticsConsentState().consent === "granted");
  trackDesktopEvent("desktop_app_started", { first_run: result.firstRun, app_started_count: result.state.analytics.appStartedCount });
  if (result.firstRun) trackDesktopEvent("desktop_first_run_seen");
}

export function trackDesktopAnalyticsConsentChanged(consent: "granted" | "denied" | "unset"): void {
  if (consent !== "granted") {
    queue = [];
    return;
  }
  // Consent changes are safe operational metadata. A newly granted consent event
  // should be flushed immediately so PostHog reflects the opt-in state.
  trackDesktopEvent("desktop_analytics_consent_changed", { consent }, { respectConsent: false });
  void flushDesktopAnalytics();
}

export function trackDesktopIntegrationActivity(activityKind: "react" | "say" | "showMedia", properties: AnalyticsProps = {}): void {
  if (getDesktopAnalyticsConsentState().consent !== "granted") return;
  const key = [activityKind, properties.integration_type, properties.target_kind, properties.shown, properties.reason].map((value) => String(value ?? "unknown")).join(":");
  if (integrationActivityKeys.has(key)) return;
  integrationActivityKeys.add(key);
  trackDesktopEvent("desktop_integration_activity_received", { ...properties, activity_kind: activityKind });
}

export function classifyAnalyticsError(error: unknown, fallback = "unknown_error"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const name = error instanceof Error ? error.name : "";
  const value = `${name} ${message}`.toLowerCase();
  if (value.includes("timeout") || value.includes("timed out")) return "timeout";
  if (value.includes("permission") || value.includes("denied")) return "permission_denied";
  if (value.includes("not found") || value.includes("enoent") || value.includes("404")) return "not_found";
  if (value.includes("network") || value.includes("fetch") || value.includes("socket") || value.includes("econn")) return "network_error";
  if (value.includes("validation") || value.includes("invalid") || value.includes("parse") || value.includes("json")) return "validation_error";
  return safeEnum(fallback);
}

export function trackDesktopEvent(event: DesktopAnalyticsEvent, properties: AnalyticsProps = {}, options: { readonly respectConsent?: boolean } = {}): void {
  const respectConsent = options.respectConsent !== false;
  if (respectConsent && getDesktopAnalyticsConsentState().consent !== "granted") return;
  if (!isCaptureRuntimeEnabled()) return;
  const state = getAppStateSnapshot();
  queue.push({ event, properties: sanitizeProperties(properties, state), timestamp: new Date().toISOString() });
  if (queue.length > maxQueueSize) queue = queue.slice(-maxQueueSize);
  if (queue.length >= 10) void flushDesktopAnalytics();
}

export async function flushDesktopAnalytics(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  if (getDesktopAnalyticsConsentState().consent !== "granted") {
    queue = [];
    return;
  }
  if (queue.length === 0 || !isCaptureRuntimeEnabled()) return;
  flushInFlight = doFlushDesktopAnalytics().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doFlushDesktopAnalytics(): Promise<void> {
  const batch = queue;
  queue = [];
  const state = getAppStateSnapshot();
  const host = getPostHogHost();
  const apiKey = getPostHogKey();
  try {
    const response = await fetch(`${host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        api_key: apiKey,
        batch: batch.map((item) => ({
          event: item.event,
          distinct_id: state.analytics.distinctId,
          timestamp: item.timestamp,
          properties: { token: apiKey, distinct_id: state.analytics.distinctId, ...item.properties },
        })),
      }),
    });
    if (!response.ok) throw new Error(`PostHog capture failed with HTTP ${response.status}.`);
  } catch (error) {
    if (getDesktopAnalyticsConsentState().consent === "granted") queue = [...batch, ...queue].slice(-maxQueueSize);
    logError("app", "desktop analytics flush failed", error);
  }
}

export function shutdownDesktopAnalytics(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  void flushDesktopAnalytics();
}

function sanitizeProperties(properties: AnalyticsProps, state: ReturnType<typeof getAppStateSnapshot>): AnalyticsProps {
  const sanitized: AnalyticsProps = {
    surface: "desktop",
    analytics_schema_version: analyticsSchemaVersion,
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: state.preferences.locale,
    packaged: app.isPackaged,
  };

  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-zA-Z0-9_.$-]{1,64}$/.test(key)) continue;
    if (reservedPropertyKeys.has(key)) continue;
    if (typeof value === "string") sanitized[key] = safeString(value);
    else if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === "boolean" || value === null || value === undefined) sanitized[key] = value;
  }
  return sanitized;
}

function safeEnum(value: string): string {
  return safeString(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || "unknown";
}

function safeString(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 200);
}

function isCaptureRuntimeEnabled(): boolean {
  return app.isPackaged || process.env.OPENPETS_ANALYTICS_DEBUG === "1";
}

function getPostHogHost(): string {
  return normalizeHttpsUrl(process.env.OPENPETS_POSTHOG_HOST) ?? defaultPostHogHost;
}

function getPostHogKey(): string {
  return process.env.OPENPETS_POSTHOG_KEY || defaultPostHogKey;
}

function normalizeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
