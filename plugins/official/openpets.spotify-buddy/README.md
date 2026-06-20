# OpenPets Spotify Buddy

Your OpenPets pet reacts to whatever you're listening to on Spotify — announcing track changes and matching its mood to the music's energy.

**Version 2.1.0** - Now with easy Device Code activation!

---

## 🚀 Quick Start (5 minutes)

### For Users (Non-Technical):

1. **Install the plugin** in OpenPets

2. **Run command:** "Show Spotify Login URL"
   - You'll see a 6-character code (like `ABC-123`)

3. **Visit:** https://spotify-bridge.onrender.com/activate
   - Enter the code
   - Log in to Spotify

4. **Done!** Your pet will say "Connected" and playback controls work!

### For Developers/Self-Hosting:

See the [Self-Hosting Guide](#self-hosting) below.

---

## ⚠️ **CRITICAL: You MUST Use ngrok**

**OpenPets requires HTTPS and blocks localhost** for security reasons.

Your local bridge runs on `http://localhost:8765`, but **OpenPets plugins cannot access it directly**.

### Quick Start:

1. **Install ngrok:** https://ngrok.com/download

2. **Start your bridge:**
   ```bash
   cd spotify-bridge
   node start.js
   ```

3. **In a new terminal, start ngrok:**
   ```bash
   ngrok http 8765
   ```

4. **Copy the HTTPS URL** from ngrok output (e.g., `https://abc123.ngrok-free.app`)

5. **Configure the plugin in OpenPets:**
   - Open: Tray → Plugins → Spotify Buddy → Configure
   - Set "Bridge URL" to your ngrok URL
   - Click "Save Config"

6. **Update manifest for new ngrok hostnames:**
   - Edit `openpets.plugin.json` → `network.hosts`
   - Add your ngrok hostname (without `https://`)
   - Reload plugin in OpenPets

**Note:** Free ngrok URLs change each restart. Consider a paid plan for stable URLs.

---

## How it works

```
Spotify API
    ↓  OAuth (Authorization Code Flow)
spotify-bridge/server.js   ← Node.js, runs on localhost:8765
    ↓  ngrok tunnel (HTTPS)
    ↓  GET /now-playing  (GET-only, no secrets cross to the plugin)
openpets.spotify-buddy/index.js  ← sandboxed OpenPets plugin
    ↓  pet.speak() / pet.react()
Your desktop pet
```

The bridge handles all OAuth and token refresh. The plugin never sees your access token — it only receives a sanitised JSON payload from your tunnel endpoint.

**Why ngrok?**
- OpenPets requires HTTPS (blocks HTTP)
- OpenPets blocks localhost/private IPs (security)
- ngrok provides a public HTTPS tunnel to your local bridge

---

## Mood → Reaction mapping

| Music vibe | Audio features | Pet reaction |
|---|---|---|
| Hype / party | High energy + positive + fast BPM | `celebrating` (jumping) |
| Intense / heavy | High energy + dark/angry | `running` |
| Happy + light | Positive valence + low energy | `waving` |
| Sad / reflective | Quiet + dark + acoustic | `thinking` (review) |
| Ambient / lo-fi | Quiet + mostly instrumental | `waiting` |
| Neutral / driving | Everything else | `working` |
| Paused | Nothing playing | `idle` (if enabled) |

---

## Setup

### 1. Create a Spotify app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Set **Redirect URI** to: `http://localhost:8765/callback`
4. Copy your **Client ID** and **Client Secret**

### 2. Configure and start the bridge

```bash
cd spotify-bridge
cp .env.example .env
# Edit .env and paste your Client ID + Client Secret
node start.js
```

The bridge starts on `http://localhost:8765`. You still need a public tunnel in front of it for OpenPets to reach `/now-playing`.

### 3. Authorise with Spotify

Open **http://localhost:8765/login** in your browser. You'll be redirected to Spotify, grant permission, then redirected back. The bridge saves tokens to `.tokens.json` and auto-refreshes them — you only do this once.

### 4. Load the plugin in OpenPets

**Option A — Dev load (recommended for local use):**

```bash
# From the openpets repo root:
OPENPETS_DEV_PLUGIN_PATHS=/absolute/path/to/openpets.spotify-buddy pnpm dev:desktop
```

**Option B — Via env variable (persistent):**

Add to your shell profile:
```bash
export OPENPETS_DEV_PLUGIN_PATHS=/absolute/path/to/openpets.spotify-buddy
```

Then launch OpenPets normally. Open **Tray → Plugins**, find "Spotify Buddy", and enable it. Approve the permissions it requests (network, schedule, storage, pet:speak, pet:reaction, status, commands).

If you change your ngrok URL, update both `bridgeUrl` and `network.hosts` in `openpets.plugin.json` to the new hostname before reloading the plugin.

---

## Configuration (in OpenPets Plugins UI)

| Field | Default | Description |
|---|---|---|
| Bridge URL | `https://6b36-103-132-185-215.ngrok-free.app` | Public tunnel URL OpenPets can reach |
| Poll interval | 15s | How often to check Spotify (min 10s) |
| Announce track changes | ✓ | Pet speaks the song + artist on track change |
| React to music mood | ✓ | Pet changes reaction based on audio features |
| React when playback stops | ✗ | Pet reacts idle when music pauses |
| Track announcement message | `Now playing: {title} by {artist}` | Template; use `{title}` and `{artist}` |

---

## Pet commands (right-click the pet)

| Command | What it does |
|---|---|
| **Check Spotify now** | Immediately polls and updates pet state |
| **What's playing?** | Pet speaks the current track aloud |
| **Reset Spotify state** | Clears stored track state; next poll treats everything as new |

---

## Bridge endpoints

| Endpoint | Description |
|---|---|
| `GET /now-playing` | Current Spotify state (used by plugin) |
| `GET /status` | Bridge health + auth state |
| `GET /login` | Start OAuth flow |
| `GET /logout` | Revoke stored tokens |
| `GET /callback` | OAuth redirect (handled automatically) |

---

## Running tests

```bash
cd openpets.spotify-buddy
node test.js
```

---

## Troubleshooting

**⚠️ KNOWN ISSUE: "Bridge Unreachable" After Some Time**

This is an OpenPets platform bug where network permissions randomly get cleared. 

**When it happens:**
- Plugin works fine, then suddenly shows "bridge unreachable"
- Browser can still access the bridge URL
- Only OpenPets can't reach it

**Quick Fix:**
1. OpenPets → Plugins → Spotify Buddy → Configure
2. Click **"Save Config"** (don't change anything)
3. Plugin works again

**Or use the command:**
- Right-click your pet → **"Fix Network Permissions"**
- Follow the instructions

**Root Cause:** OpenPets loses `approvedNetworkHosts` from plugin state. The fix exists but hasn't been released yet. Clicking "Save Config" re-approves the hosts.

---

**Pet says "I cannot reach the Spotify bridge" or shows "bridge unreachable"**

Check these in order:

1. **Is ngrok running?**
   ```bash
   # You should see a web interface at http://localhost:4040
   curl http://localhost:4040
   ```
   If not running: `ngrok http 8765`

2. **Is your bridge running?**
   ```bash
   cd spotify-bridge
   node start.js
   # Should show: "Spotify bridge running on http://127.0.0.1:8765"
   ```

3. **Is the ngrok URL correct in plugin config?**
   - Open: OpenPets → Plugins → Spotify Buddy → Configure
   - Bridge URL should match your current ngrok URL (starts with `https://`)
   - Click "Save Config" to re-approve network permissions

4. **Is the ngrok hostname in manifest?**
   - Check `openpets.plugin.json` → `network.hosts`
   - Should include your current ngrok hostname (without `https://`)
   - Example: `["abc123-def456.ngrok-free.app", ...]`
   - Reload plugin after changes

5. **Test ngrok URL manually:**
   ```bash
   curl https://your-ngrok-url.ngrok-free.app/now-playing
   # Should return JSON with Spotify data
   ```

6. **Check OpenPets logs** for specific errors:
   - "requires HTTPS" → You're using `http://` instead of `https://`
   - "not approved" → Ngrok host not in approved network list
   - "not public" → Trying to use localhost (won't work in OpenPets)

**Free ngrok URL keeps changing**
→ Each time you restart ngrok, you get a new URL. You must:
1. Update plugin config with the new URL
2. Update manifest `network.hosts` with the new hostname
3. Click "Save Config" and reload the plugin

Consider ngrok's paid plans for stable URLs.

**"Plugin manifest is unavailable" error**
→ This is an OpenPets platform issue. Try:
1. Disable and re-enable the plugin
2. Restart OpenPets
3. Reinstall the plugin

**Bridge says "Not authorised"**
→ Visit `http://localhost:8765/login` in your browser.

**Token expired after an hour**
→ This shouldn't happen — the bridge auto-refreshes 30 seconds before expiry. If it does, visit `/login` again.

**Plugin shows "bridge unreachable" status but bridge is running**
→ Check that the tunnel hostname in your plugin config matches `network.hosts` in `openpets.plugin.json` exactly. OpenPets only allows exact public hosts through the plugin SDK.

**No mood reactions / always "working"**
→ The Spotify Audio Features API requires Spotify Premium or may be unavailable for some tracks. The plugin falls back to `working` gracefully when features are missing.

---

## Security notes

- The bridge binds to `127.0.0.1` only — it is never reachable from the network without a tunnel.
- `.tokens.json` stores your Spotify refresh token locally. Do not commit it to version control (it is gitignored by default if you copy `.gitignore`).
- The plugin sandbox only ever receives sanitised track metadata — no credentials, no tokens.
