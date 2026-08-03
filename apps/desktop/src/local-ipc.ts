import { randomBytes } from "node:crypto";
import net from "node:net";

import { Notification, shell, systemPreferences } from "electron";

import { applyAgentPetReaction, applyAgentPetSay, applyAgentPetShowMedia, clearAgentPetLeaseState, repositionConfinedPet, showAgentPet } from "./agent-pet-controller.js";
import { getAppStateSnapshot, recordOpenPetsActivity } from "./app-state.js";
import { builtInPet } from "./built-in-pet.js";
import { applyExternalPetReaction, applyExternalPetSay, applyExternalPetShowMedia, getDefaultPetPaused, isDefaultPetVisible } from "./default-pet-controller.js";
import { createStaleLeaseStatus, LeaseManager } from "./lease-manager.js";
import { debug, error as logError, info } from "./logger.js";
import { cleanupUnixSocket, getDiscoveryFilePath, getIpcEndpointConfig, parseIpcEndpoint, protectUnixSocket, removeDiscoveryFile, writeDiscoveryFile, type IpcEndpoint, type IpcEndpointConfig, type OpenPetsDiscoveryFile } from "./local-ipc-paths.js";
import { stat } from "node:fs/promises";
import { errorResponse, IpcProtocolError, isRecord, maxIpcMessageBytes, maxMediaFileBytes, okResponse, parseIpcRequest, validateInstallLocalKind, validateInstallLocalPath, validateInstallPetId, validateMediaClickUrl, validateMediaDurationMs, validateMediaPath, validateOptionalLeaseId, validateReaction, validateRequestedPetId, validateSayMessage, validateSessionNonce, type OpenPetsIpcRequest } from "./local-ipc-protocol.js";
import { installPet, installPetFromFolderWithResult, installPetFromZipFileWithResult } from "./pet-installation.js";
import { clearConfinementState, setConfinementState } from "./confinement-manager.js";
import { isConfinementSupported } from "./capabilities.js";
import { resolveAndSubscribe, type ConfinementPollerDeps } from "./confinement-poller.js";
import { findTerminalWindowForPid, subscribeWindowTracking, type TerminalWindowInfo } from "./window-tracker.js";
import { warnPetFallback } from "./pet-fallback-notify.js";
import { getEligiblePoolPetIds, resolvePoolAssignment } from "./pet-pool.js";
import { t } from "./i18n/index.js";
import { broadcastLanPetActivity } from "./lan-controller.js";

let ipcServer: net.Server | null = null;
let ipcDiscovery: OpenPetsDiscoveryFile | null = null;
let leaseCleanupTimer: NodeJS.Timeout | null = null;
/** leaseId → window-tracking unsubscribe function (for confined agent pets). */
const confinementUnsubscribers = new Map<string, () => void>();
const leaseManager = new LeaseManager({
  resolveTarget: resolveLeaseTarget,
  getDefaultPetId: () => getCurrentDefaultPet().id,
  getPetDisplayName: (petId, targetKind) => targetKind === "default" ? getCurrentDefaultPet().displayName : getPetDisplayName(petId),
  onFirstExplicitLease: showAgentPet,
  onLastExplicitLease: handleLastExplicitLease,
  onLog: (level, message, fields) => level === "debug" ? debug("lease", message, fields) : info("lease", message, fields),
  isPetEligible,
});

/** Tracks requestedPetIds for which we have already shown a fallback warning notification. */
const warnedFallbackPets = new Set<string>();

/** PIDs of sessions that had pool pets when pool was disabled. Used to respawn on re-enable. */
const suspendedPoolSessions = new Map<number, string | undefined>();

const safePetIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function startLocalIpcServer(): Promise<void> {
  if (ipcServer) {
    debug("ipc", "start skipped", { reason: "already-started" });
    return;
  }

  const endpointConfig = getIpcEndpointConfig();
  const token = randomBytes(32).toString("base64url");
  cleanupUnixSocket(endpointConfig.advertisedEndpoint);

  const server = net.createServer((socket) => handleSocket(socket, token, endpointConfig));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    listenOnEndpoint(server, endpointConfig.bindEndpoint, () => {
      server.off("error", reject);
      protectUnixSocket(endpointConfig.advertisedEndpoint);
      resolve();
    });
  });
  server.on("error", (error) => {
    logError("ipc", "server error", error);
    console.error("OpenPets local IPC server error.", error);
  });

  ipcServer = server;
  const listeningEndpoint = getListeningEndpoint(server, endpointConfig);
  ipcDiscovery = writeDiscoveryFile(listeningEndpoint, token);
  leaseCleanupTimer = setInterval(() => {
    cleanupReleasedLeases(leaseManager.cleanupExpired());
    cleanupReleasedLeases(leaseManager.checkPidLiveness());
  }, 5_000);
  leaseCleanupTimer.unref?.();
  info("ipc", "server started", { endpointKind: endpointConfig.bindEndpoint.kind, bindEndpoint: formatEndpoint(endpointConfig.bindEndpoint), advertisedEndpoint: listeningEndpoint, discoveryPath: getDiscoveryFilePath() });
  console.log(`OpenPets local IPC listening at ${listeningEndpoint}.`);
}

export function stopLocalIpcServer(): void {
  const server = ipcServer;
  const discovery = ipcDiscovery;
  ipcServer = null;
  ipcDiscovery = null;
  info("ipc", "server stopping", { hadServer: Boolean(server), discoveryPath: discovery ? getDiscoveryFilePath() : undefined, endpoint: discovery?.endpoint });
  if (leaseCleanupTimer) clearInterval(leaseCleanupTimer);
  leaseCleanupTimer = null;
  removeDiscoveryFile(discovery);

  if (server) {
    server.close();
  }

  if (discovery) {
    cleanupUnixSocket(discovery.endpoint);
  }
}

/**
 * Handle petPoolEnabled toggle: despawn all active pool pets on disable,
 * respawn pets for still-alive sessions on re-enable.
 * Must be called AFTER the preference has been updated in app state.
 */
export function dispatchPoolToggle(enabled: boolean): void {
  if (!enabled) {
    // Despawn all active pool pets and remember their PIDs for respawn.
    const explicitLeases = leaseManager.getExplicitLeaseSnapshots();
    for (const lease of explicitLeases) {
      const rawLease = leaseManager.getRawLease(lease.leaseId);
      if (!rawLease || rawLease.requestedPetId !== undefined) continue;
      if (lease.clientPid && lease.clientPid > 0) {
        suspendedPoolSessions.set(lease.clientPid, rawLease.sessionNonce);
      }
      releaseExplicitLease(lease.leaseId);
    }
  } else {
    // Re-enable: spawn pets for suspended sessions whose PIDs are still alive.
    const sessionsToRespawn = [...suspendedPoolSessions];
    suspendedPoolSessions.clear();
    for (const [pid, sessionNonce] of sessionsToRespawn) {
      try {
        process.kill(pid, 0);
      } catch {
        continue; // Dead process — skip.
      }
      try {
        leaseManager.acquire(undefined, pid, sessionNonce);
        info("ipc", "respawned pool pet for suspended session", { pid });
      } catch (err) {
        debug("ipc", "pool respawn acquire failed", { pid, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

function handleSocket(socket: net.Socket, token: string, endpointConfig: IpcEndpointConfig): void {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind === "tcp" && !isAllowedRemoteAddress(socket.remoteAddress, bindEndpoint.host)) {
    info("ipc", "socket rejected", { reason: "unauthorized-remote", remoteAddress: socket.remoteAddress, bindHost: bindEndpoint.host });
    socket.destroy();
    return;
  }

  debug("ipc", "socket accepted", { endpointKind: bindEndpoint.kind, remoteAddress: socket.remoteAddress });

  socket.setEncoding("utf8");
  socket.setTimeout(3_000, () => socket.destroy());

  let buffer = "";
  let handled = false;

  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;

    if (Buffer.byteLength(buffer, "utf8") > maxIpcMessageBytes) {
      handled = true;
      info("ipc", "request rejected", { reason: "too-large", bytes: Buffer.byteLength(buffer, "utf8") });
      writeResponse(socket, errorResponse(null, new IpcProtocolError("invalid_request", "IPC request is too large.")));
      return;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    handled = true;
    const raw = buffer.slice(0, newline);
    void handleRawRequest(raw, token).then((response) => writeResponse(socket, response));
  });

  socket.on("error", (error) => {
    if (isBenignSocketCloseError(error)) return;
    logError("ipc", "client socket error", error);
    console.error("OpenPets local IPC client socket error.", error);
  });
}

function listenOnEndpoint(server: net.Server, endpoint: IpcEndpoint, callback: () => void): void {
  if (endpoint.kind === "tcp") {
    server.listen({ host: endpoint.host, port: endpoint.port }, callback);
    return;
  }

  server.listen(endpoint.path, callback);
}

function getListeningEndpoint(server: net.Server, endpointConfig: IpcEndpointConfig): string {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind !== "tcp") return bindEndpoint.path;

  const address = server.address();
  const actualPort = (!address || typeof address === "string") ? bindEndpoint.port : address.port;

  // Use the advertised endpoint if it's different from bind endpoint
  const advertisedParsed = parseIpcEndpoint(endpointConfig.advertisedEndpoint, { allowPortZero: true, allowNonLoopback: true });
  if (advertisedParsed.kind === "tcp" && advertisedParsed.host !== bindEndpoint.host) {
    // Use advertised host with actual port (in case bind used port 0)
    return `tcp://${advertisedParsed.host}:${actualPort}`;
  }

  return `tcp://${bindEndpoint.host}:${actualPort}`;
}

function formatEndpoint(endpoint: IpcEndpoint): string {
  if (endpoint.kind === "tcp") return `tcp://${endpoint.host}:${endpoint.port}`;
  return endpoint.path;
}

function isAllowedRemoteAddress(address: string | undefined, bindHost: string): boolean {
  if (!address) return false;

  // Always allow loopback
  if (address === "::1" || isLoopbackAddress(address)) {
    return true;
  }

  // If binding to 0.0.0.0 or non-loopback, allow private/local addresses
  if (bindHost === "0.0.0.0" || bindHost !== "127.0.0.1") {
    return isPrivateOrLocalAddress(address);
  }

  return false;
}

function isLoopbackAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isPrivateOrLocalAddress(address: string): boolean {
  // Handle IPv4-mapped IPv6 addresses
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;

  // Loopback: 127.0.0.0/8
  if (parts[0] === 127) return true;

  // Private: 10.0.0.0/8
  if (parts[0] === 10) return true;

  // Private: 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // Private: 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // Link-local: 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

async function handleRawRequest(raw: string, token: string) {
  let requestId: string | null = null;
  try {
    const request = parseIpcRequest(raw, token);
    requestId = request.id;
    debug("ipc", "request received", { requestId, method: request.method });
    return okResponse(request.id, await handleRequest(request));
  } catch (error) {
    logError("ipc", "request failed", error instanceof Error ? error : { requestId, error });
    return errorResponse(requestId, error);
  }
}

async function handleRequest(request: OpenPetsIpcRequest): Promise<unknown> {
  if (request.method === "hello") {
    return {
      ok: true,
      protocol: "openpets-ipc",
      protocolVersion: 1,
      appVersion: ipcDiscovery?.appVersion ?? "0.0.0",
    };
  }

  if (request.method === "status") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateOptionalLeaseId(params.leaseId);
    if (leaseId) {
      const lease = leaseManager.get(leaseId);
      if (!lease) return createStaleLeaseStatus(leaseId);
      return { ok: true, appRunning: true, ...lease };
    }
    const state = getAppStateSnapshot();
    const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId) ?? builtInPet;
    return {
      ok: true,
      appRunning: true,
      protocolVersion: 1,
      appVersion: ipcDiscovery?.appVersion ?? "0.0.0",
      defaultPet: {
        id: defaultPet.id,
        displayName: defaultPet.displayName,
        builtIn: defaultPet.builtIn,
        broken: "broken" in defaultPet && defaultPet.broken === true,
      },
      paused: getDefaultPetPaused(),
      defaultPetVisible: isDefaultPetVisible(),
      openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch,
      speechBubblesEnabled: state.preferences.speechBubblesEnabled,
    };
  }

  if (request.method === "pets.list") {
    const state = getAppStateSnapshot();
    return {
      ok: true,
      pets: state.pets.installed.map((pet) => ({
        id: pet.id,
        displayName: pet.displayName,
        builtIn: pet.builtIn,
        broken: pet.broken === true,
      })),
      defaultPetId: state.preferences.defaultPetId,
    };
  }

  if (request.method === "pets.install") {
    const params = isRecord(request.params) ? request.params : {};
    const petId = validateInstallPetId(params.petId);
    const state = await installPet(petId);
    const installed = state.pets.installed.find((pet) => pet.id === petId);
    if (!installed) throw new IpcProtocolError("install_failed", "Pet install did not complete.");
    return { ok: true, petId: installed.id, displayName: installed.displayName, installed: true };
  }

  if (request.method === "pets.install-local") {
    const params = isRecord(request.params) ? request.params : {};
    const localPath = validateInstallLocalPath(params.path);
    const kind = validateInstallLocalKind(params.kind);
    const stats = await stat(localPath);
    let installResult;
    if (kind === "folder") {
      if (!stats.isDirectory()) throw new IpcProtocolError("invalid_params", "Local pet path must be a folder.");
      installResult = await installPetFromFolderWithResult(localPath);
    } else {
      if (!stats.isFile()) throw new IpcProtocolError("invalid_params", "Local pet path must be a zip file.");
      installResult = await installPetFromZipFileWithResult(localPath);
    }
    const installedPet = installResult.state.pets.installed.find((pet) => pet.id === installResult.petId);
    if (!installedPet) throw new IpcProtocolError("install_failed", "Local pet install did not complete.");
    return { ok: true, petId: installedPet.id, displayName: installedPet.displayName, installed: true };
  }

  if (request.method === "lease.acquire") {
    const params = isRecord(request.params) ? request.params : {};
    const requestedPetId = validateRequestedPetId(params.requestedPetId);
    const clientPid = typeof params.clientPid === "number" && params.clientPid > 0 ? params.clientPid : undefined;
    const sessionNonce = validateSessionNonce(params.sessionNonce);
    debug("ipc", "lease acquire requested", { requestId: request.id, requestedPetId, clientPid, sessionNonce });
    const lease = leaseManager.acquire(requestedPetId, clientPid, sessionNonce);
    warnPetFallback(requestedPetId, lease.fallbackReason, warnedFallbackPets);
    // Resolve terminal window identity asynchronously (non-blocking).
    // Only attempt on macOS where window-bounds polling is supported.
    if (clientPid !== undefined && isConfinementSupported()) {
      void resolveTerminalIdentity(lease.leaseId, clientPid);
    }
    return lease;
  }

  if (request.method === "lease.heartbeat") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateRequiredLeaseId(params.leaseId);
    debug("ipc", "lease heartbeat requested", { requestId: request.id, leaseId });
    try {
      return leaseManager.heartbeat(leaseId);
    } catch {
      throw new IpcProtocolError("unknown_lease", "Unknown or expired lease.");
    }
  }

  if (request.method === "lease.release") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateRequiredLeaseId(params.leaseId);
    debug("ipc", "lease release requested", { requestId: request.id, leaseId });
    // Clean up confinement subscription for this lease if one exists.
    const rawLease = leaseManager.getRawLease(leaseId);
    if (rawLease?.targetKind === "explicit") {
      return releaseExplicitLease(leaseId);
    }
    return leaseManager.release(leaseId);
  }

  if (request.method === "pet.react") {
    const params = isRecord(request.params) ? request.params : {};
    const reaction = validateReaction(params.reaction);
    const lease = getLeaseTarget(params.leaseId);
    const petId = lease?.actualTargetPetId ?? getCurrentDefaultPet().id;
    debug("ipc", "pet react requested", { requestId: request.id, reaction, leaseId: lease?.leaseId, targetKind: lease?.targetKind, actualPetId: lease?.actualTargetPetId });
    if (lease?.targetKind === "explicit") {
      const applied = applyAgentPetReaction(lease.actualTargetPetId, reaction);
      safeRecordOpenPetsActivity({ kind: "react", reaction, petId, surface: "agent" });
      return { ok: true, reaction, shown: applied.shown, reason: applied.reason, leaseId: lease.leaseId };
    }
    const applied = applyExternalPetReaction(reaction);
    broadcastLanPetActivity(reaction);
    safeRecordOpenPetsActivity({ kind: "react", reaction, petId, surface: "default" });
    return { ok: true, reaction, shown: applied.shown, reason: applied.reason };
  }

  if (request.method === "pet.showMedia") {
    const params = isRecord(request.params) ? request.params : {};
    const mediaPath = validateMediaPath(params.path);
    const message = params.message === undefined ? undefined : validateSayMessage(params.message);
    const reaction = params.reaction === undefined ? undefined : validateReaction(params.reaction);
    const durationMs = validateMediaDurationMs(params.durationMs);
    const clickUrl = validateMediaClickUrl(params.clickUrl);
    let mediaStat;
    try {
      mediaStat = await stat(mediaPath);
    } catch {
      throw new IpcProtocolError("invalid_params", "Media path does not exist or is not readable.");
    }
    if (!mediaStat.isFile()) throw new IpcProtocolError("invalid_params", "Media path is not a file.");
    if (mediaStat.size > maxMediaFileBytes) throw new IpcProtocolError("invalid_params", "Media file is too large.");
    const lease = getLeaseTarget(params.leaseId);
    const petId = lease?.actualTargetPetId ?? getCurrentDefaultPet().id;
    debug("ipc", "pet showMedia requested", { requestId: request.id, reaction, mediaBytes: mediaStat.size, durationMs, leaseId: lease?.leaseId, targetKind: lease?.targetKind, actualPetId: lease?.actualTargetPetId });
    if (lease?.targetKind === "explicit") {
      const applied = applyAgentPetShowMedia(lease.actualTargetPetId, { mediaPath, message, reaction, durationMs, clickUrl });
      safeRecordOpenPetsActivity({ kind: "say", reaction, petId, surface: "agent" });
      return { ok: true, shown: applied.shown, reason: applied.reason, reaction, leaseId: lease.leaseId };
    }
    const applied = applyExternalPetShowMedia({ mediaPath, message, reaction, durationMs, clickUrl });
    safeRecordOpenPetsActivity({ kind: "say", reaction, petId, surface: "default" });
    return { ok: true, shown: applied.shown, reason: applied.reason, reaction };
  }

  const params = isRecord(request.params) ? request.params : {};
  const message = validateSayMessage(params.message);
  const reaction = params.reaction === undefined ? undefined : validateReaction(params.reaction);
  const lease = getLeaseTarget(params.leaseId);
  const petId = lease?.actualTargetPetId ?? getCurrentDefaultPet().id;
  debug("ipc", "pet say requested", { requestId: request.id, reaction, messageLength: message.length, leaseId: lease?.leaseId, targetKind: lease?.targetKind, actualPetId: lease?.actualTargetPetId });
  if (lease?.targetKind === "explicit") {
    const applied = applyAgentPetSay(lease.actualTargetPetId, message, reaction);
    safeRecordOpenPetsActivity({ kind: "say", reaction, petId, surface: "agent" });
    return { ok: true, shown: applied.shown, reason: applied.reason, reaction, leaseId: lease.leaseId };
  }
  const applied = applyExternalPetSay(message, reaction);
  safeRecordOpenPetsActivity({ kind: "say", reaction, petId, surface: "default" });
  return { ok: true, shown: applied.shown, reason: applied.reason, reaction };
}

function safeRecordOpenPetsActivity(activity: Parameters<typeof recordOpenPetsActivity>[0]): void {
  try {
    recordOpenPetsActivity(activity);
  } catch (error) {
    debug("ipc", "activity record failed", { error: error instanceof Error ? error.message : String(error), kind: activity.kind, reaction: activity.reaction, petId: activity.petId });
  }
}

function validateRequiredLeaseId(value: unknown): string {
  const leaseId = validateOptionalLeaseId(value);
  if (!leaseId) throw new IpcProtocolError("invalid_params", "Lease id is required.");
  return leaseId;
}

function getLeaseTarget(value: unknown) {
  const leaseId = validateOptionalLeaseId(value);
  if (!leaseId) return null;
  const lease = leaseManager.get(leaseId);
  if (!lease) throw new IpcProtocolError("unknown_lease", "Unknown or expired lease.");
  return lease;
}

function handleLastExplicitLease(petId: string): void {
  info("ipc", "last explicit lease ended", { petId });
  clearAgentPetLeaseState(petId);
  clearConfinementState(petId);
}

function cleanupReleasedLeases(leases: readonly { readonly leaseId: string; readonly targetKind: string }[]): void {
  for (const lease of leases) {
    if (lease.targetKind === "explicit") unsubscribeConfinement(lease.leaseId);
  }
}

function releaseExplicitLease(leaseId: string): { readonly released: boolean } {
  unsubscribeConfinement(leaseId);
  return leaseManager.release(leaseId);
}

async function resolveTerminalIdentity(leaseId: string, clientPid: number): Promise<void> {
  // Get the petId — required to key confinement state. Non-explicit leases
  // don't participate in window confinement.
  const lease = leaseManager.getRawLease(leaseId);
  if (!lease || lease.targetKind !== "explicit") return;
  const petId = lease.actualPetId;

  const deps: ConfinementPollerDeps = {
    findTerminal: async (pid) => {
      const termInfo = await findTerminalWindowForPid(pid);
      // Diagnostic: distinguish (A) zero windows [permission], (B) no ancestor,
      // (C) resolved. window-tracker already logs windowCount at info level.
      if (!termInfo) {
        info("ipc", "terminal identity first resolve returned null — poller will self-heal", {
          leaseId,
          clientPid: pid,
        });
      } else {
        info("ipc", "terminal identity resolved", {
          leaseId,
          clientPid: pid,
          terminalPid: termInfo.terminalPid,
          appName: termInfo.appName,
          isMinimized: termInfo.isMinimized,
          isOccluded: termInfo.isOccluded,
        });
      }
      return termInfo;
    },
    subscribe: (id, pid, onFound, onNull) => subscribeWindowTracking(id, pid, onFound, onNull),
    setIdentity: (termInfo) => leaseManager.setTerminalIdentity(leaseId, {
      terminalOwnerPid: termInfo.terminalPid,
      terminalAppName: termInfo.appName,
      terminalWindowId: termInfo.window?.id,
    }),
    applyUpdate: (termInfo) => applyConfinementUpdate(petId, termInfo),
    isAlive: () => !!leaseManager.getRawLease(leaseId),
    onDead: () => unsubscribeConfinement(leaseId),
    // Phase 2: Screen Recording permission — macOS only.
    // On Windows and Linux there is no SR permission concept; window enumeration
    // is available without it, so we treat the status as always "granted".
    getScreenPermissionStatus: () =>
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted",
    // Phase 2: opens the SR pane in System Settings on macOS.
    // No-op on other platforms (they have no equivalent permission to grant).
    promptScreenPermission: () => {
      if (process.platform === "darwin") {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      }
    },
    // Phase 2: fires the one-time actionable notification (macOS only).
    notifyScreenPermission: (onAction) => {
      if (process.platform !== "darwin") return;
      info("ipc", "Screen Recording permission not granted — showing notification", {
        leaseId,
        status: systemPreferences.getMediaAccessStatus("screen"),
      });
      if (!Notification.isSupported()) return;
      const title = t("confinement.screenPermission.title");
      const body = t("confinement.screenPermission.body");
      const n = new Notification({ title, body, silent: true });
      n.on("click", onAction);
      n.show();
    },
  };

  try {
    await resolveAndSubscribe(leaseId, clientPid, deps, confinementUnsubscribers);
  } catch (err) {
    info("ipc", "terminal identity resolution error", { leaseId, clientPid, error: String(err) });
  }
}

function applyConfinementUpdate(petId: string, info: TerminalWindowInfo): void {
  setConfinementState(petId, {
    terminalBounds: info.window?.bounds ?? null,
    terminalMinimized: info.isMinimized,
    terminalOccluded: info.isOccluded,
    terminalOwnerPid: info.terminalPid,
    appName: info.appName,
  });
  // Immediately reposition the pet if it's already visible.
  repositionConfinedPet(petId);
}

function unsubscribeConfinement(leaseId: string): void {
  const unsub = confinementUnsubscribers.get(leaseId);
  if (unsub) { unsub(); confinementUnsubscribers.delete(leaseId); }
}

function writeResponse(socket: net.Socket, response: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function isBenignSocketCloseError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "ERR_STREAM_DESTROYED";
}

function resolveLeaseTarget(requestedPetId: string | undefined): { readonly targetKind: "default" | "explicit"; readonly actualPetId: string; readonly fallbackReason?: "invalid_pet_id" | "pet_not_installed" | "pet_broken" | "default_broken_fallback_builtin" } {
  const defaultPet = getCurrentDefaultPetWithFallback();

  if (!requestedPetId) {
    // No explicit pet requested — check pool before falling back to default.
    // INVARIANT: tryResolveFromPool() and the subsequent lease registration in
    // LeaseManager.acquire() MUST remain synchronous (no await between them);
    // otherwise two concurrent acquire(undefined) calls could claim the same slot.
    const poolResult = tryResolveFromPool();
    if (poolResult) return { targetKind: "explicit", actualPetId: poolResult.petId };
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: defaultPet.fallbackReason };
  }

  // Explicit request for the built-in or the current default: honour it directly
  // without consulting the pool (pre-pool semantics, "explicit always wins").
  if (requestedPetId === builtInPet.id || requestedPetId === defaultPet.id) {
    return { targetKind: "default", actualPetId: defaultPet.id };
  }

  if (!safePetIdPattern.test(requestedPetId)) {
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "invalid_pet_id" };
  }
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === requestedPetId);
  if (!pet) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_not_installed" };
  if (pet.broken) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_broken" };
  return { targetKind: "explicit", actualPetId: pet.id };
}

function tryResolveFromPool(): { readonly petId: string } | null {
  const state = getAppStateSnapshot();
  // Master toggle: when disabled, ignore the pool entirely (legacy shared-default behaviour).
  // Platform-independent — this resolution path runs identically on macOS, Windows and Linux,
  // and for any MCP client (Claude Code CLI, opencode, Cursor, …) that acquires a no-pet lease.
  if (!state.preferences.petPoolEnabled) return null;
  const pool = state.preferences.petPoolOrder;
  if (!pool || pool.length === 0) return null;

  const defaultPet = getCurrentDefaultPet();
  const eligiblePetIds = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, defaultPet.id);
  return resolvePoolAssignment({
    orderedPool: pool,
    eligiblePetIds,
    countActiveExplicit: (petId) => leaseManager.countExplicitLeases(petId),
  });
}

function getCurrentDefaultPet(): { readonly id: string; readonly displayName: string } {
  const pet = getCurrentDefaultPetWithFallback();
  return { id: pet.id, displayName: pet.displayName };
}

function getCurrentDefaultPetWithFallback(): { readonly id: string; readonly displayName: string; readonly fallbackReason?: "default_broken_fallback_builtin" } {
  const state = getAppStateSnapshot();
  const configuredDefault = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  if (configuredDefault && !configuredDefault.broken) return configuredDefault;
  return { ...builtInPet, fallbackReason: "default_broken_fallback_builtin" };
}

function getPetDisplayName(petId: string): string {
  return getAppStateSnapshot().pets.installed.find((pet) => pet.id === petId)?.displayName ?? petId;
}

function isPetEligible(petId: string): boolean {
  return getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken);
}
