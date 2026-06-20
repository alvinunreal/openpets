# Spotify Buddy Plugin Plan

`openpets.spotify-buddy` is a proposed official SDK v3 plugin that turns the
default pet into a polished Spotify companion. It should control the Spotify app
the user already runs, react to playback changes, and optionally show short
sing-along lyric bubbles.

This document is a product and implementation plan. It does not change the SDK
contract or current official plugin lineup by itself. The source-of-truth files
for plugin behavior remain `packages/sdk/src/index.ts`,
`apps/desktop/src/plugin-sdk-bridge.ts`, and the focused `plugin-sdk-*` host
modules described in [../sdk.md](../sdk.md) and [../plugins.md](../plugins.md).

## Product stance

Spotify Buddy should be a companion-first remote control, not a full Spotify
client. OpenPets should not stream Spotify audio, embed an unofficial player, or
scrape private Spotify surfaces. The plugin should make the pet feel musically
aware while delegating playback to the official Spotify desktop, mobile, or web
player.

The core promise is:

> Control and react to the Spotify app you already use. Optional sing-along
> bubbles are powered by LRCLIB when lyrics are available.

This keeps the plugin aligned with the SuperPlugins thesis: the pet stays the
primary interaction surface, plugin UI remains host-rendered, and user actions
live in the pet right-click menu and transient bubbles.

## Feasibility summary

The current SDK v3 surface is sufficient for a strong first version:

| Capability | SDK namespace | Use in Spotify Buddy |
| --- | --- | --- |
| OAuth login | `ctx.auth` | Run Spotify Authorization Code with PKCE. |
| Secure tokens | `ctx.auth` / host auth storage | Persist refresh/access tokens through the host. |
| API calls | `ctx.net` | Call Spotify Web API and LRCLIB. |
| Session state | plugin memory | Cache current track, lyric data, settings, token, and backoff state for the running session. |
| Polling | plugin-owned timers | Refresh playback state with adaptive intervals; do not use `ctx.schedule` for short polling. |
| Pet reactions | `ctx.pet` | Dance, sleep, speak, and react to playback events. |
| Bubbles and buttons | `ctx.ui` | Show now-playing, controls, and lyric lines. |
| Right-click actions | `ctx.commands` | Expose connect, play/pause, next, previous, lyrics, and now-playing commands. |
| Status | `ctx.status` | Publish compact now-playing text. |

The main constraints are outside OpenPets:

- Spotify playback control generally requires Spotify Premium and an active
  playback device.
- Spotify does not provide a public lyrics API.
- Electron should not attempt Spotify Web Playback SDK streaming because Widevine
  DRM support is not available in stock Electron.
- Public Spotify app distribution may require quota approval. Spotify Buddy
  should not ship as normal production setup until OpenPets can use its own
  approved public Client ID.

## Non-goals

Spotify Buddy should not include these behaviors in the official plugin:

- Streaming Spotify audio inside OpenPets.
- Using private Spotify endpoints, browser cookies, or undocumented APIs.
- Scraping Genius or Spotify web pages for lyrics.
- Displaying full lyrics as a karaoke panel unless the licensing source allows
  that use.
- Replacing Spotify's real player UI.

## OAuth and setup

The plugin should use Spotify Authorization Code with PKCE. Public desktop
plugins cannot protect a client secret, so the OAuth flow must not rely on one.
OpenPets should delegate the browser flow, state checking, PKCE verifier, and
loopback redirect handling to `ctx.auth`.

The preferred redirect URI is registered in the Spotify Developer Dashboard on a fixed port:

```txt
http://127.0.0.1:48373/callback
```

At runtime, `apps/desktop/src/plugin-oauth.ts` listens on the fixed port `48373` and errors clearly if that port is busy:

```txt
http://127.0.0.1:48373/callback
```

### Client ID strategy

Spotify Buddy uses a baked-in public Client ID constant for the official OpenPets Spotify app to provide a seamless setup experience. Normal users do not need to bring their own Client ID. The Client Secret is never used by runtime code because the plugin uses PKCE.

### Scopes

Our required authorization scopes are: `user-read-currently-playing`, `user-read-playback-state`, and `user-modify-playback-state`. Library scopes are deferred to minimize permissions.

## Manifest shape

The plugin should request the smallest OpenPets permission set that supports its
features. A likely manifest starts with:

```json [openpets.plugin.json]
{
  "manifestVersion": 3,
  "id": "openpets.spotify-buddy",
  "runtime": "javascript",
  "permissions": [
    "auth",
    "status",
    "commands",
    "network",
    "network:write",
    "pet:speak",
    "pet:reaction",
    "pet:interact"
  ],
  "network": {
    "hosts": ["api.spotify.com", "lrclib.net"]
  }
}
```

The final manifest must use localized `$t:` labels and ship
`locales/en.json`. If the plugin declares assets for an icon or sound effects,
those assets must be validated by the normal plugin release pipeline.

## Configuration

The settings form should stay short and understandable:

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| Spotify Client ID override | `secret` | empty | Development-only override for contributors; hidden or advanced in production builds. |
| Show now-playing bubbles | `boolean` | true | Announces track changes. |
| Show lyric bubbles | `boolean` | true | Enables LRCLIB sing-along bubbles. |
| Lyric intensity | enum-like string | `normal` | Controls bubble frequency: `chill`, `normal`, `karaoke`. |
| Show control buttons | `boolean` | true | Adds play/next/like actions to bubbles. |
| Quiet mode while paused | `boolean` | true | Slows polling and suppresses music chatter when paused. |

If the manifest config schema does not support enum fields, `Lyric intensity`
can start as a string field with validation in plugin code or become separate
boolean/number fields.

## Feature plan

### Phase 1: remote control MVP

The first phase should prove the safe integration path:

- Connect Spotify through `ctx.auth`.
- Poll current playback state through `ctx.net`.
- Show a now-playing bubble on track changes.
- Publish compact status text such as `♪ Artist — Song`.
- Register right-click commands for play/pause, next, previous, and show current
  song.
- Handle no-device, expired-token, non-Premium, and rate-limit states gracefully.

The pet should respond with plain-language messages:

- “Open Spotify first — I do not see an active player.”
- “Spotify Premium is needed for playback controls.”
- “I lost Spotify access. Reconnect when you are ready.”

### Phase 2: polished companion behavior

The second phase should make the plugin feel alive:

- React when playback starts, pauses, resumes, or changes tracks.
- Dance or show an energetic reaction while music is playing.
- Nap or calm down when paused.
- Celebrate when the user likes a track.
- Offer bubble buttons for play/pause, next, and like.
- Cache the last track to avoid duplicate announcements after restart.

This phase should tune copy and timing carefully. The plugin should feel present
without spamming the user.

### Phase 3: LRCLIB lyric bubbles

Spotify does not expose public lyrics. The legitimate free path is LRCLIB, a
community-driven lyrics database that can return synced and unsynced lyrics
without a Spotify-private endpoint.

On track change, the plugin should query LRCLIB with Spotify metadata:

```txt
https://lrclib.net/api/get?artist_name=...&track_name=...&album_name=...&duration=...
```

If synced lyrics exist, the plugin should match Spotify `progress_ms` to the
current lyric line and show short pet bubbles. If only unsynced lyrics exist, the
plugin can show occasional static snippets or skip lyrics entirely. If no lyrics
exist, it should fall back to now-playing behavior.

Lyrics should be short-lived bubble content, not a full lyrics viewer. The plugin
should cache LRCLIB results by Spotify track ID and avoid repeating the same line
too often.

### Phase 4: release hardening

Before the plugin ships, complete the normal official-plugin quality ladder:

- Add deterministic harness tests for auth decisions, command actions, polling,
  rate-limit backoff, track-change announcements, and lyric matching.
- Validate manifest permissions, network hosts, assets, and localization.
- Run `pnpm plugins:package` and `pnpm plugins:validate-release` before any
  catalog release.
- Document Spotify Developer Dashboard setup if users need their own Client ID.
- Decide whether the plugin is catalog-only or bundled. It should start as
  catalog-only unless OpenPets has an approved Spotify app and the setup flow is
  one-click for normal users.

## Spotify Web API controls

Spotify Buddy can expose the following pet actions when the user has Premium and
an active playback device:

| Pet action | Spotify endpoint | Notes |
| --- | --- | --- |
| Play | `PUT /v1/me/player/play` | Can target the active device. |
| Pause | `PUT /v1/me/player/pause` | This is the closest supported equivalent to stop. |
| Next | `POST /v1/me/player/next` | Should refresh state shortly after command. |
| Previous | `POST /v1/me/player/previous` | Behavior depends on current progress and Spotify semantics. |
| Seek | `PUT /v1/me/player/seek` | Useful for future lyric jump controls. |
| Volume | `PUT /v1/me/player/volume` | Device support may vary. |
| Shuffle | `PUT /v1/me/player/shuffle` | Optional advanced command. |
| Repeat | `PUT /v1/me/player/repeat` | Optional advanced command. |
| Add to queue | `POST /v1/me/player/queue` | Future feature. |
| Save current track | `PUT /v1/me/tracks` | Requires library modify scope. |

There is no standard Spotify Web API “stop” command. The plugin should label the
action as pause.

## Polling and rate limits

Spotify does not provide playback webhooks, so the plugin must poll. The polling
loop should be adaptive:

- Normal playback: poll every 5–10 seconds.
- Lyric mode: poll every 2–3 seconds, or only while a synced lyric line may
  change.
- Paused or no active device: slow down polling.
- Track command just sent: perform one short delayed refresh.
- `429 Too Many Requests`: obey `Retry-After` and use backoff.

The plugin should store backoff state so restart or sleep recovery does not
immediately resume aggressive polling.

## Error handling

The plugin should map API failures to user-friendly pet messages:

| Condition | User-facing behavior |
| --- | --- |
| No Spotify Client ID | Prompt the user to add one in settings. |
| Not authenticated | Offer “Connect Spotify”. |
| Token expired | Refresh through `ctx.auth`; if refresh fails, ask to reconnect. |
| No active device | Ask the user to open Spotify and start playback once. |
| Premium required | Explain that playback controls require Spotify Premium. |
| Rate limited | Quietly back off and avoid repeated bubbles. |
| LRCLIB miss | Continue now-playing behavior without lyrics. |
| Lyrics mismatch | Skip the line instead of showing incorrect lyrics. |

Errors should be logged through `ctx.log` with concise diagnostic details. Logs
should not include tokens, refresh tokens, or full lyric payloads.

## Testing strategy

The official plugin should include deterministic tests through
`@open-pets/plugin-sdk/testing`:

- Startup with no Client ID shows a setup path and does not call Spotify.
- Connect command invokes the OAuth path with PKCE and expected scopes.
- Playback polling emits one now-playing bubble on track change.
- Duplicate polls do not spam the same bubble.
- Play/pause/next/previous commands call the expected Spotify endpoints.
- Like command requests the library endpoint only when the feature is enabled.
- `429` responses schedule backoff and suppress noisy errors.
- LRCLIB synced lyrics map `progress_ms` to the expected bubble line.
- Missing lyrics produce no lyric bubble and do not mark the plugin broken.

These tests should assert descriptors and recorded network effects, not pixels or
real Spotify responses.

## Open questions

- Can OpenPets obtain and maintain an approved Spotify app for public use before
  the plugin is promoted as an official production feature?
- Does the current `ctx.auth` provider shape support every Spotify PKCE field the
  plugin needs, or does the SDK need a small provider-configuration refinement?
- Should LRCLIB lyrics be enabled by default, or should users opt in because the
  data comes from a community source?
- Should the plugin start as catalog-only and become bundled only after setup is
  one-click?
- Do remote album images need additional host rendering/CSP support, or should v1
  avoid album art in bubbles?

## Recommended v1 scope

Ship v1 as a catalog-only official plugin with:

- An OpenPets-owned Spotify app and PKCE OAuth as the default production path.
- A developer-only Client ID override for local testing if needed.
- PKCE OAuth.
- Current playback polling.
- Play/pause, next, previous, and show-current-song commands.
- Now-playing status and track-change bubbles.
- Optional LRCLIB lyric bubbles behind a setting.
- Conservative rate-limit backoff and graceful no-device handling.

This delivers an impressive, safe companion without relying on DRM, private
Spotify APIs, or unresolved lyrics licensing.
