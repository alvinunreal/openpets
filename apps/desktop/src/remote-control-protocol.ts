import { isIPv4 } from "node:net";

import { allowedReactions, type OpenPetsReaction } from "./local-ipc-protocol.js";

/** The remote protocol is intentionally independent from the local IPC protocol. */
export const openPetsRemoteProtocol = "openpets-remote" as const;
export const openPetsRemoteVersion = 1 as const;
export const maxRemoteMessageBytes = 4 * 1024;
export const remoteSocketTimeoutMs = 3_000;
export const remoteConnectionDeadlineMs = 10_000;
export const remoteMaxConcurrentSockets = 64;
export const remoteRateLimitMaxRequests = 30;
export const remoteRateLimitWindowMs = 60_000;

export const remoteScopes = ["status", "react", "say"] as const;
export type RemoteControlScope = typeof remoteScopes[number];

export const remoteMethods = ["status", "pet.react", "pet.say"] as const;
export type RemoteControlMethod = typeof remoteMethods[number];

export interface RemoteControlRequest {
  readonly id: string;
  readonly protocol: "openpets-remote";
  readonly version: 1;
  readonly clientId?: string;
  readonly token: string;
  readonly method: RemoteControlMethod;
  readonly params?: unknown;
}

export interface RemoteStatusSnapshot {
  readonly ok: true;
  readonly appRunning: true;
  readonly protocolVersion: 1;
  readonly defaultPet: {
    readonly id: string;
    readonly builtIn: boolean;
    readonly broken: boolean;
  };
  readonly paused: boolean;
  readonly defaultPetVisible: boolean;
  readonly openDefaultPetOnLaunch: boolean;
  readonly speechBubblesEnabled: boolean;
}

export interface RemoteControlResponse {
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export class RemoteProtocolError extends Error {
  constructor(readonly code: string) {
    super("Remote request rejected.");
  }
}

export function parseRemoteControlRequest(raw: string): RemoteControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RemoteProtocolError("invalid_request");
  }

  if (!isRecord(parsed)) throw new RemoteProtocolError("invalid_request");
  if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 120 || /[\0\r\n]/.test(parsed.id)) {
    throw new RemoteProtocolError("invalid_request");
  }
  if (parsed.protocol !== openPetsRemoteProtocol) throw new RemoteProtocolError("invalid_request");
  if (parsed.version !== openPetsRemoteVersion) throw new RemoteProtocolError("invalid_version");
  if (parsed.clientId !== undefined && !isValidOpaqueId(parsed.clientId)) throw new RemoteProtocolError("invalid_request");
  if (!isValidRemoteToken(parsed.token)) throw new RemoteProtocolError("invalid_request");
  if (!remoteMethods.includes(parsed.method as RemoteControlMethod)) throw new RemoteProtocolError("unknown_method");

  return {
    id: parsed.id,
    protocol: openPetsRemoteProtocol,
    version: 1,
    ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
    token: parsed.token,
    method: parsed.method as RemoteControlMethod,
    params: parsed.params,
  };
}

export function validateRemoteScopeList(value: unknown): RemoteControlScope[] {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== remoteScopes.length)) {
    throw new RemoteProtocolError("invalid_configuration");
  }
  if (!value.every((scope, index) => scope === remoteScopes[index])) {
    throw new RemoteProtocolError("invalid_configuration");
  }
  return remoteScopes.slice(0, value.length);
}

export function validateRemoteClientName(value: unknown): string {
  if (typeof value !== "string") throw new RemoteProtocolError("invalid_configuration");
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || /[\0\r\n]/.test(name)) throw new RemoteProtocolError("invalid_configuration");
  return name;
}

export function validateRemoteReaction(value: unknown): OpenPetsReaction {
  if (typeof value !== "string" || !allowedReactions.includes(value as OpenPetsReaction)) {
    throw new RemoteProtocolError("invalid_params");
  }
  return value as OpenPetsReaction;
}

export function validateRemoteSayParams(value: unknown): { readonly message: string; readonly reaction?: OpenPetsReaction } {
  if (!isRecord(value)) throw new RemoteProtocolError("invalid_params");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "message" && key !== "reaction")) throw new RemoteProtocolError("invalid_params");
  if (typeof value.message !== "string") throw new RemoteProtocolError("invalid_params");

  const message = value.message.trim();
  if (
    message.length < 1 ||
    message.length > 140 ||
    Buffer.byteLength(message, "utf8") > 560 ||
    /[\0\r\n]/.test(message) ||
    /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(message) ||
    /https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(message) ||
    /(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(message)
  ) {
    throw new RemoteProtocolError("invalid_params");
  }

  const reaction = value.reaction === undefined ? undefined : validateRemoteReaction(value.reaction);
  return reaction === undefined ? { message } : { message, reaction };
}

export function validateRemoteReactParams(value: unknown): { readonly reaction: OpenPetsReaction } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "reaction")) {
    throw new RemoteProtocolError("invalid_params");
  }
  return { reaction: validateRemoteReaction(value.reaction) };
}

export function validateRemoteStatusParams(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length !== 0) throw new RemoteProtocolError("invalid_params");
}

export function isValidOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 120 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function isValidRemoteToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 43 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function isValidRemoteBindAddress(value: unknown): value is string {
  if (!isCanonicalIpv4(value)) return false;
  const parts = value.split(".");
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return false;
  if (numbers[0] === 127 || numbers[0] === 10) return true;
  if (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) return true;
  if (numbers[0] === 192 && numbers[1] === 168) return true;
  if (numbers[0] === 169 && numbers[1] === 254) return true;
  return numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127;
}

export function normalizeRemoteIpv4Address(value: unknown): string | null {
  if (isCanonicalIpv4(value)) return value;
  if (typeof value === "string" && value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isCanonicalIpv4(mapped) ? mapped : null;
  }
  return null;
}

export function isValidRemotePeerAddress(value: unknown): value is string {
  const normalized = normalizeRemoteIpv4Address(value);
  return normalized !== null && isValidRemoteBindAddress(normalized);
}

function isCanonicalIpv4(value: unknown): value is string {
  if (typeof value !== "string" || !isIPv4(value)) return false;
  return value.split(".").every((part) => String(Number(part)) === part);
}

export function okRemoteResponse(id: string, result: unknown): RemoteControlResponse {
  return { id, ok: true, result };
}

export function errorRemoteResponse(id: string | null, code: string): RemoteControlResponse {
  return { id, ok: false, error: { code, message: "Remote request rejected." } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
