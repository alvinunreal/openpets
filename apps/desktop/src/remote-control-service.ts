import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";

import {
  errorRemoteResponse,
  isValidOpaqueId,
  isValidRemoteBindAddress,
  isValidRemotePeerAddress,
  isValidRemoteToken,
  maxRemoteMessageBytes,
  normalizeRemoteIpv4Address,
  okRemoteResponse,
  openPetsRemoteVersion,
  parseRemoteControlRequest,
  remoteRateLimitMaxRequests,
  remoteRateLimitWindowMs,
  remoteConnectionDeadlineMs,
  remoteMaxConcurrentSockets,
  remoteSocketTimeoutMs,
  RemoteProtocolError,
  validateRemoteClientName,
  validateRemoteReactParams,
  validateRemoteSayParams,
  validateRemoteScopeList,
  validateRemoteStatusParams,
  type RemoteControlMethod,
  type RemoteControlScope,
  type RemoteStatusSnapshot,
} from "./remote-control-protocol.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import {
  disabledRemoteControlConfig,
  loadRemoteControlState,
  saveRemoteControlState,
  type RemoteControlClientRecord,
  type RemoteControlConfig,
  type RemoteControlState,
} from "./remote-control-state.js";

export interface RemoteControlHandlers {
  readonly getStatusSnapshot: () => RemoteStatusSnapshot;
  readonly applyReaction: (reaction: OpenPetsReaction) => { readonly shown: boolean };
  readonly applySay: (message: string, reaction?: OpenPetsReaction) => { readonly shown: boolean };
}

export interface RemoteControlServiceOptions extends RemoteControlHandlers {
  readonly statePath: string;
  readonly log?: (message: string) => void;
  readonly isDefaultPetAway?: () => boolean;
  readonly socketTimeoutMs?: number;
  readonly connectionDeadlineMs?: number;
  readonly maxConcurrentSockets?: number;
  readonly rateLimitMaxRequests?: number;
  readonly rateLimitWindowMs?: number;
}

export interface RemotePairingResult {
  readonly clientId: string;
  /** This is the only API result that contains the plaintext token. */
  readonly token: string;
}

export interface RemoteControlClientSummary {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly RemoteControlScope[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActivityAt?: number;
  readonly revoked: boolean;
  readonly revokedAt?: number;
}

export interface RemoteControlConfigSnapshot extends RemoteControlConfig {
  readonly listening: boolean;
}

interface RateLimitEntry {
  startedAt: number;
  count: number;
}

let singleton: RemoteControlService | null = null;

export class RemoteControlService {
  private state: RemoteControlState;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly rateLimits = new Map<string, RateLimitEntry>();
  private readonly socketTimeoutMs: number;
  private readonly connectionDeadlineMs: number;
  private readonly maxConcurrentSockets: number;
  private readonly rateLimitMaxRequests: number;
  private readonly rateLimitWindowMs: number;
  private transition: Promise<void> = Promise.resolve();

  public constructor(private readonly options: RemoteControlServiceOptions) {
    this.state = loadRemoteControlState(options.statePath);
    this.socketTimeoutMs = options.socketTimeoutMs ?? remoteSocketTimeoutMs;
    this.connectionDeadlineMs = options.connectionDeadlineMs ?? remoteConnectionDeadlineMs;
    this.maxConcurrentSockets = options.maxConcurrentSockets ?? remoteMaxConcurrentSockets;
    this.rateLimitMaxRequests = options.rateLimitMaxRequests ?? remoteRateLimitMaxRequests;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? remoteRateLimitWindowMs;
  }

  public async start(): Promise<void> {
    return this.enqueueTransition(() => this.startInternal());
  }

  public async stop(): Promise<void> {
    return this.enqueueTransition(() => this.stopInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.server || !this.state.config.enabled) return;
    try {
      await this.startListener(this.state.config);
      this.options.log?.("remote control listener started");
    } catch {
      await this.stopListenerInternal();
      throw new Error("Remote control service could not start.");
    }
  }

  private async stopInternal(): Promise<void> {
    await this.stopListenerInternal();
    this.options.log?.("remote control listener stopped");
  }

  public getConfiguration(): RemoteControlConfigSnapshot {
    return { ...this.state.config, listening: this.server?.listening === true };
  }

  public listClients(): readonly RemoteControlClientSummary[] {
    return this.state.clients.map((client) => ({
      id: client.id,
      name: client.name,
      scopes: [...client.scopes],
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      ...(client.lastActivityAt === undefined ? {} : { lastActivityAt: client.lastActivityAt }),
      revoked: client.revokedAt !== undefined,
      ...(client.revokedAt === undefined ? {} : { revokedAt: client.revokedAt }),
    }));
  }

  public pairClient(input: { readonly name: string; readonly scopes: readonly RemoteControlScope[] }): RemotePairingResult {
    const name = validateRemoteClientName(input.name);
    const scopes = validateRemoteScopeList(input.scopes);
    const now = Date.now();
    const clientId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const client: RemoteControlClientRecord = {
      id: clientId,
      name,
      scopes,
      tokenVerifier: hashRemoteToken(token),
      createdAt: now,
      updatedAt: now,
    };
    this.commitState({ ...this.state, clients: [...this.state.clients, client] });
    return { clientId, token };
  }

  public rotateClient(clientId: string): RemotePairingResult {
    const client = this.findClient(clientId);
    if (!client || client.revokedAt !== undefined) throw new Error("Remote client is unavailable.");
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const nextClient = { ...client, tokenVerifier: hashRemoteToken(token), updatedAt: now };
    this.commitState({ ...this.state, clients: this.state.clients.map((item) => item.id === clientId ? nextClient : item) });
    return { clientId, token };
  }

  public revokeClient(clientId: string): { readonly revoked: boolean } {
    const client = this.findClient(clientId);
    if (!client) throw new Error("Remote client is unavailable.");
    if (client.revokedAt !== undefined) return { revoked: false };
    const now = Date.now();
    this.commitState({
      ...this.state,
      clients: this.state.clients.map((item) => item.id === clientId ? { ...item, revokedAt: now, updatedAt: now } : item),
    });
    return { revoked: true };
  }

  public async configure(input: { readonly enabled: boolean; readonly address?: string; readonly port?: number }): Promise<RemoteControlConfigSnapshot> {
    return this.enqueueTransition(() => this.configureInternal(input));
  }

  private async configureInternal(input: { readonly enabled: boolean; readonly address?: string; readonly port?: number }): Promise<RemoteControlConfigSnapshot> {
    const nextConfig = validateRemoteControlConfig(input);
    const previousConfig = this.state.config;
    if (sameConfig(previousConfig, nextConfig)) {
      if (nextConfig.enabled && !this.server) await this.startInternal();
      return this.getConfiguration();
    }

    await this.stopListenerInternal();
    try {
      if (nextConfig.enabled) await this.startListener(nextConfig);
      this.commitState({ ...this.state, config: nextConfig });
    } catch {
      await this.stopListenerInternal();
      if (previousConfig.enabled) {
        try { await this.startListener(previousConfig); } catch { /* leave the service stopped */ }
      }
      throw new Error("Remote control configuration could not be applied.");
    }
    this.options.log?.(nextConfig.enabled ? "remote control listener configured" : "remote control listener disabled");
    return this.getConfiguration();
  }

  private async startListener(config: RemoteControlConfig): Promise<void> {
    if (!config.enabled || !config.address || config.port === null) return;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
    server.on("error", () => {
      this.options.log?.("remote control listener error");
      if (this.server !== server) return;
      void this.enqueueTransition(async () => {
        if (this.server === server) await this.stopListenerInternal();
      });
    });
    server.on("close", () => {
      if (this.server !== server) return;
      this.server = null;
      this.destroyAllSockets();
      this.rateLimits.clear();
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (): void => reject(new Error("listen failed"));
        server.once("error", onError);
        server.listen({ host: config.address, port: config.port }, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch {
      await closeServerSafely(server);
      if (this.server === server) this.server = null;
      throw new Error("listen failed");
    }
  }

  private async stopListenerInternal(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.destroyAllSockets();
    this.rateLimits.clear();
    if (server) await closeServerSafely(server);
  }

  private handleSocket(socket: net.Socket): void {
    const peerAddress = normalizeRemoteIpv4Address(socket.remoteAddress);
    if (!peerAddress || !isValidRemotePeerAddress(peerAddress)) {
      socket.destroy();
      return;
    }
    if (this.sockets.size >= this.maxConcurrentSockets) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.setTimeout(this.socketTimeoutMs, () => socket.destroy());
    const connectionDeadline = setTimeout(() => socket.destroy(), this.connectionDeadlineMs);
    connectionDeadline.unref?.();

    let buffer = "";
    let handled = false;
    const clearSocketTimers = (): void => {
      clearTimeout(connectionDeadline);
      socket.setTimeout(0);
    };
    const cleanup = (): void => {
      clearSocketTimers();
      this.sockets.delete(socket);
    };
    const finish = (): void => {
      if (!socket.destroyed && !socket.writableEnded) socket.end();
    };
    const reject = (response: ReturnType<typeof errorRemoteResponse>): void => {
      writeRemoteResponse(socket, response);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);

    if (!this.allowRemoteAddress(peerAddress)) {
      reject(errorRemoteResponse(null, "rate_limited"));
      return;
    }

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxRemoteMessageBytes) {
        handled = true;
        reject(errorRemoteResponse(null, "invalid_request"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const raw = buffer.slice(0, newline);
      void this.handleRawRequest(raw).then((response) => {
        writeRemoteResponse(socket, response);
        finish();
      });
    });
  }

  private allowRemoteAddress(address: string | undefined): boolean {
    const key = address ?? "unknown";
    const now = Date.now();
    for (const [entryKey, entry] of this.rateLimits) {
      if (now - entry.startedAt >= this.rateLimitWindowMs) this.rateLimits.delete(entryKey);
    }
    const existing = this.rateLimits.get(key);
    if (this.rateLimits.size > 1024 && !existing) return false;
    if (!existing || now - existing.startedAt >= this.rateLimitWindowMs) {
      this.rateLimits.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (existing.count >= this.rateLimitMaxRequests) return false;
    existing.count += 1;
    return true;
  }

  private destroyAllSockets(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private enqueueTransition<T>(task: () => Promise<T>): Promise<T> {
    const next = this.transition.then(task, task);
    this.transition = next.then(() => undefined, () => undefined);
    return next;
  }

  private async handleRawRequest(raw: string): Promise<ReturnType<typeof errorRemoteResponse> | ReturnType<typeof okRemoteResponse>> {
    let requestId: string | null = null;
    try {
      const request = parseRemoteControlRequest(raw);
      requestId = request.id;
      const client = this.authenticate(request.clientId, request.token);
      if (!client) throw new RemoteProtocolError("unauthorized");
      this.recordActivity(client.id);
      const result = await this.dispatch(request.method, request.params, client.scopes);
      return okRemoteResponse(request.id, result);
    } catch (error) {
      const code = error instanceof RemoteProtocolError ? error.code : "request_failed";
      return errorRemoteResponse(requestId, code);
    }
  }

  private async dispatch(method: RemoteControlMethod, params: unknown, scopes: readonly RemoteControlScope[]): Promise<unknown> {
    if (method === "status") {
      if (!scopes.includes("status")) throw new RemoteProtocolError("forbidden");
      validateRemoteStatusParams(params);
      return sanitizeStatusSnapshot(this.options.getStatusSnapshot());
    }
    if (method === "pet.react") {
      if (!scopes.includes("react")) throw new RemoteProtocolError("forbidden");
      const { reaction } = validateRemoteReactParams(params);
      if (this.options.isDefaultPetAway?.()) return { shown: false, reaction };
      const applied = this.options.applyReaction(reaction);
      return { shown: applied.shown, reaction };
    }
    if (method === "pet.say") {
      if (!scopes.includes("say")) throw new RemoteProtocolError("forbidden");
      const { message, reaction } = validateRemoteSayParams(params);
      if (reaction !== undefined && !scopes.includes("react")) throw new RemoteProtocolError("forbidden");
      if (this.options.isDefaultPetAway?.()) return reaction === undefined ? { shown: false } : { shown: false, reaction };
      const applied = this.options.applySay(message, reaction);
      return reaction === undefined ? { shown: applied.shown } : { shown: applied.shown, reaction };
    }
    throw new RemoteProtocolError("unknown_method");
  }

  private authenticate(clientId: string | undefined, token: string): RemoteControlClientRecord | null {
    if (!isValidRemoteToken(token)) return null;
    const presented = Buffer.from(hashRemoteToken(token), "hex");
    let matched: RemoteControlClientRecord | null = null;
    for (const client of this.state.clients) {
      const candidate = Buffer.from(client.tokenVerifier, "hex");
      const equal = candidate.length === presented.length && timingSafeEqual(candidate, presented);
      if (equal && (clientId === undefined || client.id === clientId) && client.revokedAt === undefined) matched = client;
    }
    return matched;
  }

  private recordActivity(clientId: string): void {
    const now = Date.now();
    const next = this.state.clients.map((client) => client.id === clientId ? { ...client, lastActivityAt: now, updatedAt: now } : client);
    this.commitState({ ...this.state, clients: next });
  }

  private findClient(clientId: string): RemoteControlClientRecord | null {
    return isValidOpaqueId(clientId) ? this.state.clients.find((client) => client.id === clientId) ?? null : null;
  }

  private commitState(next: RemoteControlState): void {
    try {
      saveRemoteControlState(this.options.statePath, next);
    } catch {
      throw new Error("Remote control state could not be saved.");
    }
    this.state = next;
  }
}

export function initializeRemoteControlService(options: RemoteControlServiceOptions): RemoteControlService {
  if (singleton) return singleton;
  singleton = new RemoteControlService(options);
  return singleton;
}

export function getRemoteControlService(): RemoteControlService {
  if (!singleton) throw new Error("Remote control service is not initialized.");
  return singleton;
}

export async function stopRemoteControlService(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
}

export function validateRemoteControlConfig(input: { readonly enabled: boolean; readonly address?: string; readonly port?: number }): RemoteControlConfig {
  if (typeof input.enabled !== "boolean") throw new Error("Remote control configuration is invalid.");
  if (!input.enabled) return disabledRemoteControlConfig;
  const port = input.port;
  if (!isValidRemoteBindAddress(input.address) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Remote control configuration is invalid.");
  }
  return { enabled: true, address: input.address, port };
}

export function hashRemoteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sanitizeStatusSnapshot(snapshot: RemoteStatusSnapshot): RemoteStatusSnapshot {
  const candidatePetId = typeof snapshot.defaultPet.id === "string" ? snapshot.defaultPet.id : "";
  const safePetId = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidatePetId) ? candidatePetId : "builtin";
  return {
    ok: true,
    appRunning: true,
    protocolVersion: openPetsRemoteVersion,
    defaultPet: {
      id: safePetId,
      builtIn: snapshot.defaultPet.builtIn === true,
      broken: snapshot.defaultPet.broken === true,
    },
    paused: snapshot.paused === true,
    defaultPetVisible: snapshot.defaultPetVisible === true,
    openDefaultPetOnLaunch: snapshot.openDefaultPetOnLaunch === true,
    speechBubblesEnabled: snapshot.speechBubblesEnabled === true,
  };
}

function sameConfig(left: RemoteControlConfig, right: RemoteControlConfig): boolean {
  return left.enabled === right.enabled && left.address === right.address && left.port === right.port;
}

function writeRemoteResponse(socket: net.Socket, response: ReturnType<typeof errorRemoteResponse> | ReturnType<typeof okRemoteResponse>): void {
  if (socket.destroyed || !socket.writable) return;
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line, "utf8") > maxRemoteMessageBytes) {
    socket.end(`${JSON.stringify(errorRemoteResponse(null, "response_too_large"))}\n`);
    return;
  }
  socket.end(line);
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closeServerSafely(server: net.Server): Promise<void> {
  if (!server.listening) return;
  (server as net.Server & { readonly closeAllConnections?: () => void }).closeAllConnections?.();
  await closeServer(server);
}
