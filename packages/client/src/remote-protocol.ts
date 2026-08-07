import { isIPv4 } from "node:net";

import { allowedReactions, OpenPetsClientError, type OpenPetsReaction } from "./protocol.js";

export const openPetsRemoteProtocol = "openpets-remote" as const;
export const openPetsRemoteVersion = 1 as const;
export const maxRemoteMessageBytes = 4 * 1024;
export const remoteConnectTimeoutMs = 2_000;
export const remoteResponseTimeoutMs = 3_000;

export type OpenPetsRemoteMethod = "status" | "pet.react" | "pet.say";

export interface OpenPetsRemoteEndpoint {
  readonly kind: "tcp";
  readonly host: string;
  readonly port: number;
}

export interface OpenPetsRemoteRequest {
  readonly id: string;
  readonly protocol: "openpets-remote";
  readonly version: 1;
  readonly clientId?: string;
  readonly token: string;
  readonly method: OpenPetsRemoteMethod;
  readonly params?: unknown;
}

export interface OpenPetsRemoteResponse<T = unknown> {
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

export function parseRemoteEndpoint(endpoint: string): OpenPetsRemoteEndpoint {
  if (typeof endpoint !== "string" || endpoint.length < 1 || endpoint.length > 120 || !endpoint.startsWith("tcp://")) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }

  // Validate the textual authority before URL parsing: URL normalizes some
  // non-canonical IPv4 spellings, which could otherwise bypass this boundary.
  const match = /^tcp:\/\/([^:\/?#]+):(\d+)\/?$/.exec(endpoint);
  if (!match) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }

  const host = match[1];
  if (!isCanonicalIpv4(host) || !isPrivateIpv4(host)) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== match[2]) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  return { kind: "tcp", host, port };
}

export function validateRemoteToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 43 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OpenPetsClientError("invalid_remote_token", "Remote token is invalid.");
  }
  return value;
}

export function validateRemoteClientId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 120 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OpenPetsClientError("invalid_remote_client", "Remote client id is invalid.");
  }
  return value;
}

export function validateRemoteMessage(value: string): string {
  if (typeof value !== "string") throw new OpenPetsClientError("invalid_remote_message", "Remote message is invalid.");
  const message = value.trim();
  if (
    message.length < 1 ||
    message.length > 140 ||
    Buffer.byteLength(message, "utf8") > 560 ||
    /[\0\r\n]/.test(message) ||
    /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(message) ||
    /https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(message) ||
    /(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(message)
  ) {
    throw new OpenPetsClientError("invalid_remote_message", "Remote message is invalid.");
  }
  return message;
}

export function validateRemoteReaction(value: string): OpenPetsReaction {
  if (!allowedReactions.includes(value as OpenPetsReaction)) {
    throw new OpenPetsClientError("invalid_reaction", "Invalid OpenPets reaction.");
  }
  return value as OpenPetsReaction;
}

export function parseRemoteResponse<T = unknown>(value: unknown): OpenPetsRemoteResponse<T> {
  if (!isRecord(value) || (typeof value.id !== "string" && value.id !== null)) {
    throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
  }
  if (value.ok === true) return { id: value.id, ok: true, result: value.result as T };
  if (value.ok === false && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
  }
  throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
}

function isCanonicalIpv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  return value.split(".").every((part) => String(Number(part)) === part);
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts[0] === 127 || parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
