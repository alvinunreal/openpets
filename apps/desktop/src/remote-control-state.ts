import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isValidOpaqueId, isValidRemoteBindAddress, validateRemoteScopeList, type RemoteControlScope } from "./remote-control-protocol.js";

export const remoteControlStateVersion = 1 as const;

export interface RemoteControlConfig {
  readonly enabled: boolean;
  readonly address: string | null;
  readonly port: number | null;
}

export interface RemoteControlClientRecord {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly RemoteControlScope[];
  readonly tokenVerifier: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActivityAt?: number;
  readonly revokedAt?: number;
}

export interface RemoteControlState {
  readonly version: 1;
  readonly config: RemoteControlConfig;
  readonly clients: readonly RemoteControlClientRecord[];
}

export const disabledRemoteControlConfig: RemoteControlConfig = {
  enabled: false,
  address: null,
  port: null,
};

export function createDefaultRemoteControlState(): RemoteControlState {
  return { version: remoteControlStateVersion, config: disabledRemoteControlConfig, clients: [] };
}

export function loadRemoteControlState(path: string): RemoteControlState {
  if (!existsSync(path)) return createDefaultRemoteControlState();

  try {
    return normalizeRemoteControlState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return createDefaultRemoteControlState();
  }
}

export function saveRemoteControlState(path: string, state: RemoteControlState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}

export function normalizeRemoteControlState(value: unknown): RemoteControlState {
  if (!isRecord(value) || value.version !== remoteControlStateVersion) return createDefaultRemoteControlState();
  const config = normalizeConfig(value.config);
  const clients = Array.isArray(value.clients)
    ? value.clients.map(normalizeClient).filter((client): client is RemoteControlClientRecord => client !== null)
    : [];
  return { version: remoteControlStateVersion, config, clients };
}

function normalizeConfig(value: unknown): RemoteControlConfig {
  if (!isRecord(value) || value.enabled !== true) return disabledRemoteControlConfig;
  if (typeof value.address !== "string" || typeof value.port !== "number" || !Number.isInteger(value.port)) {
    return disabledRemoteControlConfig;
  }
  if (!isValidRemoteBindAddress(value.address) || value.port < 1 || value.port > 65_535) return disabledRemoteControlConfig;
  return { enabled: true, address: value.address, port: value.port };
}

function normalizeClient(value: unknown): RemoteControlClientRecord | null {
  if (!isRecord(value)) return null;
  if (
    !isValidOpaqueId(value.id) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 80 ||
    typeof value.tokenVerifier !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.tokenVerifier) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) return null;

  let scopes: RemoteControlScope[];
  try {
    scopes = validateRemoteScopeList(value.scopes);
  } catch {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    scopes,
    tokenVerifier: value.tokenVerifier,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(isTimestamp(value.lastActivityAt) ? { lastActivityAt: value.lastActivityAt } : {}),
    ...(isTimestamp(value.revokedAt) ? { revokedAt: value.revokedAt } : {}),
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
