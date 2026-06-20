// Spotify Buddy (openpets.spotify-buddy) — SDK v3 Spotify companion.

const DEFAULT_CLIENT_ID = "1ac5489fdb9a46a8bf4c9179ca7a291f";

const OAUTH_CONFIG = {
  provider: "spotify",
  authorizationUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  scopes: [
    "user-read-currently-playing",
    "user-read-playback-state",
    "user-modify-playback-state"
  ],
  pkce: true,
  redirect: "loopback",
  loopbackPort: 48373
};

const sessions = new WeakMap();

function getSession(ctx) {
  let session = sessions.get(ctx);
  if (!session) {
    session = {
      pollTimeout: null,
      activeTimeouts: new Set(),
      accessToken: null,
      expiresAt: 0,
      lastTrackId: null,
      nowPlayingBubble: null,
      lyricsCache: new Map(), // trackId -> array of { timeMs, text }
      lastLyricLine: null,
      lyricLinesShowCounter: 0,
      backoffUntil: 0,
      consecutiveErrors: 0,
      isPlaying: false,
      lastStatusUpdateText: "",
      lyricsSettings: {
        showLyrics: true,
        lyricIntensity: "normal"
      }
    };
    sessions.set(ctx, session);
  }
  return session;
}

function setPluginTimeout(ctx, fn, delay) {
  const s = getSession(ctx);
  const t = setTimeout(() => {
    s.activeTimeouts.delete(t);
    try {
      const p = fn();
      if (p instanceof Promise) {
        p.catch((err) => {
          ctx.log.error("Async timer callback rejected", { error: err.message });
        });
      }
    } catch (err) {
      ctx.log.error("Timer callback threw sync error", { error: err.message });
    }
  }, delay);
  s.activeTimeouts.add(t);
  return t;
}

function getClientId() {
  return DEFAULT_CLIENT_ID;
}

async function getAccessToken(ctx, forceRefresh = false) {
  const s = getSession(ctx);
  const nowMs = Date.now();
  if (forceRefresh || !s.accessToken || !s.expiresAt || s.expiresAt - nowMs < 60000) {
    try {
      const res = await ctx.auth.refresh("spotify");
      s.accessToken = res.accessToken;
      s.expiresAt = res.expiresAt || (nowMs + 3600000);
    } catch {
      s.accessToken = null;
      s.expiresAt = 0;
    }
  }
  return s.accessToken;
}

function parseJson(res) {
  if (res.json !== undefined) return res.json;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

async function spotifyRequest(ctx, path, method = "GET", body = null) {
  const token = await getAccessToken(ctx);
  if (!token) {
    throw new Error("NOT_AUTHENTICATED");
  }
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`
    }
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  
  const url = `https://api.spotify.com${path}`;
  const res = await ctx.net.fetch(url, options);
  
  if (res.status === 401) {
    try {
      const newToken = await getAccessToken(ctx, true);
      if (!newToken) {
        throw new Error("NOT_AUTHENTICATED");
      }
      options.headers["Authorization"] = `Bearer ${newToken}`;
      return await ctx.net.fetch(url, options);
    } catch {
      throw new Error("NOT_AUTHENTICATED");
    }
  }
  if (res.status === 429) {
    let retryAfter = 5;
    if (res.headers && res.headers["retry-after"]) {
      retryAfter = parseInt(res.headers["retry-after"], 10) || 5;
    } else if (res.headers && res.headers["Retry-After"]) {
      retryAfter = parseInt(res.headers["Retry-After"], 10) || 5;
    }
    throw { status: 429, retryAfter };
  }
  
  return res;
}

async function sendCommand(ctx, path, method = "POST") {
  try {
    const res = await spotifyRequest(ctx, path, method);
    if (res.status === 403) {
      let isPremiumRequired = false;
      const json = parseJson(res);
      if (json?.error?.reason === "PREMIUM_REQUIRED" || json?.error?.message?.includes("Premium")) {
        isPremiumRequired = true;
      }
      if (isPremiumRequired) {
        await ctx.pet.speak(ctx.t("speech.premiumRequired"));
        await ctx.pet.react("error");
        return false;
      }
    }
    if (res.status === 404 || res.status === 403) {
      await ctx.pet.speak(ctx.t("speech.noActiveDevice"));
      await ctx.pet.react("thinking");
      return false;
    }
    if (!res.ok) {
      let reason = "HTTP error";
      try {
        const json = parseJson(res);
        if (json?.error?.message) {
          reason = json.error.message;
        }
      } catch {}
      ctx.log.warn("Spotify command failed", { status: res.status, reason });
      return false;
    }
    return true;
  } catch (err) {
    if (err.message === "NOT_AUTHENTICATED") {
      await ctx.pet.speak(ctx.t("speech.notConnected"));
      await ctx.pet.react("thinking");
    } else if (err.status === 429) {
      const s = getSession(ctx);
      s.backoffUntil = Date.now() + err.retryAfter * 1000;
      await ctx.pet.speak(ctx.t("speech.rateLimited"));
    } else {
      ctx.log.error("Spotify command unexpected error", { error: err.message });
    }
    return false;
  }
}

function parseSyncedLyrics(syncedLyricsText) {
  if (!syncedLyricsText) return [];
  const lines = syncedLyricsText.split(/\r?\n/);
  const parsed = [];
  for (const line of lines) {
    const match = line.match(/^\[(\d+):(\d+)(?:\.(\d+))?\](.*)$/);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const msPart = match[3] || "0";
      const msVal = parseInt(msPart.padEnd(3, "0").slice(0, 3), 10);
      const timeMs = min * 60 * 1000 + sec * 1000 + msVal;
      const text = match[4].trim();
      parsed.push({ timeMs, text });
    }
  }
  parsed.sort((a, b) => a.timeMs - b.timeMs);
  return parsed;
}

async function loadLyrics(ctx, trackName, artistName, albumName, durationMs, trackId) {
  const s = getSession(ctx);
  if (s.lyricsCache.has(trackId)) {
    return;
  }
  
  try {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("artist_name", artistName);
    url.searchParams.set("track_name", trackName);
    if (albumName) url.searchParams.set("album_name", albumName);
    if (durationMs) url.searchParams.set("duration", Math.round(durationMs / 1000).toString());
    
    const res = await ctx.net.fetch(url.toString(), {
      method: "GET",
      timeoutMs: 4000
    });
    
    if (res.status === 200) {
      const data = parseJson(res);
      if (data && data.syncedLyrics) {
        const parsed = parseSyncedLyrics(data.syncedLyrics);
        s.lyricsCache.set(trackId, parsed);
        return;
      }
    }
  } catch (err) {
    ctx.log.warn("LRCLIB lookup failed or timed out", { error: err.message });
  }
  
  s.lyricsCache.set(trackId, []);
}

function findLyricLine(lines, progressMs) {
  let matched = null;
  for (const line of lines) {
    if (line.timeMs <= progressMs) {
      matched = line;
    } else {
      break;
    }
  }
  return matched;
}

async function matchAndShowLyrics(ctx, trackId, progressMs) {
  const s = getSession(ctx);
  const lines = s.lyricsCache.get(trackId);
  if (!lines || lines.length === 0) return;
  
  const matched = findLyricLine(lines, progressMs);
  if (!matched || !matched.text) return;
  
  if (matched.text !== s.lastLyricLine) {
    s.lastLyricLine = matched.text;
    
    const divisor = s.lyricsSettings.lyricIntensity === "chill" ? 4 : (s.lyricsSettings.lyricIntensity === "normal" ? 2 : 1);
    const count = s.lyricLinesShowCounter++;
    if (count % divisor === 0) {
      let lyricText = matched.text;
      if (lyricText.length > 120) {
        lyricText = lyricText.substring(0, 117) + "...";
      }
      await ctx.ui.bubble({
        text: `♪ ${lyricText}`,
        durationMs: 3000,
        priority: "low",
        dismissOn: ["timeout"]
      });
    }
  }
}

async function showNowPlayingBubble(ctx, trackName, artistName, isPlaying) {
  const s = getSession(ctx);
  if (s.nowPlayingBubble) {
    try { await s.nowPlayingBubble.dismiss(); } catch {}
    s.nowPlayingBubble = null;
  }
  
  const config = (await ctx.config.get()) ?? {};
  const actions = [];
  if (config.showControls !== false) {
    if (isPlaying) {
      actions.push({ id: "pause", label: ctx.t("action.pause") });
    } else {
      actions.push({ id: "play", label: ctx.t("action.play"), style: "primary" });
    }
    actions.push({ id: "next", label: ctx.t("action.next") });
    if (s.lyricsSettings.showLyrics) {
      actions.push({ id: "lyrics", label: ctx.t("action.lyrics") });
    }
  }
  
  const bubble = await ctx.ui.bubble({
    text: `${artistName} — ${trackName}`,
    tone: "info",
    sticky: true,
    priority: "normal",
    actions
  });
  
  s.nowPlayingBubble = bubble;
  
  bubble.onAction(async (actionId) => {
    if (actionId === "play") {
      const ok = await sendCommand(ctx, "/v1/me/player/play", "PUT");
      if (ok) {
        s.isPlaying = true;
        await showNowPlayingBubble(ctx, trackName, artistName, true);
      }
    } else if (actionId === "pause") {
      const ok = await sendCommand(ctx, "/v1/me/player/pause", "PUT");
      if (ok) {
        s.isPlaying = false;
        await showNowPlayingBubble(ctx, trackName, artistName, false);
      }
    } else if (actionId === "next") {
      const ok = await sendCommand(ctx, "/v1/me/player/next", "POST");
      if (ok) {
        await ctx.pet.react("working");
        setPluginTimeout(ctx, () => pollPlaybackState(ctx), 1000);
      }
    } else if (actionId === "lyrics") {
      s.lyricsSettings.showLyrics = !s.lyricsSettings.showLyrics;
      await ctx.pet.speak(s.lyricsSettings.showLyrics ? ctx.t("speech.lyricsOn") : ctx.t("speech.lyricsOff"));
    }
  });
}

async function updateNowPlayingBubble(ctx, trackName, artistName, isPlaying) {
  const s = getSession(ctx);
  if (!s.nowPlayingBubble) return;
  
  const config = (await ctx.config.get()) ?? {};
  const actions = [];
  if (config.showControls !== false) {
    if (isPlaying) {
      actions.push({ id: "pause", label: ctx.t("action.pause") });
    } else {
      actions.push({ id: "play", label: ctx.t("action.play"), style: "primary" });
    }
    actions.push({ id: "next", label: ctx.t("action.next") });
    if (s.lyricsSettings.showLyrics) {
      actions.push({ id: "lyrics", label: ctx.t("action.lyrics") });
    }
  }
  
  try {
    await s.nowPlayingBubble.update({
      text: `${artistName} — ${trackName}`,
      actions
    });
  } catch {
    s.nowPlayingBubble = null;
  }
}

async function pollPlaybackState(ctx, opts = {}) {
  const s = getSession(ctx);
  if (s.backoffUntil && Date.now() < s.backoffUntil) {
    return;
  }
  
  try {
    const res = await spotifyRequest(ctx, "/v1/me/player");
    if (res.status === 204 || !res.ok) {
      if (s.isPlaying) {
        s.isPlaying = false;
        await ctx.status.set({ text: ctx.t("status.idle") });
      }
      return;
    }
    
    let playback;
    try {
      playback = JSON.parse(res.text);
    } catch {
      return;
    }
    
    s.consecutiveErrors = 0;
    
    if (!playback || !playback.item) {
      if (s.isPlaying) {
        s.isPlaying = false;
        await ctx.status.set({ text: ctx.t("status.idle") });
      }
      return;
    }
    
    const track = playback.item;
    const isPlaying = playback.is_playing;
    const progressMs = playback.progress_ms;
    const trackId = track.id;
    const trackName = track.name;
    const artistName = track.artists?.map(a => a.name).join(", ") || "Unknown Artist";
    const durationMs = track.duration_ms;
    
    s.isPlaying = isPlaying;
    
    let statusText = "";
    if (isPlaying) {
      statusText = ctx.t("status.playing", { artist: artistName, track: trackName });
    } else {
      statusText = ctx.t("status.paused");
    }
    if (statusText !== s.lastStatusUpdateText) {
      await ctx.status.set({ text: statusText });
      s.lastStatusUpdateText = statusText;
    }
    
    const trackChanged = trackId !== s.lastTrackId;
    if (trackChanged || opts.forceAnnounce) {
      s.lastTrackId = trackId;
      s.lastLyricLine = null;
      s.lyricLinesShowCounter = 0;
      
      if (s.lyricsSettings.showLyrics) {
        await loadLyrics(ctx, trackName, artistName, track.album?.name, durationMs, trackId);
      }
      
      const config = (await ctx.config.get()) ?? {};
      const shouldAnnounce = opts.forceAnnounce || (config.showNowPlaying !== false && (!config.quietWhenPaused || isPlaying));
      
      if (shouldAnnounce) {
        await showNowPlayingBubble(ctx, trackName, artistName, isPlaying);
        await ctx.pet.react(isPlaying ? "celebrating" : "idle");
      }
    } else {
      if (s.nowPlayingBubble) {
        const config = (await ctx.config.get()) ?? {};
        if (config.quietWhenPaused && !isPlaying) {
          try { await s.nowPlayingBubble.dismiss(); } catch {}
          s.nowPlayingBubble = null;
        } else {
          await updateNowPlayingBubble(ctx, trackName, artistName, isPlaying);
        }
      }
    }
    
    if (isPlaying && s.lyricsSettings.showLyrics) {
      await matchAndShowLyrics(ctx, trackId, progressMs);
    }
    
  } catch (err) {
    if (err.message === "NOT_AUTHENTICATED") {
      s.lastTrackId = null;
      s.isPlaying = false;
      await ctx.status.set({ text: ctx.t("status.idle") });
    } else if (err.status === 429) {
      s.backoffUntil = Date.now() + err.retryAfter * 1000;
      ctx.log.warn("Spotify rate limited, backing off", { retryAfter: err.retryAfter });
    } else {
      s.consecutiveErrors++;
      if (s.consecutiveErrors > 5) {
        s.lastTrackId = null;
        s.isPlaying = false;
      }
      ctx.log.error("Error in spotify poll loop", { error: err.message });
    }
  }
}

function getPollDelay(ctx) {
  const s = getSession(ctx);
  if (!s.isPlaying) {
    return 10000;
  }
  if (s.lyricsSettings.showLyrics) {
    const lines = s.lyricsCache.get(s.lastTrackId);
    if (lines && lines.length > 0) {
      return 2500;
    }
  }
  return 5000;
}

async function tick(ctx) {
  const s = getSession(ctx);
  if (!s.pollTimeout) return;
  
  try {
    await pollPlaybackState(ctx);
  } catch (err) {
    ctx.log.error("Error in spotify poll tick", { error: err.message });
  }
  
  const delay = getPollDelay(ctx);
  if (s.pollTimeout) {
    s.pollTimeout = setPluginTimeout(ctx, () => tick(ctx), delay);
  }
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      const s = getSession(ctx);
      const cfg = (await ctx.config.get()) ?? {};
      s.lyricsSettings.showLyrics = cfg.showLyrics !== false;
      s.lyricsSettings.lyricIntensity = cfg.lyricIntensity || "normal";
      
      ctx.config.onChange(async (newCfg) => {
        s.lyricsSettings.showLyrics = newCfg.showLyrics !== false;
        s.lyricsSettings.lyricIntensity = newCfg.lyricIntensity || "normal";
      });
      
      await ctx.commands.register({
        id: "spotify-connect",
        title: ctx.t("command.connect.title"),
        description: ctx.t("command.connect.description")
      }, async () => {
        try {
          const clientId = getClientId();
          const tokens = await ctx.auth.oauth({
            ...OAUTH_CONFIG,
            clientId
          });
          const session = getSession(ctx);
          session.accessToken = tokens.accessToken;
          session.expiresAt = tokens.expiresAt || (Date.now() + 3600000);
          session.consecutiveErrors = 0;
          await ctx.pet.react("celebrating");
          await pollPlaybackState(ctx);
        } catch (err) {
          ctx.log.error("Spotify connect failed", { error: err.message });
          await ctx.pet.speak(ctx.t("speech.reconnectHint"));
          await ctx.pet.react("error");
        }
      });

      await ctx.commands.register({
        id: "spotify-disconnect",
        title: ctx.t("command.disconnect.title"),
        description: ctx.t("command.disconnect.description")
      }, async () => {
        try {
          await ctx.auth.signOut("spotify");
          const session = getSession(ctx);
          session.accessToken = null;
          session.expiresAt = 0;
          session.backoffUntil = 0;
          session.lastStatusUpdateText = "";
          session.lastTrackId = null;
          session.isPlaying = false;
          if (session.nowPlayingBubble) {
            try { await session.nowPlayingBubble.dismiss(); } catch {}
            session.nowPlayingBubble = null;
          }
          await ctx.status.set({ text: ctx.t("status.idle") });
          await ctx.pet.react("idle");
         } catch (err) {
          ctx.log.error("Spotify disconnect failed", { error: err.message });
        }
      });

      await ctx.commands.register({
        id: "spotify-play-pause",
        title: ctx.t("command.playPause.title"),
        description: ctx.t("command.playPause.description")
      }, async () => {
        const session = getSession(ctx);
        if (session.isPlaying) {
          const ok = await sendCommand(ctx, "/v1/me/player/pause", "PUT");
          if (ok) {
            session.isPlaying = false;
            await ctx.status.set({ text: ctx.t("status.paused") });
            await ctx.pet.react("idle");
          }
        } else {
          const ok = await sendCommand(ctx, "/v1/me/player/play", "PUT");
          if (ok) {
            session.isPlaying = true;
            await ctx.pet.react("celebrating");
          }
        }
        setPluginTimeout(ctx, () => pollPlaybackState(ctx), 1000);
      });

      await ctx.commands.register({
        id: "spotify-next",
        title: ctx.t("command.next.title"),
        description: ctx.t("command.next.description")
      }, async () => {
        const ok = await sendCommand(ctx, "/v1/me/player/next", "POST");
        if (ok) {
          await ctx.pet.react("working");
          setPluginTimeout(ctx, () => pollPlaybackState(ctx), 1000);
        }
      });

      await ctx.commands.register({
        id: "spotify-previous",
        title: ctx.t("command.previous.title"),
        description: ctx.t("command.previous.description")
      }, async () => {
        const ok = await sendCommand(ctx, "/v1/me/player/previous", "POST");
        if (ok) {
          await ctx.pet.react("working");
          setPluginTimeout(ctx, () => pollPlaybackState(ctx), 1000);
        }
      });

      await ctx.commands.register({
        id: "spotify-toggle-lyrics",
        title: ctx.t("command.toggleLyrics.title"),
        description: ctx.t("command.toggleLyrics.description")
      }, async () => {
        const session = getSession(ctx);
        session.lyricsSettings.showLyrics = !session.lyricsSettings.showLyrics;
        await ctx.pet.speak(session.lyricsSettings.showLyrics ? ctx.t("speech.lyricsOn") : ctx.t("speech.lyricsOff"));
      });

      await ctx.commands.register({
        id: "spotify-now-playing",
        title: ctx.t("command.showNowPlaying.title"),
        description: ctx.t("command.showNowPlaying.description")
      }, async () => {
        const token = await getAccessToken(ctx);
        if (!token) {
          await ctx.pet.speak(ctx.t("speech.notConnected"));
          await ctx.pet.react("thinking");
          return;
        }
        await pollPlaybackState(ctx, { forceAnnounce: true });
      });

      if (!s.pollTimeout) {
        s.pollTimeout = true; // Mark active
        s.pollTimeout = setPluginTimeout(ctx, () => tick(ctx), 1000);
      }
    },
    async stop(ctx) {
      const s = getSession(ctx);
      s.pollTimeout = null;
      for (const t of s.activeTimeouts) {
        clearTimeout(t);
      }
      s.activeTimeouts.clear();
      if (s.nowPlayingBubble) {
        try { await s.nowPlayingBubble.dismiss(); } catch {}
        s.nowPlayingBubble = null;
      }
    }
  });
}

export {
  OAUTH_CONFIG,
  DEFAULT_CLIENT_ID,
  getSession,
  getClientId,
  getAccessToken,
  spotifyRequest,
  sendCommand,
  parseSyncedLyrics,
  loadLyrics,
  findLyricLine,
  matchAndShowLyrics,
  showNowPlayingBubble,
  updateNowPlayingBubble,
  pollPlaybackState
};
