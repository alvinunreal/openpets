---
description: Experimental native Wayland wlr-layer-shell backend for OpenPets on Linux — the pet becomes a true overlay surface instead of a normal application window.
---

# Experimental: native Wayland layer-shell backend

> **Status: experimental prototype (P0).** Opt-in only. Not the default.

On Linux/Wayland, OpenPets normally carries the pet in an Electron window
(XWayland by default, or a native Wayland `xdg_toplevel` if you force it). Under
compositors like [Niri] that treat toplevel windows as tiling/application
windows, this makes the pet a normal window: it can steal focus, get closed by
window shortcuts, occupy a tile, and be constrained to one workspace.

This prototype adds an **optional native Wayland `wlr-layer-shell` backend**: the
pet is rendered on a real **overlay** layer-shell surface, so it is not a normal
application window at all. It stays out of `niri msg windows`, never takes
keyboard focus, and is composited above normal windows.

[Niri]: https://github.com/YaLTeR/niri

## How it works

Electron/Chromium's Ozone does not implement `wlr-layer-shell`, so a layer-shell
surface cannot be created from inside Electron. Instead a small native helper
process owns the surface, and the existing renderer keeps producing the pet:

```text
OpenPets Electron main process (pet runtime / animation unchanged)
        │  hidden offscreen BrowserWindow renders the same pet HTML page
        │  offscreen frame stream → BGRA frames
        │  Unix socket (XDG_RUNTIME_DIR)
        ▼
openpets-wayland-helper   (Rust, smithay-client-toolkit)
        │  creates a wlr-layer-shell surface (layer = overlay)
        │  transparent, keyboard interactivity = none, positioned via margins
        ▼
Compositor (Niri / Hyprland / Sway / …)
```

The pet controllers, animation renderer, bubble system, plugins and pet formats
are **unchanged** — only the window carrier is swapped. The `BrowserWindow`'s
display-facing methods (`show`/`hide`/`setPosition`/`getPosition`/…) are patched
on the instance so existing controllers keep working, while the visible surface
is the helper's layer-shell overlay.

## Enable

```bash
OPENPETS_NATIVE_WAYLAND=1 openpets
```

The backend only activates when all of these hold:

- Linux (`process.platform === "linux"`)
- `OPENPETS_NATIVE_WAYLAND=1` is set
- the native helper binary is available

Otherwise OpenPets falls back to the existing window path unchanged. If the
helper cannot start or becomes unhealthy at runtime (helper exits before
`READY`, cannot bind `wlr-layer-shell`, or does not report `READY` within 10
seconds), OpenPets retries a bounded number of times, then rebuilds the pet as
a normal `BrowserWindow` at its current tracked position/visibility. Each
controller adopts the replacement so later state updates keep routing to the
visible window instead of the old offscreen pet.

## Build the helper

The helper is a Rust binary in the repo:

```bash
cd apps/desktop/native/openpets-wayland-helper
cargo build --release
```

The binary is expected at
`apps/desktop/native/openpets-wayland-helper/target/release/openpets-wayland-helper`
(or override with `OPENPETS_WAYLAND_HELPER=/path/to/binary`).

## Verify on Niri

1. Launch with the backend enabled.
2. The pet appears as an overlay (not a normal window):

   ```bash
   niri msg layers          # look for the "openpets-pet" surface in the Overlay layer
   niri msg windows         # the pet must NOT appear here
   ```

3. The pet animates, is transparent, and your editor/terminal keeps focus
   (run `niri msg focused-window` before and after; it should not change).
4. Focus a normal window and press your `close-window` shortcut — the pet
   should not be affected.

## What works (P0)

- One pet (the default pet) rendered on an `overlay` layer-shell surface.
- Transparency and alpha preserved (offscreen frame stream).
- Pet animation plays (frames are streamed continuously).
- Not a normal window; no keyboard focus; not affected by window shortcuts.
- Respects the pet's saved position (positioned with layer-shell margins).
- Automatic fallback to the normal window path when unavailable.

## What does not work yet (P1/P2)

- **Dragging the pet** with the mouse (the helper has no pointer input path yet;
  the layer-shell surface has an input region but no drag handling).
- Right-click context menu on the sprite.
- Multiple pets / agent pets (only the default pet path is exercised so far,
  though the mechanism is generic).
- Multi-monitor placement beyond the primary output.
- Hyprland / Sway validation (should work — they implement `wlr-layer-shell` —
  but only Niri has been verified).
- Settings UI / auto backend detection / packaging the helper binary into the
  released app.
- Frame streaming prefers the event-driven `beginFrameSubscription` and falls
  back to `capturePage` polling; frame polling pauses while the pet is being
  dragged so pointer-motion stays responsive.
- In layer-shell mode Electron runs on the native Wayland ozone backend, so
  ordinary windows (Control Center, plugin panels) are native Wayland windows
  that compositors display normally — only the pet itself is a layer-shell
  overlay surface.

## Known limitations

- The pet is placed using the primary output's geometry; multi-monitor handling
  is not implemented yet.
- Because the offscreen renderer is invisible, sprite drag animation and the
  native draggable-region path do not apply in this mode.
- This is a prototype: no packaging, no UI toggle, and behavior is opt-in via
  the environment variable above.

## License

The helper is MIT licensed (matches the OpenPets repository). It uses
[`smithay-client-toolkit`] (MIT) and the Wayland protocol bindings. No code was
copied from other desktop-pet projects; the layer-shell protocol usage follows
the public `wlr-layer-shell` specification.

[`smithay-client-toolkit`]: https://github.com/Smithay/client-toolkit
