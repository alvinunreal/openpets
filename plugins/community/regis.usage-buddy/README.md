# Usage Buddy

An OpenPets community plugin whose pet reflects your live **Claude** and **Codex**
usage. It reads the current utilization from a local companion app and reacts:
greeting you with a full read-out, warning you when a quota gets tight, and
animating by how close you are to the limit.

Plugin id: `regis.usage-buddy`.

## How it works

Usage Buddy does not talk to any cloud API. It polls a **loopback HTTP endpoint**
served by the companion desktop app
[usage-monitor-for-claude-and-codex](https://github.com/regisbsb/usage-monitor-for-claude-and-codex),
which already computes the utilization for every quota window:

```text
GET http://127.0.0.1:45455/usage  ->  { providers: { claude: { windows: { five_hour: { utilization, resets_at }, ... } }, codex: {...} } }
```

The pet:

- **Greets** on enable with an all-windows summary, e.g. `Claude 5h: 12% 7d: 1% Codex 7d: 3%`.
- **Alerts** — in its own playful voice — when usage is already high at enable
  (≥ 75%) and on every upward threshold crossing, animating by level
  (e.g. `Claude, ai ai ai — running low mate! (91% 5h)`).
- Tracks **both providers**; the mood follows whichever window is closest to its limit.
- Shows the current summary in the Plugins-window **status line** every poll.

Because the OpenPets host caps recurring `schedule.every` timers at a 10-minute
minimum, Usage Buddy runs its own faster loop with `schedule.once`
(default 60s, minimum 15s).

### Right-click commands

- **Usage Now** — a full read-out of every usage window.
- **Usage Alert** — the current threshold reading in the pet's voice.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `pollSeconds` | `60` | How often to read the endpoint. Minimum 15. |
| `port` | `45455` | Must match the companion app. **If you change it, also update `network.hosts` in `openpets.plugin.json` to `127.0.0.1:<port>`** or OpenPets blocks the request. |
| `providerFilter` | `both` | `both`, `claude`, or `codex`. |
| `thresholds` | `50,75,90,100` | Comma-separated band boundaries (%). |
| `quietStatus` | `false` | Only update the status line on warning/error tones. |
| `hiddenWindows` | `nimbus_quill` | Comma-separated window names to ignore entirely (not shown, never drives mood). Clear to show all. |

## Permissions

- `pet:speak`, `pet:reaction` — speech bubbles and reactions.
- `commands` — the two right-click commands.
- `status` — the Plugins-window status line.
- `schedule` — the polling loop.
- `network`, `network:local` — fetch the declared loopback endpoint. The exact
  host is declared under `network.hosts` (`127.0.0.1:45455`).
- `storage` — remember each window's alert band so it only warns on upward crossings.

## Files

```text
openpets.plugin.json  # Manifest: id, version, permissions, network host, settings, assets
index.js              # Plugin entry: polling loop, summary/alerts, commands
locales/en.json       # Display strings, settings labels, pet alert lines
assets/icon.svg       # Bundled catalog icon
test.js               # SDK test-harness suite
package.json          # Local test dependencies
```

## Test the plugin files

Install dependencies once:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Validate the plugin package with the OpenPets CLI:

```bash
npx -y @open-pets/cli plugin validate .
```

> **Note:** the currently published CLI (`@open-pets/cli` 3.0.0) predates the
> `network:local` permission and will flag it as invalid. The OpenPets desktop
> app **requires** `network:local` to reach the loopback host, so keep it — the
> CLI warning is a version-skew false positive.

## Run inside the OpenPets desktop app

1. Start the companion app so the endpoint is live on `127.0.0.1:45455`.
2. In OpenPets: **Tray → Plugins → Developer Mode → Load Folder**, and select
   this `openpets-plugin-usage-buddy` folder.
3. Approve the requested permissions and enable the plugin.
4. Right-click the pet for **Usage Now** or **Usage Alert**.

After editing, click **Refresh from Folder** on the local plugin card to re-read
the source. Per-tick diagnostics are written to the desktop app log
(`openpets.log`, plugin scope) as `usage-buddy greeting`/`tick`/`offline` lines.

## Submit to the OpenPets catalog

Push to a public GitHub repo and tag a release (this repo publishes `v1.0.0`),
then submit with the OpenPets issue template:
<https://github.com/alvinunreal/openpets/issues/new?template=plugin_submission.yml>

```text
Plugin name: Usage Buddy
Plugin id: regis.usage-buddy
GitHub repo URL: https://github.com/regisbsb/openpets-plugin-usage-buddy
Plugin subdirectory: .
Release tag or commit SHA: v1.0.0

Requested permissions:
- pet:speak / pet:reaction: show usage bubbles and animate by level
- commands: the "Usage Now" and "Usage Alert" right-click actions
- status: show the current usage summary in the Plugins window
- schedule: run the polling loop
- network + network:local: fetch the local usage endpoint
- storage: remember alert bands to avoid repeat warnings

Network hosts:
- 127.0.0.1:45455: the companion usage-monitor's loopback /usage endpoint

External account setup:
- None. Requires the companion app usage-monitor-for-claude-and-codex running locally.
```
