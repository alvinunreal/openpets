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
  provider: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  pkce: boolean;
  redirect: "loopback" | "appProtocol";
  loopbackPort?: number;
};

const flowTimeoutMs = 5 * 60_000;
let activeFlow = false;

export class PluginOauthBroker {
  readonly #secrets: PluginSecretsStore;

  constructor(secrets: PluginSecretsStore) {
    this.#secrets = secrets;
  }

  async oauth(pluginId: string, config: OauthRequest): Promise<PluginOauthTokens> {
    if (config.redirect === "appProtocol") throw new Error("appProtocol OAuth redirects are not supported yet; use loopback.");
    if (activeFlow) throw new Error("Another OAuth flow is already in progress.");
    activeFlow = true;
    try {
      const verifier = base64Url(randomBytes(48));
      const challenge = base64Url(createHash("sha256").update(verifier).digest());
      const stateToken = base64Url(randomBytes(24));
      const { server, port, codePromise } = await startLoopbackListener(stateToken, config.loopbackPort);
      try {
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const authUrl = new URL(config.authorizationUrl);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("scope", config.scopes.join(" "));
        authUrl.searchParams.set("state", stateToken);
        if (config.pkce) {
          authUrl.searchParams.set("code_challenge", challenge);
          authUrl.searchParams.set("code_challenge_method", "S256");
        }
        info("plugin", "oauth flow starting", { pluginId, provider: config.provider });
        await shell.openExternal(authUrl.toString());
        const code = await codePromise;
        const tokens = await exchangeCode(config, code, redirectUri, config.pkce ? verifier : undefined);
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
    const session = JSON.parse(stored) as { refreshToken?: string; tokenUrl: string; clientId: string };
    if (!session.refreshToken) throw new Error(`The stored OAuth session for ${provider} has no refresh token.`);
    const response = await fetch(session.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId }).toString(),
    });
    if (!response.ok) throw new Error(`OAuth token refresh failed with HTTP ${response.status}.`);
    const parsed = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
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
      await this.#secrets.set(pluginId, `oauth:${config.provider}`, JSON.stringify({ tokenUrl: config.tokenUrl, clientId: config.clientId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }));
    } catch (error) {
      warn("plugin", "oauth token persistence failed", { pluginId, provider: config.provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export async function startLoopbackListener(stateToken: string, loopbackPort?: number): Promise<{ server: Server; port: number; codePromise: Promise<string> }> {
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(loopbackPort ?? 0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    clearTimeout(timeout);
    if (loopbackPort !== undefined) {
      throw new Error(`OAuth loopback port ${loopbackPort} is already in use. Close the other app or retry later.`);
    }
    throw error;
  }
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    clearTimeout(timeout);
    throw new Error("OAuth loopback listener failed to start.");
  }
  return { server, port: address.port, codePromise };
}

async function exchangeCode(config: OauthRequest, code: string, redirectUri: string, verifier: string | undefined): Promise<PluginOauthTokens> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId });
  if (verifier) body.set("code_verifier", verifier);
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed with HTTP ${response.status}.`);
  const parsed = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error("OAuth token exchange returned no access token.");
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined,
  };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
