// Spotify Buddy — OpenPets Plugin (manifestVersion 2, sdkVersion 1.0.0)

// Try to import Node.js child_process for browser opening
let childProcess = null;
try {
  childProcess = require('child_process');
} catch (e) {
  // child_process not available
}

//
// TIMING MODEL:
//   Uses a WALL-CLOCK ANCHOR set after all scheduling overhead is paid.
//   anchorWallMs   = Date.now() at anchor moment
//   anchorProgress = progressMs_from_poll + elapsed_since_poll
//   Each callback delay = lyricTimestamp - currentProgress(now) - LATENCY
//   This means delays are computed against where playback IS right now,
//   not where it was when we started. Drift correction re-anchors the same
//   way so it always catches up in one correction.
//
// STALE CALLBACK GUARD:
//   lyricGeneration is bumped on every cancelLyricSchedules(). Each callback
//   captures its birth generation and exits immediately if the global moved on.
//
// BRIDGE PAIRING:
//   The plugin has no browser cookie jar, so it authenticates via a bearer
//   token obtained once from GET /pair and stored in ctx.storage.
//   Every bridge request sends "Authorization: Bearer <token>" so it always
//   resolves to the same session — fully isolated from every other visitor.
//
//   First-time flow:
//     1. Plugin calls GET /pair → gets pairingToken + loginUrl
//     2. Stores pairingToken in ctx.storage permanently
//     3. Plugin opens loginUrl directly in the user's browser
//     4. User completes OAuth → tokens attach to THIS session
//     5. From then on every poll resolves to the user's own Spotify account
//
//   Subsequent runs:
//     1. Plugin loads pairingToken from ctx.storage (in-memory cache after first load)
//     2. Sends Bearer token on every request — bridge resolves to same session
//     3. No login needed again unless user explicitly resets or bridge wipes sessions
//
//   IMPORTANT: a 401 from the bridge can mean two very different things:
//     - {error, loginUrl}      → token is VALID, session just isn't connected
//                                 to Spotify yet. We must NOT discard the token.
//     - {error} (no loginUrl)  → token is genuinely unknown/expired. Re-pair.
//   Treating both the same way (always re-pairing) means the plugin abandons
//   its own pairing token every poll cycle while logged out, so login never
//   has a chance to "stick" to a stable session. See bridgeFetch() below.

const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_ANNOUNCEMENT_LENGTH = 140;
const EMPTY_TRACK_ID = "__no_track__";

const STRIP_PATTERN =
  /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/gi;

const SPEAK_LATENCY_MS = 300;
const SEEK_DRIFT_THRESHOLD_MS = 1500;
const LYRIC_SCHEDULE_PREFIX = "spotify-lyric-";

const PET_ACTIONS_PER_MINUTE = 60;
const SPEAK_BUDGET_PER_MINUTE = 50;
const MIN_BUBBLE_MS = Math.ceil(60000 / SPEAK_BUDGET_PER_MINUTE); // 1200ms

const LYRICS_RETRY_FAST_ATTEMPTS = 5;
const LYRICS_RETRY_SLOW_INTERVAL_MS = 15000;
const SHOW_LYRICS_FETCH_TIMEOUT_MS = 4000;

const BRIDGE_TOKEN_STORAGE_KEY = "spotify-bridgeToken";

let pollRunning = false;
let activeLyricIds = [];
let recentPetActionTimestamps = [];

// In-memory cache of the bridge token — hydrated from storage on first use.
let cachedBridgeToken = null;

// Generation counter — bumped on every cancelLyricSchedules().
let lyricGeneration = 0;

// Wall-clock playback anchor.
let anchorWallMs = null;
let anchorProgress = null;

function currentProgress() {
  if (anchorWallMs === null || anchorProgress === null) return null;
  return anchorProgress + (Date.now() - anchorWallMs);
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function sanitizeLyric(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  return text
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(STRIP_PATTERN, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_ANNOUNCEMENT_LENGTH)
    .trim();
}

function safeText(value, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const msg = value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const capped =
    msg.length > MAX_ANNOUNCEMENT_LENGTH
      ? msg.slice(0, MAX_ANNOUNCEMENT_LENGTH).trim()
      : msg;
  if (!capped || STRIP_PATTERN.test(capped)) return fallback;
  return capped;
}

function format(template, values) {
  return safeText(
    String(template).replace(
      /\{(title|artist)\}/g,
      (_m, key) => safeText(values[key] || "")
    )
  );
}

// ─── Quota helpers ────────────────────────────────────────────────────────────

function petActionBudgetAvailable(nowMs) {
  const cutoff = nowMs - 60000;
  recentPetActionTimestamps = recentPetActionTimestamps.filter((t) => t > cutoff);
  return recentPetActionTimestamps.length < PET_ACTIONS_PER_MINUTE;
}

function recordPetAction(nowMs) {
  recentPetActionTimestamps.push(nowMs);
}

// ─── Lyric merge ──────────────────────────────────────────────────────────────

function mergeLyricsForBudget(lyrics) {
  const bubbles = [];
  let i = 0;
  while (i < lyrics.length) {
    const text = sanitizeLyric(lyrics[i].text);
    const bubbleStart = lyrics[i].timestamp;
    if (!text) { i++; continue; }

    const parts = [text];
    let j = i + 1;
    while (j < lyrics.length && lyrics[j].timestamp - bubbleStart < MIN_BUBBLE_MS) {
      const t = sanitizeLyric(lyrics[j].text);
      if (t) parts.push(t);
      j++;
    }

    const merged = parts.join(" / ");
    const capped =
      merged.length > MAX_ANNOUNCEMENT_LENGTH
        ? merged.slice(0, MAX_ANNOUNCEMENT_LENGTH - 1).trim() + "…"
        : merged;
    bubbles.push({ timestamp: bubbleStart, text: capped });
    i = j;
  }
  return bubbles;
}

// ─── Core scheduler ───────────────────────────────────────────────────────────

async function cancelLyricSchedules(ctx) {
  lyricGeneration++;
  anchorWallMs = null;
  anchorProgress = null;

  const toCancel = activeLyricIds;
  activeLyricIds = [];

  await Promise.allSettled(toCancel.map((id) => ctx.schedule.cancel(id)));
}

async function scheduleLyrics(ctx, lyrics, progressMs, overheadMs = 0) {
  await cancelLyricSchedules(ctx);

  const myGeneration = lyricGeneration;
  const bubbles = mergeLyricsForBudget(lyrics);
  const newIds = [];
  const nowProgress = progressMs + overheadMs;
  const loopStartWall = Date.now();

  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    const delay = bubble.timestamp - nowProgress - SPEAK_LATENCY_MS;
    if (delay < -500) continue;

    const scheduleId = `${LYRIC_SCHEDULE_PREFIX}${i}`;
    const capturedGeneration = myGeneration;
    const capturedIndex = i;
    const capturedText = bubble.text;

    await ctx.schedule.once(scheduleId, Math.max(0, delay), async () => {
      if (lyricGeneration !== capturedGeneration) return;
      try {
        const fireMs = Date.now();
        if (!petActionBudgetAvailable(fireMs)) {
          ctx.log?.warn?.("Budget tight, deferring bubble", { index: capturedIndex });
          await ctx.schedule.once(`${scheduleId}-retry`, MIN_BUBBLE_MS, async () => {
            if (lyricGeneration !== capturedGeneration) return;
            recordPetAction(Date.now());
            await ctx.storage.set("spotify-lastLyricIndex", capturedIndex);
            await ctx.pet.speak(capturedText);
          });
          return;
        }
        recordPetAction(fireMs);
        await ctx.storage.set("spotify-lastLyricIndex", capturedIndex);
        await ctx.pet.speak(capturedText);
      } catch (e) {
        ctx.log?.warn?.("Lyric speak error", e?.message);
      }
    });

    newIds.push(scheduleId);
  }

  const loopEndWall = Date.now();
  const loopElapsed = loopEndWall - loopStartWall;

  anchorWallMs = loopEndWall;
  anchorProgress = nowProgress + loopElapsed;
  activeLyricIds = newIds;

  ctx.log?.info?.("Lyrics scheduled", {
    generation: myGeneration,
    totalLines: lyrics.length,
    bubbles: bubbles.length,
    scheduled: newIds.length,
    nowProgress,
    loopElapsedMs: loopElapsed,
    anchor: anchorProgress,
  });
}

// ─── Drift detection ──────────────────────────────────────────────────────────

function seekDriftDetected(spotifyProgressMs) {
  const est = currentProgress();
  if (est === null) return true;
  return Math.abs(est - spotifyProgressMs) > SEEK_DRIFT_THRESHOLD_MS;
}

// ─── Lyrics retry bookkeeping ─────────────────────────────────────────────────

async function clearLyricsRetryState(ctx) {
  await ctx.storage.set("spotify-lyricsPendingTrackId", null);
  await ctx.storage.set("spotify-lyricsAttemptCount", 0);
  await ctx.storage.set("spotify-lyricsLastAttemptMs", 0);
}

async function markLyricsRetryAttempt(ctx, trackId) {
  const count = Number((await ctx.storage.get("spotify-lyricsAttemptCount")) || 0);
  await ctx.storage.set("spotify-lyricsPendingTrackId", trackId);
  await ctx.storage.set("spotify-lyricsAttemptCount", count + 1);
  await ctx.storage.set("spotify-lyricsLastAttemptMs", Date.now());
}

async function shouldRetryLyricsNow(ctx, trackId) {
  const pendingTrackId = await ctx.storage.get("spotify-lyricsPendingTrackId");
  if (pendingTrackId !== trackId) return false;
  const count = Number((await ctx.storage.get("spotify-lyricsAttemptCount")) || 0);
  if (count < LYRICS_RETRY_FAST_ATTEMPTS) return true;
  const lastAttemptMs = Number((await ctx.storage.get("spotify-lyricsLastAttemptMs")) || 0);
  return Date.now() - lastAttemptMs >= LYRICS_RETRY_SLOW_INTERVAL_MS;
}

async function tryResolveLyrics(ctx, config, nowPlaying, trackId, progressMs, pollWallMs) {
  const lyricsData = await fetchLyricsForTrack(ctx, config.bridgeUrl, nowPlaying);
  const fetchDoneWall = Date.now();

  const syncedLyrics = lyricsData?.lyrics?.synced || null;
  if (!syncedLyrics?.length) {
    ctx.log?.info?.("Lyrics not yet available, will retry", { trackId });
    return false;
  }

  const overheadMs = fetchDoneWall - pollWallMs;
  ctx.log?.info?.("Lyrics resolved", { trackId, count: syncedLyrics.length, overheadMs });

  await ctx.storage.set("spotify-lyrics", syncedLyrics);
  await scheduleLyrics(ctx, syncedLyrics, progressMs, overheadMs);
  await clearLyricsRetryState(ctx);
  return true;
}

// ─── Bridge pairing (auth) ────────────────────────────────────────────────────

async function getBridgeToken(ctx) {
  if (cachedBridgeToken) return cachedBridgeToken;
  const stored = await ctx.storage.get(BRIDGE_TOKEN_STORAGE_KEY);
  if (stored) {
    cachedBridgeToken = stored;
    return stored;
  }
  return null;
}

async function setBridgeToken(ctx, token) {
  cachedBridgeToken = token;
  await ctx.storage.set(BRIDGE_TOKEN_STORAGE_KEY, token);
}

/**
 * Calls GET /pair to obtain (or confirm) our pairing token.
 * Safe to call repeatedly — bridge returns the same token for an existing
 * session rather than minting a new one.
 */
async function pairWithBridge(ctx, bridgeUrl) {
  const base = String(bridgeUrl || "").replace(/\/+$/, "");
  const existingToken = await getBridgeToken(ctx);

  try {
    const res = await ctx.http.fetch(`${base}/pair`, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
        "user-agent": "OpenPets Spotify Buddy",
        ...(existingToken ? { Authorization: `Bearer ${existingToken}` } : {}),
      },
      timeoutMs: 8000,
    });
    if (!res?.ok) return null;
    const data = res.json;
    if (!data?.pairingToken) return null;

    if (data.pairingToken !== existingToken) {
      await setBridgeToken(ctx, data.pairingToken);
    }
    return data; // { pairingToken, authorised, loginUrl }
  } catch (e) {
    ctx.log?.warn?.("Bridge pairing failed", { msg: e?.message || String(e) });
    return null;
  }
}

/**
 * Ensures we have a bridge token, pairing for the first time if needed.
 * Does NOT guarantee Spotify auth — only that we have a stable session identity.
 */
async function ensurePaired(ctx, bridgeUrl) {
  const existing = await getBridgeToken(ctx);
  if (existing) return existing;
  const result = await pairWithBridge(ctx, bridgeUrl);
  return result?.pairingToken || null;
}

// ─── Bridge fetch ─────────────────────────────────────────────────────────────

async function bridgeFetch(ctx, bridgeUrl, path) {
  try {
    const base = String(bridgeUrl || "").replace(/\/+$/, "");
    const url = `${base}${path}`;
    const token = await ensurePaired(ctx, bridgeUrl);

    ctx.log?.info?.("GET", { url });
    const res = await ctx.http.fetch(url, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
        "user-agent": "OpenPets Spotify Buddy",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeoutMs: 8000,
    });
    ctx.log?.info?.("Response", { status: res.status, ok: res.ok });

    // A 401 means two very different things, and we must not conflate them:
    //   - body has loginUrl    → token is VALID, session just isn't connected
    //                             to Spotify yet. Leave our pairing token alone
    //                             and let the caller surface "please log in".
    //   - body has no loginUrl → token is genuinely unknown/expired (e.g. the
    //                             bridge restarted and lost it). Re-pair once.
    if (res?.status === 401) {
      const body = res.json;
      if (body?.loginUrl) {
        return res;
      }

      ctx.log?.warn?.("Bridge token rejected, re-pairing", { url });
      cachedBridgeToken = null;
      await ctx.storage.set(BRIDGE_TOKEN_STORAGE_KEY, null);
      const rePaired = await pairWithBridge(ctx, bridgeUrl);
      if (rePaired?.pairingToken) {
        const retryRes = await ctx.http.fetch(url, {
          method: "GET",
          headers: {
            "ngrok-skip-browser-warning": "true",
            "user-agent": "OpenPets Spotify Buddy",
            Authorization: `Bearer ${rePaired.pairingToken}`,
          },
          timeoutMs: 8000,
        });
        return retryRes;
      }
    }

    return res;
  } catch (e) {
    ctx.log?.warn?.("Fetch error", { path, msg: e?.message || String(e) });
    return null;
  }
}

async function bridgeGetJson(ctx, bridgeUrl, path) {
  const res = await bridgeFetch(ctx, bridgeUrl, path);
  if (!res || !res.ok) return null;
  return res.json ?? null;
}

async function bridgeControl(ctx, bridgeUrl, path) {
  const res = await bridgeFetch(ctx, bridgeUrl, path);
  if (!res) return false;
  return res.ok || res.status === 204;
}

/**
 * Like bridgeGetJson but also surfaces whether the bridge says we need to
 * log in vs. whether it's genuinely unreachable — so checkNow() can give
 * the user an actionable "click here to connect Spotify" message.
 *
 * The bridge returns 401 (not 503) when the session has no Spotify tokens,
 * so this function correctly treats 401 as needsLogin rather than unreachable.
 */
async function bridgeGetJsonWithAuthState(ctx, bridgeUrl, path) {
  const res = await bridgeFetch(ctx, bridgeUrl, path);
  if (!res) return { data: null, unreachable: true, loginUrl: null };

  // 401 = session exists but no Spotify tokens yet — user needs to log in.
  // 503 = bridge had a Spotify API error (e.g. after token exchange) — also
  //       show login if a loginUrl is present, otherwise treat as unreachable.
  if (res.status === 401 || res.status === 503) {
    const body = res.json;
    return {
      data: null,
      unreachable: false,
      needsLogin: true,
      loginUrl: body?.loginUrl || null,
    };
  }

  if (!res.ok) return { data: null, unreachable: true, loginUrl: null };
  return { data: res.json ?? null, unreachable: false, needsLogin: false, loginUrl: null };
}

async function fetchLyricsForTrack(ctx, bridgeUrl, nowPlaying) {
  const params = new URLSearchParams();
  if (nowPlaying.trackId)    params.set("trackId",    nowPlaying.trackId);
  if (nowPlaying.artist)     params.set("artist",     nowPlaying.artist);
  if (nowPlaying.title)      params.set("title",      nowPlaying.title);
  if (nowPlaying.album)      params.set("album",      nowPlaying.album);
  if (nowPlaying.durationMs != null)
    params.set("durationMs", String(nowPlaying.durationMs));
  return bridgeGetJson(ctx, bridgeUrl, `/lyrics?${params.toString()}`);
}

// ─── Browser opening ───────────────────────────────────────────────────────────
//
// Never hand a full URL (especially one carrying a ~50-char pairing token) to
// ctx.pet.speak — speech-bubble payloads go over the same IPC channel as every
// other ctx.pet.* call and have a hard size ceiling; a long URL trips
// "Message is too long" on that channel. Instead we try to open the user's
// default browser directly.
//
// CONFIRMED: OpenPets SDK browser opening methods (ctx.system.openUrl, etc.)
// do not exist or do not work on Windows. We use shell commands instead.

/**
 * Opens a URL in the user's default browser using platform-specific shell commands.
 * Tries multiple methods including Node.js child_process and OpenPets SDK methods.
 * 
 * @param {Object} ctx - The OpenPets plugin context
 * @param {string} url - The URL to open
 * @returns {Promise<boolean>} true if browser opened successfully, false otherwise
 */
async function openInBrowser(ctx, url) {
  // Method 1: Try Node.js child_process.exec (Windows start command)
  if (childProcess) {
    try {
      childProcess.exec(`start "" "${url}"`, (error) => {
        if (!error) {
          ctx.log?.info?.('Browser opened successfully via Node.js child_process.exec');
        }
      });
      // Assume success if no immediate error
      return true;
    } catch (e) {
      ctx.log?.warn?.('Node.js child_process.exec failed', { msg: e?.message || String(e) });
    }
  }

  // Method 2: Try ctx.shell.exec
  if (ctx.shell?.exec) {
    try {
      const result = await ctx.shell.exec(`start "" "${url}"`);
      if (result !== undefined) {
        ctx.log?.info?.('Browser opened successfully via ctx.shell.exec');
        return true;
      }
    } catch (e) {
      ctx.log?.warn?.('ctx.shell.exec failed', { msg: e?.message || String(e) });
    }
  }

  // Method 3: Try OpenPets SDK methods
  const candidates = [
    { name: 'system.openUrl', fn: () => ctx.system?.openUrl?.(url) },
    { name: 'system.openExternal', fn: () => ctx.system?.openExternal?.(url) },
    { name: 'shell.openExternal', fn: () => ctx.shell?.openExternal?.(url) },
    { name: 'browser.open', fn: () => ctx.browser?.open?.(url) },
    { name: 'app.openExternal', fn: () => ctx.app?.openExternal?.(url) }
  ];

  for (const { name, fn } of candidates) {
    try {
      const maybePromise = fn();
      if (maybePromise !== undefined) {
        await maybePromise;
        ctx.log?.info?.(`Browser opened successfully via ${name}`);
        return true;
      }
    } catch (e) {
      ctx.log?.warn?.(`Browser opening via ${name} failed`, { 
        msg: e?.message || String(e) 
      });
    }
  }

  // All methods failed
  ctx.log?.error?.('All browser opening methods failed', { url });
  return false;
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register(
        {
          id: "check-spotify-now",
          title: "Check Spotify Now",
          description: "Check what's playing on Spotify right now.",
        },
        async () => {
          void checkNow(ctx, true).catch((e) =>
            ctx.log?.warn?.("Manual check failed", e?.message)
          );
          await ctx.status.set({ text: "Spotify: checking now…", tone: "info" });
        }
      );

      await ctx.commands.register(
        {
          id: "spotify-whats-playing",
          title: "What's Playing?",
          description: "Ask your pet what's currently playing.",
        },
        async () => { await showWhatsPlaying(ctx); }
      );

      await ctx.commands.register(
        {
          id: "spotify-pause-play",
          title: "Pause / Play",
          description: "Toggle Spotify playback.",
        },
        async () => { await togglePausePlay(ctx); }
      );

      await ctx.commands.register(
        {
          id: "spotify-next-track",
          title: "Play Next Track",
          description: "Skip to the next track.",
        },
        async () => { await controlPlayback(ctx, "/next", "Playing next track!"); }
      );

      await ctx.commands.register(
        {
          id: "spotify-previous-track",
          title: "Play Previous Track",
          description: "Go back to the previous track.",
        },
        async () => { await controlPlayback(ctx, "/previous", "Playing previous track!"); }
      );

      await ctx.commands.register(
        {
          id: "spotify-show-lyrics",
          title: "Show Lyrics",
          description: "Recite a snippet of the current song's lyrics.",
        },
        async () => { await showLyrics(ctx); }
      );

      await ctx.commands.register(
        {
          id: "spotify-connect",
          title: "Connect Spotify",
          description: "Link your Spotify account to this plugin.",
        },
        async () => { await connectSpotify(ctx); }
      );

      await ctx.commands.register(
        {
          id: "spotify-show-login-url",
          title: "Show Spotify Login URL",
          description: "Display the login URL for manual browser connection.",
        },
        async () => { await showLoginUrl(ctx); }
      );

      await ctx.commands.register(
        {
          id: "spotify-reset-state",
          title: "Reset Spotify State",
          description: "Clear saved Spotify state.",
        },
        async () => { await resetSpotifyState(ctx); }
      );

      // Pair up front so the first poll already has a token.
      const config = await ctx.config.get();
      await ensurePaired(ctx, config.bridgeUrl);

      await scheduleNext(ctx);
      void checkNow(ctx, false).catch((e) =>
        ctx.log?.warn?.("Initial check failed", e?.message)
      );
    },

    async stop(ctx) {
      if (ctx) await cancelLyricSchedules(ctx);
    },
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") register(globalThis.OpenPetsPlugin);

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function scheduleNext(ctx) {
  const config = await ctx.config.get();
  const interval = Math.max(
    MIN_POLL_INTERVAL_SECONDS,
    Number(config.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS)
  );
  await ctx.schedule.cancel("spotify-poll");
  await ctx.schedule.once("spotify-poll", interval * 1000, async () => {
    await checkNow(ctx, false);
    await scheduleNext(ctx);
  });
}

async function checkNow(ctx, manual) {
  if (pollRunning) {
    if (manual) await ctx.pet.speak("Spotify check already running.");
    return;
  }
  pollRunning = true;
  try {
    const config = await ctx.config.get();

    const { data: nowPlaying, unreachable, needsLogin, loginUrl } =
      await bridgeGetJsonWithAuthState(ctx, config.bridgeUrl, "/now-playing");
    const pollWallMs = Date.now();

    // Session has no Spotify tokens yet — prompt the user to connect.
    if (needsLogin) {
      await ctx.status.set({ text: "Spotify: not connected", tone: "warning" });
      if (manual) {
        if (loginUrl) {
          const opened = await openInBrowser(ctx, loginUrl);
          await ctx.pet.speak(
            opened
              ? "I need permission to access Spotify! Opening your browser now."
              : "I need permission to access Spotify! Use the Connect Spotify command to open the login page."
          );
        } else {
          await ctx.pet.speak("I need permission first! Use the Connect Spotify command.");
        }
      }
      return;
    }

    if (unreachable || !nowPlaying) {
      await ctx.status.set({ text: "Spotify: bridge unreachable", tone: "warning" });
      if (manual) await ctx.pet.speak("Couldn't reach the Spotify bridge.");
      return;
    }

    if (!nowPlaying.playing) {
      const lastPlaying = await ctx.storage.get("spotify-lastPlaying");
      await cancelLyricSchedules(ctx);
      await clearLyricsRetryState(ctx);
      await ctx.status.set({ text: "Spotify: nothing playing", tone: "info" });
      if (lastPlaying && config.reactWhenPaused) await ctx.pet.react("idle");
      await ctx.storage.set("spotify-lastPlaying", false);
      await ctx.storage.set("spotify-lastTrackId", EMPTY_TRACK_ID);
      await ctx.storage.set("spotify-lyrics", null);
      await ctx.storage.set("spotify-lastLyricIndex", -1);
      return;
    }

    const lastTrackId = String(
      (await ctx.storage.get("spotify-lastTrackId")) || EMPTY_TRACK_ID
    );
    const currentTrackId = String(nowPlaying.trackId || EMPTY_TRACK_ID);
    const trackChanged = lastTrackId !== currentTrackId;
    const progressMs = nowPlaying.progressMs ?? 0;

    if (trackChanged) {
      await cancelLyricSchedules(ctx);
      await clearLyricsRetryState(ctx);

      const announcement = format(
        config.announceTemplate || "Now playing: {title} by {artist}",
        { title: nowPlaying.title, artist: nowPlaying.artist }
      );
      if (config.announceTrackChanges) await ctx.pet.speak(announcement);
      await ctx.pet.react(
        config.reactToMood ? featuresToReaction(nowPlaying.features) : "celebrating"
      );

      await ctx.storage.set("spotify-lastTrackId", currentTrackId);
      await ctx.storage.set("spotify-lastLyricIndex", -1);

      await markLyricsRetryAttempt(ctx, currentTrackId);
      const resolved = await tryResolveLyrics(
        ctx, config, nowPlaying, currentTrackId, progressMs, pollWallMs
      );
      if (!resolved) {
        await ctx.storage.set("spotify-lyrics", null);
      }
    } else {
      const storedLyrics = await ctx.storage.get("spotify-lyrics");

      if (storedLyrics?.length) {
        if (seekDriftDetected(progressMs)) {
          ctx.log?.info?.("Drift detected — rescheduling", {
            estimated: currentProgress(),
            actual: progressMs,
            diff: Math.abs((currentProgress() ?? 0) - progressMs),
          });
          await scheduleLyrics(ctx, storedLyrics, progressMs, 0);
        }
      } else if (await shouldRetryLyricsNow(ctx, currentTrackId)) {
        await markLyricsRetryAttempt(ctx, currentTrackId);
        await tryResolveLyrics(
          ctx, config, nowPlaying, currentTrackId, progressMs, pollWallMs
        );
      }
    }

    await ctx.storage.set("spotify-lastPlaying", true);
    await ctx.status.set({
      text: `Spotify: ${safeText(nowPlaying.title || "Unknown track", "Unknown track")} 🎶`,
      tone: "success",
    });

    if (manual && !trackChanged) {
      await ctx.pet.speak(
        format(config.announceTemplate || "Now playing: {title} by {artist}", {
          title: nowPlaying.title,
          artist: nowPlaying.artist,
        })
      );
    }
  } finally {
    pollRunning = false;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function showWhatsPlaying(ctx) {
  const config = await ctx.config.get();
  const nowPlaying = await bridgeGetJson(ctx, config.bridgeUrl, "/now-playing");
  if (!nowPlaying?.playing) {
    await ctx.pet.speak("Nothing is playing right now.");
    return;
  }
  await ctx.pet.speak(
    format(config.announceTemplate || "Now playing: {title} by {artist}", {
      title: nowPlaying.title,
      artist: nowPlaying.artist,
    })
  );
}

async function togglePausePlay(ctx) {
  const config = await ctx.config.get();
  const nowPlaying = await bridgeGetJson(ctx, config.bridgeUrl, "/now-playing");
  if (!nowPlaying) {
    await ctx.pet.speak("Can't reach Spotify bridge.");
    return;
  }
  if (nowPlaying.playing) {
    await cancelLyricSchedules(ctx);
    const ok = await bridgeControl(ctx, config.bridgeUrl, "/pause");
    if (ok) {
      await ctx.pet.speak("Paused.");
      await ctx.pet.react("idle");
      await ctx.status.set({ text: "Spotify: paused ⏸", tone: "info" });
    } else {
      await ctx.pet.speak("Couldn't pause Spotify.");
    }
  } else {
    const ok = await bridgeControl(ctx, config.bridgeUrl, "/play");
    if (ok) {
      void ctx.pet.speak("Resuming playback!");
      void ctx.pet.react("celebrating");
      await ctx.status.set({ text: "Spotify: resuming…", tone: "success" });
      void ctx.schedule.once("spotify-resume-check", 500, async () => {
        await checkNow(ctx, false);
      });
    } else {
      await ctx.pet.speak("Couldn't resume Spotify.");
    }
  }
}

async function controlPlayback(ctx, path, message) {
  const config = await ctx.config.get();
  await cancelLyricSchedules(ctx);
  await clearLyricsRetryState(ctx);

  await ctx.storage.set("spotify-lastTrackId", EMPTY_TRACK_ID);
  await ctx.storage.set("spotify-lyrics", null);
  await ctx.storage.set("spotify-lastLyricIndex", -1);

  const ok = await bridgeControl(ctx, config.bridgeUrl, path);
  if (ok) {
    void ctx.pet.speak(message);
    void ctx.schedule.once("spotify-skip-check-fast", 400, async () => {
      await checkNow(ctx, false);
    });
    void ctx.schedule.once("spotify-skip-check-slow", 1200, async () => {
      await checkNow(ctx, false);
    });
  } else {
    await ctx.pet.speak("Playback control failed. Check your bridge.");
    ctx.log?.warn?.("bridgeControl failed", { path });
  }
}

/**
 * "Connect Spotify" command.
 * Pairs with the bridge (gets a pairingToken), then opens the login link
 * directly in the user's browser. Opening that link starts OAuth for THIS
 * plugin's session — not a new unrelated session.
 *
 * WORKAROUND: Since OpenPets SDK doesn't provide browser opening methods,
 * we display the URL in multiple places so the user can manually copy and
 * open it in their browser.
 */
async function connectSpotify(ctx) {
  const config = await ctx.config.get();
  const result = await pairWithBridge(ctx, config.bridgeUrl);
  if (!result) {
    await ctx.pet.speak("Couldn't reach the Spotify bridge to start pairing.");
    return;
  }
  if (result.authorised) {
    await ctx.pet.speak("Spotify is already connected! Everything should be working.");
    return;
  }

  const opened = await openInBrowser(ctx, result.loginUrl);
  if (opened) {
    await ctx.pet.speak("Opening your browser — log in to connect Spotify!");
    await ctx.status.set({ text: "Spotify: waiting for login…", tone: "warning" });
  } else {
    // Browser opening failed - provide the URL in multiple ways
    
    // 1. Log it
    ctx.log?.info?.("Spotify login link (copy and paste in browser)", { loginUrl: result.loginUrl });
    
    // 2. Display shortened instruction in status
    await ctx.status.set({ text: `Spotify: Copy this URL and open in browser`, tone: "warning" });
    
    // 3. Show the full URL in the status text (might be truncated but worth trying)
    setTimeout(async () => {
      await ctx.status.set({ text: result.loginUrl, tone: "warning" });
    }, 2000);
    
    // 4. Try to display the URL via console/alert if available
    if (typeof console !== 'undefined') {
      console.log("=".repeat(80));
      console.log("SPOTIFY LOGIN URL - Copy and paste this into your browser:");
      console.log(result.loginUrl);
      console.log("=".repeat(80));
    }
    
    // 5. Tell the user where to find it
    await ctx.pet.speak("Please copy the login URL from the status bar or console and open it in your browser!");
  }
}

/**
 * Shows the Spotify login URL with the plugin's pairing token.
 * NEW: Uses device code flow - shows a simple 6-character code instead!
 */
async function showLoginUrl(ctx) {
  const config = await ctx.config.get();
  
  // Request a device code from the bridge (using GET for compatibility)
  try {
    const res = await ctx.http.fetch(`${config.bridgeUrl}/device-code/request`, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
        "user-agent": "OpenPets Spotify Buddy"
      },
      timeoutMs: 8000
    });
    
    if (!res?.ok) {
      await ctx.pet.speak("Couldn't reach the Spotify bridge.");
      ctx.log?.warn?.("Device code request failed", { status: res?.status, statusText: res?.statusText });
      return;
    }
    
    const data = res.json;
    const code = data.deviceCode;
    const activationUrl = data.activationUrl;
    
    // Show the code prominently
    await ctx.status.set({ text: `Code: ${code} - Visit ${activationUrl}`, tone: "warning" });
    await ctx.pet.speak(`Your activation code is ${code}. Visit ${activationUrl} and enter this code!`);
    
    ctx.log?.info?.("Device activation code", { code, activationUrl });
    
    if (typeof console !== 'undefined') {
      console.log("\n" + "=".repeat(60));
      console.log("SPOTIFY ACTIVATION:");
      console.log(`1. Visit: ${activationUrl}`);
      console.log(`2. Enter code: ${code}`);
      console.log(`3. Log in to Spotify`);
      console.log("=".repeat(60) + "\n");
    }
    
    // Start polling for authorization
    startDeviceCodePolling(ctx, code, config.bridgeUrl);
    
  } catch (e) {
    ctx.log?.warn?.("Device code request failed", { msg: e?.message || String(e) });
    await ctx.pet.speak("Failed to generate activation code. Check your bridge connection.");
  }
}

/**
 * Polls the bridge to check if the user has completed device activation
 * Uses OpenPets schedule API for compatibility
 */
async function startDeviceCodePolling(ctx, code, bridgeUrl) {
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes (polling every 5 seconds)
  
  const pollOnce = async () => {
    attempts++;
    
    if (attempts > maxAttempts) {
      await ctx.pet.speak("Activation code expired. Please request a new one.");
      await ctx.status.set({ text: "Spotify: activation timed out", tone: "warning" });
      return;
    }
    
    try {
      const res = await ctx.http.fetch(`${bridgeUrl}/device-code/poll?code=${code}`, {
        method: "GET",
        headers: {
          "ngrok-skip-browser-warning": "true",
          "user-agent": "OpenPets Spotify Buddy"
        },
        timeoutMs: 8000
      });
      
      if (res?.ok) {
        const data = res.json;
        
        if (data.authorized) {
          // Success!
          if (data.pairingToken) {
            cachedBridgeToken = data.pairingToken;
            await ctx.storage.set(BRIDGE_TOKEN_STORAGE_KEY, data.pairingToken);
          }
          
          await ctx.pet.speak("Spotify connected successfully! Playback controls should work now.");
          await ctx.status.set({ text: "Spotify: connected! 🎵", tone: "success" });
          
          ctx.log?.info?.("Device activation complete");
          
          // Trigger an immediate check
          void checkNow(ctx, false);
          return; // Stop polling
        } else {
          // Still waiting - schedule next poll
          await ctx.schedule.once(`spotify-device-poll-${attempts}`, 5000, pollOnce);
        }
      } else {
        // Error or code not found - schedule retry
        await ctx.schedule.once(`spotify-device-poll-${attempts}`, 5000, pollOnce);
      }
    } catch (e) {
      ctx.log?.warn?.("Device code poll failed", { msg: e?.message || String(e) });
      // Schedule retry
      await ctx.schedule.once(`spotify-device-poll-${attempts}`, 5000, pollOnce);
    }
  };
  
  // Start first poll
  await pollOnce();
}

async function resetSpotifyState(ctx) {
  await cancelLyricSchedules(ctx);
  await clearLyricsRetryState(ctx);
  await ctx.storage.delete("spotify-lastTrackId");
  await ctx.storage.delete("spotify-lastPlaying");
  await ctx.storage.delete("spotify-lyrics");
  await ctx.storage.delete("spotify-lastLyricIndex");
  await ctx.status.set({ text: "Spotify: state cleared", tone: "info" });
  await ctx.pet.speak("Spotify state has been reset.");
  await checkNow(ctx, false);
}

// ─── Lyrics display ───────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function cleanLyricsBlob(rawLyrics) {
  return rawLyrics
    .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetFrom(cleaned) {
  const snippet =
    cleaned.length > 137 ? cleaned.slice(0, 137).trim() + "..." : cleaned;
  return snippet.replace(/[`'"<>]/g, "").trim();
}

async function showLyrics(ctx) {
  try {
    const storedLyrics = await ctx.storage.get("spotify-lyrics");
    if (storedLyrics?.length) {
      const lastIndex = Number((await ctx.storage.get("spotify-lastLyricIndex")) ?? -1);
      const fromIndex = lastIndex >= 0 ? lastIndex : 0;
      const upcoming = storedLyrics.slice(fromIndex).map((l) => l.text).join(" ");
      const cleaned = cleanLyricsBlob(
        upcoming || storedLyrics.map((l) => l.text).join(" ")
      );
      const final = snippetFrom(cleaned);
      await ctx.pet.speak(final || "Lyrics couldn't be displayed.");
      return;
    }

    const config = await ctx.config.get();
    const nowPlaying = await withTimeout(
      bridgeGetJson(ctx, config.bridgeUrl, "/now-playing"),
      SHOW_LYRICS_FETCH_TIMEOUT_MS
    );
    if (!nowPlaying) {
      await ctx.pet.speak("Spotify bridge is slow — try again shortly.");
      return;
    }
    if (!nowPlaying.playing) {
      await ctx.pet.speak("Nothing is playing right now.");
      return;
    }

    const data = await withTimeout(
      fetchLyricsForTrack(ctx, config.bridgeUrl, nowPlaying),
      SHOW_LYRICS_FETCH_TIMEOUT_MS
    );
    if (!data) {
      await ctx.pet.speak("Lyrics are still loading — try again in a moment.");
      return;
    }
    if (!data.lyrics?.plain && !data.lyrics?.synced?.length) {
      await ctx.pet.speak("No lyrics available for this song.");
      return;
    }

    const rawLyrics = data.lyrics.plain
      ? data.lyrics.plain
      : data.lyrics.synced.map((l) => l.text).join(" ");

    const cleaned = cleanLyricsBlob(rawLyrics);
    if (!cleaned) {
      await ctx.pet.speak("Lyrics are empty after cleaning.");
      return;
    }

    await ctx.pet.speak(snippetFrom(cleaned) || "Lyrics couldn't be displayed.");

    if (data.lyrics?.synced?.length) {
      await ctx.storage.set("spotify-lyrics", data.lyrics.synced);
    }
  } catch (error) {
    ctx.log?.error?.("showLyrics error:", error);
    await ctx.pet.speak("Error getting lyrics: " + (error?.message || "unknown"));
  }
}

// ─── Mood → reaction ──────────────────────────────────────────────────────────

function featuresToReaction(features) {
  if (!features) return "celebrating";
  const energy  = Number(features.energy  || 0);
  const valence = Number(features.valence || 0);
  const tempo   = Number(features.tempo   || 0);
  if (energy >= 0.8 && valence >= 0.65 && tempo >= 140) return "celebrating";
  if (energy >= 0.75 && valence <= 0.35 && tempo >= 140) return "running";
  if (valence >= 0.7 && energy <= 0.55) return "waving";
  if (energy <= 0.35 && valence <= 0.4) return "thinking";
  return "working";
}