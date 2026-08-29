# Changelog

## 1.4.0

- Catalog package is CPU/RAM-only: HUD, copy, and Configure no longer advertise an uninstallable GPU/SSD sidecar.
- GPU and SSD still appear when a sidecar is already running on loopback; OS is taken from the host, not from a config field.
- `npm run package:catalog` writes a catalog ZIP with only the manifest, entry, declared assets, locales, and license.

## 1.3.6

- README preview uses real OpenPets screenshots of the satellite HUD and the main pet.

## 1.3.5

- GitHub-facing docs are English: README, changelog, package description, and installer messages.
- Added a development preview of the satellite HUD next to the pet.

## 1.3.4

- MIT license: free to use, modify, and redistribute.

## 1.3.3

- Configure shows a GPU/SSD hint at the top: one-time `npm run install-sidecar` (copyable field), with per-OS notes and that it starts again at login.

## 1.3.2

- First install: `npm run install-sidecar` detects macOS, Linux, or Windows and sets up the persistent sidecar (LaunchAgent / systemd --user / Scheduled Task).
- Linux restarts after login via `Restart=always` and tries `loginctl enable-linger`. Windows task starts at `AtLogOn`.

## 1.3.1

- GPU and SSD were missing because the metrics sidecar was not running. LaunchAgent install sets PATH for `ioreg`/`df`, 4s cache, plugin fetch 2.5s.
- macOS GPU also reads `Renderer Utilization %` when `Device Utilization %` is absent.
- Status line reports `sidecar offline` when GPU/SSD do not arrive.

## 1.3.0

- Resource HUD no longer takes the Virtual Pet pin slot. Meters live on a satellite pet to the left of the main pet (own pin slot).
- Food, energy, play, and bond stay on the pet; CPU/RAM/GPU/SSD follow when you drag.
- Extra permissions: `pets:read`, `pets:manage`, `pet:move`, `pet:animate`. After update, re-approve in Control Center and Refresh.

## 1.2.2

- Plugin is a single entry file again: no relative ESM imports, because the sandbox cannot resolve `./i18n.js`.

## 1.2.1

- Catalog icon changed to `plugin`; `activity` is not an allowed host icon.

## 1.2.0

- Sidecar works on macOS, Windows, and Linux with per-OS GPU and SSD sources.
- Plugin config has an OS choice (automatic / macOS / Windows / Linux) sent to the sidecar as `platform`.
- Windows: `nvidia-smi` or GPU Engine counters, disk via WMIC/CIM. Linux: `nvidia-smi` or sysfs `gpu_busy_percent`, `df` for `/`.
- Install scripts for systemd (Linux) and Scheduled Task (Windows).

## 1.1.0

- French and German translations (`locales/fr.json`, `locales/de.json`).
- Language is selectable in plugin config: automatic, Nederlands, English, Français, Deutsch.
- HUD, status line, and pet speech follow the chosen language, not only the OpenPets host locale.

## 1.0.0

- First OpenPets plugin with a pinned HUD for CPU, RAM, GPU, and SSD.
- CPU and RAM from `ctx.system.metrics`; GPU and SSD via a local sidecar on port 37647.
- Commands to show, hide, or read the meters.
- High-load warning, assistant capability `resources.get`, and LaunchAgent install for the sidecar.
