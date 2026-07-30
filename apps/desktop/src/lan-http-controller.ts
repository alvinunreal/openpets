import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { LanCoordinator, normalizeLanEdge, normalizeLanHost, normalizeLanPetId, normalizeLanPoint, type LanState } from "./lan-state.js";

const maxLanRequestBodyBytes = 16 * 1024;

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
  return (req, res) => {
    void routeLanRequest(req, res, lanCoordinator, token, now, options).catch((requestError) => {
      if (requestError instanceof LanRequestBodyTooLargeError) {
        writeJson(res, 413, { error: "body_too_large" });
        return;
      }
      options.onError?.(requestError);
      writeJson(res, 500, { error: "internal_error" });
    });
  };
}

async function routeLanRequest(req: IncomingMessage, res: ServerResponse, lanCoordinator: LanCoordinator, token: string | null, now: () => number, options: LanRequestHandlerOptions): Promise<void> {
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
    const previousHost = lanCoordinator.currentHost();
    const state = lanCoordinator.register(host, normalizeLanPoint(body.position), now(), petId ?? undefined);
    writeJson(res, 200, state);
    notifyStateChangeIfOwnerChanged(previousHost, state, options);
    return;
  }

  if (req.method === "POST" && url.pathname === "/claim") {
    const body = await readBody(req);
    const host = normalizeLanHost(body.host);
    const previousHost = lanCoordinator.currentHost();
    const state = host ? lanCoordinator.claim(host, now()) : null;
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
    const state = host && ownerHost ? lanCoordinator.returnPet(host, ownerHost, now()) : null;
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function isAuthorized(req: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  return req.headers["x-openpets-lan-token"] === token;
}
