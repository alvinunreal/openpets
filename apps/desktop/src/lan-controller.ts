import { app, screen as ElectronScreen } from "electron";
import { createServer, request } from "node:http";
import { hostname } from "node:os";
import { URL } from "node:url";

import { defaultPetWindowSize } from "./display.js";
import { getAppStateSnapshot } from "./app-state.js";
import { getDefaultPetLanPosition, hideDefaultPetForLan, showDefaultPetForLan } from "./default-pet-controller.js";
import { resolveLanAuthConfig, type LanAuthSource } from "./lan-auth.js";
import { defaultLanRetryOptions, getLanRetryDelayMs, shouldHideLanPetAfterMisses, shouldLogLanPollFailure } from "./lan-client-retry.js";
import { createLanRequestHandler } from "./lan-http-controller.js";
import { readPersistedLanState, writePersistedLanState } from "./lan-persistence.js";
import { getLanVisitingPetPosition, syncLanVisitingPets } from "./lan-pet-controller.js";
import { LanCoordinator, countLanTopologyLinks, normalizeLanHost, normalizeLanTopology, validateLanTopology, type LanEdge, type LanPoint, type LanState, type LanTopology, type LanTopologyIssue } from "./lan-state.js";
import { info, warn, error as logError } from "./logger.js";

type LanMode = "off" | "server" | "client";

export type LanStatusSnapshot = {
  readonly mode: LanMode;
  readonly localHost: string;
  readonly serverUrl: string;
  readonly port: number;
  readonly auth: "token" | "none";
  readonly authSource: LanAuthSource;
  readonly authInsecure: boolean;
  readonly tokenHint: string | null;
  readonly topologyHosts: number;
  readonly topologyLinks: number;
  readonly topologyIssues: readonly LanTopologyIssue[];
  readonly currentHost: string | null;
  readonly clients: readonly { readonly host: string; readonly lastSeen: number; readonly position?: { readonly x: number; readonly y: number } }[];
  readonly updatedAt: number;
  readonly persistedCurrentHost: string | null;
  readonly persistedUpdatedAt: number | null;
};

const defaultPort = 3787;
const staleClientMs = 15_000;
const pollMs = defaultLanRetryOptions.baseDelayMs;
const requestTimeoutMs = 8_000;
const maxLanResponseBodyBytes = 16 * 1024;
const edgeThresholdPx = 18;

let coordinator = new LanCoordinator({ staleClientMs });
let pollTimer: NodeJS.Timeout | null = null;
let serverStarted = false;
let serverStarting = false;
let missedPolls = 0;
let lastPollWarningAt = 0;
let multiPetEnabled = false;
let lastLanState: LanState | null = null;

export function startLanController(): void {
  const mode = normalizeMode(process.env.OPENPETS_LAN_MODE);
  if (mode === "off") return;

  const localHost = normalizeLanHost(process.env.OPENPETS_LAN_HOSTNAME) || hostname();
  const port = normalizePort(process.env.OPENPETS_LAN_PORT) ?? defaultPort;
  const serverUrl = normalizeServerUrl(process.env.OPENPETS_LAN_SERVER, port);
  const auth = resolveLanAuthConfig(app.getPath("userData"), process.env, { serverMode: mode === "server" });
  const token = auth.token;
  const topology = parseLanTopology(process.env.OPENPETS_LAN_TOPOLOGY);
  multiPetEnabled = process.env.OPENPETS_LAN_PETS === "multi";
  const topologyIssues = validateLanTopology(topology);
  coordinator = new LanCoordinator({ staleClientMs, topology });
  for (const issue of topologyIssues) warn("app", "lan topology issue", issue);

  if (mode === "server") {
    if (auth.insecure) warn("app", "lan server started with explicit insecure auth", { risk: "local_network_hosts_can_control_pet" });
    if (auth.source === "generated") info("app", "lan token generated", { tokenHint: auth.tokenHint });
    void startLanServer(port, token).then((started) => {
      if (started) startLanClient(serverUrl, localHost, token);
    });
  } else if (!token && !auth.insecure) {
    warn("app", "lan client has no token", { hint: "set_OPENPETS_LAN_TOKEN_to_match_server" });
  } else {
    startLanClient(serverUrl, localHost, token);
  }
  info("app", "lan controller started", { mode, serverUrl, localHost, port, auth: token ? "token" : "none", authSource: auth.source, topologyHosts: Object.keys(topology).length, topologyLinks: countLanTopologyLinks(topology), topologyIssues: topologyIssues.length });
}

function startLanServer(port: number, token: string | null): Promise<boolean> {
  if (serverStarted) return Promise.resolve(true);
  if (serverStarting) return Promise.resolve(false);
  serverStarting = true;

  const userDataPath = app.getPath("userData");
  const persistedState = readPersistedLanState(userDataPath);
  if (persistedState?.currentHost) {
    coordinator.setPreferredHost(persistedState.currentHost);
    info("app", "lan restored persisted owner", { currentHost: persistedState.currentHost, updatedAt: persistedState.updatedAt });
  }

  const server = createServer(createLanRequestHandler(coordinator, token, {
    onError: (requestError) => logError("app", "lan request failed", requestError),
    onStateChange: (state) => {
      try {
        writePersistedLanState(userDataPath, state);
      } catch (persistError) {
        logError("app", "lan persistence failed", persistError);
      }
    },
  }));
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs + 1_000;

  return new Promise((resolve) => {
    server.once("listening", () => {
      serverStarting = false;
      serverStarted = true;
      info("app", "lan server listening", { port });
      resolve(true);
    });
    server.once("error", (serverError) => {
      serverStarting = false;
      serverStarted = false;
      logError("app", "lan server error", serverError);
      resolve(false);
    });
    server.listen(port, "0.0.0.0");
  });
}

function startLanClient(serverUrl: string, localHost: string, token: string | null): void {
  void registerLanClient(serverUrl, localHost, token).finally(() => {
    scheduleLanPoll(serverUrl, localHost, token, pollMs);
  });
}

async function registerLanClient(serverUrl: string, localHost: string, token: string | null): Promise<void> {
  try {
    const position = getDefaultPetLanPosition();
    const state = await postJson<LanState>(`${serverUrl}/register`, {
      host: localHost,
      position,
      ...(multiPetEnabled ? { petId: getAppStateSnapshot().preferences.defaultPetId } : {}),
    }, token);
    missedPolls = 0;
    applyLanState(state, localHost);
  } catch (registerError) {
    missedPolls += 1;
    warn("app", "lan register failed", { error: registerError instanceof Error ? registerError.message : String(registerError), missedPolls });
    if (shouldHideLanPetAfterMisses(missedPolls)) {
      hideDefaultPetForLan();
      if (multiPetEnabled) syncLanVisitingPets(localHost, []);
    }
  }
}

function scheduleLanPoll(serverUrl: string, localHost: string, token: string | null, delayMs: number): void {
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollLanServer(serverUrl, localHost, token).finally(() => {
      scheduleLanPoll(serverUrl, localHost, token, getLanRetryDelayMs(missedPolls));
    });
  }, delayMs);
  pollTimer.unref?.();
}
async function pollLanServer(serverUrl: string, localHost: string, token: string | null): Promise<void> {
  try {
    let state: LanState;
    if (multiPetEnabled && lastLanState?.pets) {
      state = await postJson<LanState>(`${serverUrl}/position`, {
        host: localHost,
        position: getDefaultPetLanPosition(),
        edge: null,
      }, token);
      for (const pet of lastLanState.pets) {
        if (pet.currentHost !== localHost) continue;
        const position = pet.ownerHost === localHost ? getDefaultPetLanPosition() : getLanVisitingPetPosition(pet.ownerHost);
        if (!position) continue;
        state = await postJson<LanState>(`${serverUrl}/position`, {
          host: localHost,
          ownerHost: pet.ownerHost,
          position,
          edge: detectEdge(position),
        }, token);
      }
    } else {
      const position = getDefaultPetLanPosition();
      const edge = position ? detectEdge(position) : null;
      state = await postJson<LanState>(`${serverUrl}/position`, { host: localHost, position, edge }, token);
    }
    missedPolls = 0;
    applyLanState(state, localHost);
  } catch (pollError) {
    missedPolls += 1;
    const now = Date.now();
    if (shouldLogLanPollFailure(now, lastPollWarningAt)) {
      lastPollWarningAt = now;
      warn("app", "lan poll failed", { error: pollError instanceof Error ? pollError.message : String(pollError), missedPolls, nextPollMs: getLanRetryDelayMs(missedPolls) });
    }
    if (shouldHideLanPetAfterMisses(missedPolls)) {
      hideDefaultPetForLan();
      if (multiPetEnabled) syncLanVisitingPets(localHost, []);
    }
  }
}

function applyLanState(state: LanState, localHost: string): void {
  lastLanState = state;
  if (multiPetEnabled && state.pets) {
    const localPet = state.pets.find((pet) => pet.ownerHost === localHost);
    if (localPet?.currentHost === localHost) showDefaultPetForLan();
    else hideDefaultPetForLan();
    syncLanVisitingPets(localHost, state.pets);
    return;
  }
  if (state.currentHost === localHost) showDefaultPetForLan();
  else hideDefaultPetForLan();
}

function detectEdge(position: LanPoint): LanEdge | null {
  const display = ElectronScreen.getDisplayNearestPoint({ x: position.x + defaultPetWindowSize.width / 2, y: position.y + defaultPetWindowSize.height / 2 });
  const { workArea } = display;
  if (position.x <= workArea.x + edgeThresholdPx) return "left";
  if (position.x >= workArea.x + workArea.width - defaultPetWindowSize.width - edgeThresholdPx) return "right";
  if (position.y <= workArea.y + edgeThresholdPx) return "up";
  if (position.y >= workArea.y + workArea.height - defaultPetWindowSize.height - edgeThresholdPx) return "down";
  return null;
}

function postJson<T>(target: string, body: Record<string, unknown>, token: string | null): Promise<T> {
  const url = new URL(target);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": payload.length,
    };
    if (token) headers["x-openpets-lan-token"] = token;

    const req = request({
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers,
      timeout: requestTimeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxLanResponseBodyBytes) {
          req.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

function normalizeMode(value: string | undefined): LanMode {
  if (value === "server" || value === "client") return value;
  return "off";
}

function normalizePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function normalizeServerUrl(value: string | undefined, port: number): string {
  if (!value) return `http://127.0.0.1:${port}`;
  try {
    const url = new URL(value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`);
    if (url.protocol !== "http:") {
      warn("app", "lan server url ignored", { reason: "unsupported_protocol", protocol: url.protocol });
      return `http://127.0.0.1:${port}`;
    }
    if (!url.port) url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}


function parseLanTopology(value: string | undefined): LanTopology {
  if (!value) return {};
  try {
    return normalizeLanTopology(JSON.parse(value));
  } catch (parseError) {
    warn("app", "lan topology ignored", { error: parseError instanceof Error ? parseError.message : String(parseError) });
    return {};
  }
}

export function getLanStatusSnapshot(): LanStatusSnapshot {
  const mode = normalizeMode(process.env.OPENPETS_LAN_MODE);
  const localHost = normalizeLanHost(process.env.OPENPETS_LAN_HOSTNAME) || hostname();
  const port = normalizePort(process.env.OPENPETS_LAN_PORT) ?? defaultPort;
  const serverUrl = normalizeServerUrl(process.env.OPENPETS_LAN_SERVER, port);
  const auth = resolveLanAuthConfig(app.getPath("userData"), process.env, { serverMode: mode === "server", generateIfMissing: false });
  const token = auth.token;
  const topology = parseLanTopology(process.env.OPENPETS_LAN_TOPOLOGY);
  const topologyIssues = validateLanTopology(topology);
  const state = coordinator.snapshot(Date.now());
  const persistedState = mode === "server" ? readPersistedLanState(app.getPath("userData")) : null;
  return {
    mode,
    localHost,
    serverUrl,
    port,
    auth: token ? "token" : "none",
    authSource: auth.source,
    authInsecure: auth.insecure,
    tokenHint: auth.tokenHint,
    topologyHosts: Object.keys(topology).length,
    topologyLinks: countLanTopologyLinks(topology),
    topologyIssues,
    currentHost: state.currentHost,
    clients: state.clients,
    updatedAt: state.updatedAt,
    persistedCurrentHost: persistedState?.currentHost ?? null,
    persistedUpdatedAt: persistedState?.updatedAt ?? null,
  };
}
