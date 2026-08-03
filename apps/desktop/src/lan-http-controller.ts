import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { LanCoordinator, normalizeLanEdge, normalizeLanHost, normalizeLanPetId, normalizeLanPoint, type LanState } from "./lan-state.js";

const maxLanRequestBodyBytes = 16 * 1024;
const lanSessionHeader = "x-openpets-lan-session";

class LanRequestBodyTooLargeError extends Error {
  constructor() {
    super("LAN request body too large.");
  }
}

export type LanRequestHandlerOptions = {
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly onStateChange?: (state: LanState) => void;
};

export function createLanRequestHandler(lanCoordinator: LanCoordinator, token: string | null, options: LanRequestHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const now = options.now ?? Date.now;
  const hostSessions = new Map<string, string>();
  return (req, res) => {
    void routeLanRequest(req, res, lanCoordinator, token, now, options, hostSessions).catch((requestError) => {
      if (requestError instanceof LanRequestBodyTooLargeError) {
        writeJson(res, 413, { error: "body_too_large" });
        return;
      }
      options.onError?.(requestError);
      writeJson(res, 500, { error: "internal_error" });
    });
  };
}

async function routeLanRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lanCoordinator: LanCoordinator,
  token: string | null,
  now: () => number,
  options: LanRequestHandlerOptions,
  hostSessions: Map<string, string>,
): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (!isAuthorized(req, token)) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    writeJson(res, 200, lanCoordinator.snapshot(now()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/register") {
    const body = await readBody(req);
    const host = normalizeLanHost(body.host);
    if (!host) {
      writeJson(res, 400, { error: "missing_host" });
      return;
    }
    const petId = normalizeLanPetId(body.petId);
    if (body.petId !== undefined && !petId) {
      writeJson(res, 400, { error: "invalid_pet_id" });
      return;
    }
    const requestNow = now();
    const existingSession = hostSessions.get(host);
    if (existingSession && lanCoordinator.hasClient(host, requestNow) && req.headers[lanSessionHeader] !== existingSession) {
      writeJson(res, 403, { error: "host_identity_conflict" });
      return;
    }
    const session = existingSession && req.headers[lanSessionHeader] === existingSession
      ? existingSession
      : randomBytes(32).toString("base64url");
    hostSessions.set(host, session);
    const previousHost = lanCoordinator.currentHost();
    const state = lanCoordinator.register(host, normalizeLanPoint(body.position), requestNow, petId ?? undefined);
    writeJson(res, 200, state, { [lanSessionHeader]: session });
    notifyStateChangeIfOwnerChanged(previousHost, state, options);
    return;
  }

  if (req.method === "POST" && url.pathname === "/claim") {
    const body = await readBody(req);
    const host = normalizeLanHost(body.host);
    if (!host) {
      writeJson(res, 400, { error: "unknown_host" });
      return;
    }
    if (!isHostAuthorized(req, host, hostSessions)) {
      writeJson(res, 403, { error: "host_identity_mismatch" });
      return;
    }
    const previousHost = lanCoordinator.currentHost();
    const state = lanCoordinator.claim(host, now());
    if (!state) {
      writeJson(res, 400, { error: "unknown_host" });
      return;
    }
    writeJson(res, 200, state);
    notifyStateChangeIfOwnerChanged(previousHost, state, options);
    return;
  }

  if (req.method === "POST" && url.pathname === "/position") {
    const body = await readBody(req);
    const host = normalizeLanHost(body.host);
    if (!host) {
      writeJson(res, 400, { error: "missing_host" });
      return;
    }
    if (!isHostAuthorized(req, host, hostSessions)) {
      writeJson(res, 403, { error: "host_identity_mismatch" });
      return;
    }
    const previousHost = lanCoordinator.currentHost();
    const ownerHost = normalizeLanHost(body.ownerHost) ?? undefined;
    const state = lanCoordinator.updatePosition(host, normalizeLanPoint(body.position), normalizeLanEdge(body.edge), now(), ownerHost);
    writeJson(res, 200, state);
    notifyStateChangeIfOwnerChanged(previousHost, state, options);
    return;
  }

  if (req.method === "POST" && url.pathname === "/activity") {
    const body = await readBody(req);
    const ownerHost = normalizeLanHost(body.ownerHost);
    if (!ownerHost || body.kind !== "work" || Object.keys(body).some((key) => key !== "ownerHost" && key !== "kind")) {
      writeJson(res, 400, { error: "invalid_activity" });
      return;
    }
    if (!isHostAuthorized(req, ownerHost, hostSessions)) {
      writeJson(res, 403, { error: "host_identity_mismatch" });
      return;
    }
    const state = lanCoordinator.publishActivity(ownerHost, now());
    if (!state) {
      writeJson(res, 400, { error: "unknown_pet" });
      return;
    }
    writeJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/return") {
    const body = await readBody(req);
    const host = normalizeLanHost(body.host);
    const ownerHost = normalizeLanHost(body.ownerHost);
    if (!host || !ownerHost) {
      writeJson(res, 400, { error: "invalid_return" });
      return;
    }
    if (!isHostAuthorized(req, host, hostSessions)) {
      writeJson(res, 403, { error: "host_identity_mismatch" });
      return;
    }
    const state = lanCoordinator.returnPet(host, ownerHost, now());
    if (!state) {
      writeJson(res, 400, { error: "invalid_return" });
      return;
    }
    writeJson(res, 200, state);
    return;
  }

  writeJson(res, 404, { error: "not_found" });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxLanRequestBodyBytes) throw new LanRequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function notifyStateChangeIfOwnerChanged(previousHost: string | null, state: LanState, options: LanRequestHandlerOptions): void {
  if (previousHost !== state.currentHost) options.onStateChange?.(state);
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function isAuthorized(req: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  return req.headers["x-openpets-lan-token"] === token;
}

function isHostAuthorized(req: IncomingMessage, host: string, hostSessions: ReadonlyMap<string, string>): boolean {
  const session = hostSessions.get(host);
  return Boolean(session) && req.headers[lanSessionHeader] === session;
}
