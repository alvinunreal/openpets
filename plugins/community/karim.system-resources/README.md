# OpenPets System Resources

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="assets/preview-hud.png" alt="Live resource HUD on the satellite pet" width="340" />
  <img src="assets/preview-pet.png" alt="Virtual Pet food, energy, play and bond stay on the main pet" width="340" />
</p>

Live **CPU and RAM** to the left of your pet. Virtual Pet stats (food, energy, play, bond) stay on the pet.

Catalog installs are CPU/RAM-only. The sandbox cannot run `npm run install-sidecar`, and the catalog ZIP does not include `package.json`, `scripts/`, or `sidecar/`. GPU and SSD appear only if a local sidecar is already listening on `127.0.0.1:37647`.

## Catalog package

```bash
npm test
npm run package:catalog
```

Writes `dist/openpets.system-resources-1.4.0.zip` plus a `.sha256` file. The ZIP contains only the manifest, `index.js`, declared icons, locales, and `LICENSE`.

## Unpacked / developer sidecar (optional GPU and SSD)

Needs [Node.js](https://nodejs.org/) on PATH. From a clone of this repo:

```bash
npm run install-sidecar
```

The script picks the OS:

| OS | What gets installed | After reboot / login |
|---|---|---|
| macOS | LaunchAgent `nl.axtro.openpets-metrics` | `RunAtLoad` + `KeepAlive` |
| Linux | systemd user `openpets-metrics.service` | `enable --now` + linger when possible |
| Windows | Scheduled Task `OpenPetsMetricsSidecar` | trigger `AtLogOn` |

Check: `curl -s http://127.0.0.1:37647/health` → `{"ok":true}` (Windows: `Invoke-RestMethod http://127.0.0.1:37647/health`).

Foreground without a persistent service: `npm run sidecar`.

Load unpacked: OpenPets → Plugins → Developer Mode → **Load unpacked plugin folder**. Approve `system:metrics`, `network:local`, `pets:manage`, and `pet:move`.

Manual per OS: `npm run install-sidecar:mac` / `:linux` / `:windows`.

## Config

- **Language**: automatic / Nederlands / English / Français / Deutsch
- HUD on/off, poll 5–60s, alert threshold, speak on high load

## Commands

- Show / hide resource HUD
- Read resources (or click the pet)

## Development

```bash
npm test
```

```mermaid
flowchart LR
  subgraph OpenPets
    P[Default pet<br/>Virtual Pet HUD]
    S[Satellite pet<br/>CPU RAM]
  end
  M["ctx.system.metrics"] --> S
  C["optional sidecar 127.0.0.1:37647"] -.-> S
  P --- S
```

The resource HUD pins on an ephemeral satellite pet (`SATELLITE_OFFSET_X = -180`), never on the default pet pin slot.

## License

[MIT](LICENSE) — use, copy, modify, sell: all fine. Keep the copyright notice.
