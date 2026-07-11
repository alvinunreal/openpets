import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { shell } from "electron";

import { info, warn } from "./logger.js";
import type { PluginSecretsStore } from "./plugin-secrets.js";
import type { PluginOauthTokens } from "./plugin-sdk-bridge.js";

/**
 * Host-mediated OAuth (§14.1): the host opens the system browser, runs the
 * PKCE authorization-code dance against a loopback redirect, exchanges the
 * code, persists tokens in the encrypted secrets store, and returns them to
 * the plugin. No client secret ever lives in plugin code.
 */

type OauthRequest = {
  provider: "google" | "spotify";
  clientId: string;
  clientSecret?: string;
  scopes: string[];
};

export type PluginOauthErrorCode = "invalid_grant";

export class PluginOauthError extends Error {
  readonly code: PluginOauthErrorCode;

  constructor(code: PluginOauthErrorCode, message: string) {
    super(message);
    this.name = "PluginOauthError";
    this.code = code;
  }
}

const oauthProviders = {
  google: { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", authorizationParams: { access_type: "offline", prompt: "consent" }, allowedScopes: new Set(["https://www.googleapis.com/auth/calendar.events.readonly"]) },
  spotify: { authorizationUrl: "https://accounts.spotify.com/authorize", tokenUrl: "https://accounts.spotify.com/api/token", authorizationParams: {}, allowedScopes: new Set(["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"]) },
} as const;

const flowTimeoutMs = 5 * 60_000;
let activeFlow = false;

export class PluginOauthBroker {
  readonly #secrets: PluginSecretsStore;

  constructor(secrets: PluginSecretsStore) {
    this.#secrets = secrets;
  }

  async oauth(pluginId: string, config: OauthRequest): Promise<PluginOauthTokens> {
    validateProviderScopes(config);
    if (activeFlow) throw new Error("Another OAuth flow is already in progress.");
    activeFlow = true;
    try {
      const verifier = base64Url(randomBytes(48));
      const challenge = base64Url(createHash("sha256").update(verifier).digest());
      const stateToken = base64Url(randomBytes(24));
      const { server, port, codePromise } = await startLoopbackListener(stateToken);
      try {
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const provider = oauthProviders[config.provider];
        const authUrl = new URL(provider.authorizationUrl);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("scope", config.scopes.join(" "));
        authUrl.searchParams.set("state", stateToken);
        authUrl.searchParams.set("code_challenge", challenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        for (const [key, value] of Object.entries(provider.authorizationParams)) authUrl.searchParams.set(key, value);
        info("plugin", "oauth flow starting", { pluginId, provider: config.provider });
        await shell.openExternal(authUrl.toString());
        const code = await codePromise;
        const tokens = await exchangeCode(config, code, redirectUri, verifier);
        await this.#persistTokens(pluginId, config, tokens);
        return tokens;
      } finally {
        server.close();
      }
    } finally {
      activeFlow = false;
    }
  }

  async refresh(pluginId: string, provider: string): Promise<{ accessToken: string; expiresAt?: number }> {
    const stored = await this.#secrets.get(pluginId, `oauth:${provider}`);
    if (!stored) throw new Error(`No stored OAuth session for provider: ${provider}`);
    if (provider !== "google" && provider !== "spotify") throw new Error(`OAuth provider is not supported: ${provider}`);
    const session = JSON.parse(stored) as { refreshToken?: string; clientId: string; clientSecret?: string };
    if (!session.refreshToken) throw new Error(`The stored OAuth session for ${provider} has no refresh token.`);
    const response = await fetch(oauthProviders[provider].tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId, ...(session.clientSecret ? { client_secret: session.clientSecret } : {}) }).toString(),
      redirect: "error",
    });
    let parsed: Awaited<ReturnType<typeof parseTokenResponse>>;
    try {
      parsed = await parseTokenResponse(response, provider, "refresh");
    } catch (error) {
      if (error instanceof PluginOauthError && error.code === "invalid_grant") await this.#secrets.delete(pluginId, `oauth:${provider}`);
      throw error;
    }
    if (!parsed.access_token) throw new Error("OAuth token refresh returned no access token.");
    const expiresAt = parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined;
    await this.#secrets.set(pluginId, `oauth:${provider}`, JSON.stringify({ ...session, refreshToken: parsed.refresh_token ?? session.refreshToken, accessToken: parsed.access_token, expiresAt }));
    return { accessToken: parsed.access_token, expiresAt };
  }

  async signOut(pluginId: string, provider: string): Promise<void> {
    await this.#secrets.delete(pluginId, `oauth:${provider}`);
  }

  async #persistTokens(pluginId: string, config: OauthRequest, tokens: PluginOauthTokens): Promise<void> {
    try {
      await this.#secrets.set(pluginId, `oauth:${config.provider}`, JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }));
    } catch (error) {
      warn("plugin", "oauth token persistence failed", { pluginId, provider: config.provider, error: error instanceof Error ? error.message : String(error) });
      throw new Error("OAuth token persistence failed.");
    }
  }
}

async function startLoopbackListener(stateToken: string): Promise<{ server: Server; port: number; codePromise: Promise<string> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const timeout = setTimeout(() => rejectCode(new Error("OAuth flow timed out.")), flowTimeoutMs);
  timeout.unref?.();
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (error || !code || state !== stateToken) {
        response.end("<html><body><p>OpenPets sign-in failed. You can close this tab.</p></body></html>");
        rejectCode(new Error(error ? `OAuth authorization failed: ${error}` : "OAuth authorization response was invalid."));
        return;
      }
      response.end("<html><body><p>OpenPets is connected. You can close this tab.</p></body></html>");
      clearTimeout(timeout);
      resolveCode(code);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("OAuth loopback listener failed to start.");
  return { server, port: address.port, codePromise };
}

async function exchangeCode(config: OauthRequest, code: string, redirectUri: string, verifier: string | undefined): Promise<PluginOauthTokens> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  if (verifier) body.set("code_verifier", verifier);
  const response = await fetch(oauthProviders[config.provider].tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    redirect: "error",
  });
  const parsed = await parseTokenResponse(response, config.provider, "exchange");
  if (!parsed.access_token) throw new Error("OAuth token exchange returned no access token.");
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined,
  };
}

function validateProviderScopes(config: OauthRequest): void {
  const provider = oauthProviders[config.provider];
  if (!config.scopes.length || new Set(config.scopes).size !== config.scopes.length || config.scopes.some((scope) => !provider.allowedScopes.has(scope))) {
    throw new Error(`OAuth scopes are not allowed for provider: ${config.provider}`);
  }
}

async function parseTokenResponse(response: Response, provider: "google" | "spotify", operation: "exchange" | "refresh"): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
  try { parsed = await response.json() as typeof parsed; } catch { /* report the HTTP failure below */ }
  if (!response.ok) {
    const errorCode = sanitizeOauthErrorPart(parsed.error, 80);
    const errorDescription = sanitizeOauthErrorPart(parsed.error_description, 240);
    warn("plugin", "oauth token request failed", { provider, operation, status: response.status, errorCode, errorDescription });
    if (parsed.error === "invalid_grant") throw new PluginOauthError("invalid_grant", errorDescription || "OAuth authorization has expired or was revoked.");
    const detail = [errorCode, errorDescription].filter(Boolean).join(": ");
    throw new Error(detail ? `OAuth token ${operation} failed: ${detail}.` : `OAuth token ${operation} failed with HTTP ${response.status}.`);
  }
  if (parsed.error === "invalid_grant") throw new PluginOauthError("invalid_grant", sanitizeOauthErrorPart(parsed.error_description, 240) || "OAuth authorization has expired or was revoked.");
  return parsed;
}

function sanitizeOauthErrorPart(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/[\0-\x1F\x7F]+/g, " ")
    .replace(/\b(?:authorization_?)?code=[^\s&]+/gi, "code=[redacted]")
    .replace(/\b(?:access_?|refresh_?)?token=[^\s&]+/gi, "token=[redacted]")
    .replace(/\bclient_secret=[^\s&]+/gi, "client_secret=[redacted]")
    .replace(/\bcode_verifier=[^\s&]+/gi, "code_verifier=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return sanitized || undefined;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
