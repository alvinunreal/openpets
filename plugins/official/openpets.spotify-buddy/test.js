// Golden test for openpets.spotify-buddy
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  register,
  OAUTH_CONFIG,
  DEFAULT_CLIENT_ID,
  parseSyncedLyrics,
  findLyricLine,
  getSession,
  pollPlaybackState
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

const PERMISSIONS = [
  "auth",
  "status",
  "commands",
  "network",
  "network:write",
  "pet:speak",
  "pet:reaction",
  "pet:interact"
];

const LOCALES = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };

// Test 1: parseSyncedLyrics and findLyricLine helper correctness
{
  const synced = "[00:01.00] Line 1\n[00:02.50] Line 2\r\n[00:05.00] Line 3";
  const parsed = parseSyncedLyrics(synced);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].timeMs, 1000);
  assert.equal(parsed[0].text, "Line 1");
  assert.equal(parsed[1].timeMs, 2500);
  assert.equal(parsed[1].text, "Line 2");
  assert.equal(parsed[2].timeMs, 5000);
  assert.equal(parsed[2].text, "Line 3");

  assert.equal(findLyricLine(parsed, 500), null);
  assert.equal(findLyricLine(parsed, 1200).text, "Line 1");
  assert.equal(findLyricLine(parsed, 3000).text, "Line 2");
  assert.equal(findLyricLine(parsed, 10000).text, "Line 3");
}

// Test 2: connect command uses correct clientId, scopes, and loopbackPort
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  
  let oauthConfigReceived = null;
  h.ctx.auth.oauth = async (config) => {
    oauthConfigReceived = config;
    return { accessToken: "access-token-123", refreshToken: "refresh-token-123" };
  };

  await h.runCommand("spotify-connect");
  assert.ok(oauthConfigReceived);
  assert.equal(oauthConfigReceived.provider, "spotify");
  assert.equal(oauthConfigReceived.clientId, DEFAULT_CLIENT_ID);
  assert.deepEqual(oauthConfigReceived.scopes, OAUTH_CONFIG.scopes);
  assert.equal(oauthConfigReceived.loopbackPort, 48373);
  assert.equal(oauthConfigReceived.redirect, "loopback");
  await h.stop();
}

// Test 3: play/pause, next, previous commands hit correct endpoints
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  
  h.auth.mock({ accessToken: "valid-token" });

  h.net.mock("https://api.spotify.com/v1/me/player/play", { status: 204 });
  h.net.mock("https://api.spotify.com/v1/me/player/pause", { status: 204 });
  h.net.mock("https://api.spotify.com/v1/me/player/next", { status: 204 });
  h.net.mock("https://api.spotify.com/v1/me/player/previous", { status: 204 });

  const s = getSession(h.ctx);
  s.isPlaying = false;
  await h.runCommand("spotify-play-pause");
  assert.ok(h.calls.netCalls.some(c => c.url.includes("/play") && c.method === "PUT"));

  s.isPlaying = true;
  await h.runCommand("spotify-play-pause");
  assert.ok(h.calls.netCalls.some(c => c.url.includes("/pause") && c.method === "PUT"));

  await h.runCommand("spotify-next");
  assert.ok(h.calls.netCalls.some(c => c.url.includes("/next") && c.method === "POST"));

  await h.runCommand("spotify-previous");
  assert.ok(h.calls.netCalls.some(c => c.url.includes("/previous") && c.method === "POST"));
  await h.stop();
}

// Test 4: pollPlaybackState updates status, now-playing bubble, and avoids spam
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  h.auth.mock({ accessToken: "token-5" });

  h.net.mock("https://api.spotify.com/v1/me/player", {
    status: 200,
    json: {
      is_playing: true,
      progress_ms: 5000,
      item: {
        id: "track-xyz",
        name: "Song A",
        artists: [{ name: "Artist A" }],
        duration_ms: 180000,
        album: { name: "Album A" }
      }
    }
  });
  
  h.net.mock("https://lrclib.net/api/get", { status: 404 });

  await pollPlaybackState(h.ctx);

  assert.deepEqual(h.calls.status[h.calls.status.length - 1], { text: "♪ Artist A — Song A" });
  
  h.expectBubble({ textMatch: /Artist A — Song A/ });
  const firstBubbleCount = h.calls.bubbles.length;

  await pollPlaybackState(h.ctx);
  assert.equal(h.calls.bubbles.length, firstBubbleCount, "Duplicate poll should not emit another now playing bubble");
  await h.stop();
}

// Test 5: no active device (204) handled gracefully
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  h.auth.mock({ accessToken: "token-6" });

  h.net.mock("https://api.spotify.com/v1/me/player", { status: 204 });

  const session = getSession(h.ctx);
  session.isPlaying = true;

  await pollPlaybackState(h.ctx);
  assert.equal(session.isPlaying, false);
  assert.deepEqual(h.calls.status[h.calls.status.length - 1], { text: "Spotify Buddy ready" });
  await h.stop();
}

// Test 6: 429 Retry-After backoff is respected
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  h.auth.mock({ accessToken: "token-7" });

  h.net.mock("https://api.spotify.com/v1/me/player", {
    status: 429,
    headers: { "retry-after": "60" }
  });

  const session = getSession(h.ctx);
  await pollPlaybackState(h.ctx);

  assert.ok(session.backoffUntil >= Date.now() + 55000 && session.backoffUntil <= Date.now() + 65000, "Should back off ~60s");
  const initialCallCount = h.calls.netCalls.length;

  await pollPlaybackState(h.ctx);
  assert.equal(h.calls.netCalls.length, initialCallCount, "Should respect backoff and bypass net fetch");
  await h.stop();
}

// Test 7: LRCLIB lyrics successfully matches and maps progress_ms to bubble
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  h.auth.mock({ accessToken: "token-8" });

  h.net.mock("https://api.spotify.com/v1/me/player", {
    status: 200,
    json: {
      is_playing: true,
      progress_ms: 12000,
      item: {
        id: "track-lyrics",
        name: "Song B",
        artists: [{ name: "Artist B" }],
        duration_ms: 180000,
        album: { name: "Album B" }
      }
    }
  });

  h.net.mock("https://lrclib.net/api/get", {
    status: 200,
    json: {
      syncedLyrics: "[00:10.00] Synced line 1\n[00:15.00] Synced line 2"
    }
  });

  const session = getSession(h.ctx);
  session.lyricsSettings.lyricIntensity = "karaoke";

  await pollPlaybackState(h.ctx);
  
  h.expectBubble({ textMatch: /Synced line 1/ });
  await h.stop();
}

// Test 8: Auth token caching verifies refresh is not called every request/poll
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES });
  await h.start();
  h.auth.mock({ accessToken: "initial-token", expiresAt: Date.now() + 600000 });

  let refreshCallCount = 0;
  h.ctx.auth.refresh = async (provider) => {
    refreshCallCount++;
    return { accessToken: "refreshed-token", expiresAt: Date.now() + 600000 };
  };

  h.net.mock("https://api.spotify.com/v1/me/player", {
    status: 200,
    json: { is_playing: false, item: null }
  });

  await pollPlaybackState(h.ctx);
  await pollPlaybackState(h.ctx);

  assert.equal(refreshCallCount, 1, "Refresh should be called only once to fetch tokens, subsequents use cache");
  await h.stop();
}

console.log("openpets.spotify-buddy specs passed.");
