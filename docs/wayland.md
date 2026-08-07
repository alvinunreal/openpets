# Linux Wayland drag notes

OpenPets supports pet dragging on Linux Wayland by using Electron/Chromium's
native draggable region path for the visible pet sprite. This lets the compositor
move the window with `xdg_toplevel.move` instead of relying on manual
`BrowserWindow.setBounds()` calls from renderer mouse coordinates.

## Why manual dragging is not reliable

The normal OpenPets drag path tracks renderer `screenX/screenY` and applies
window bounds in the main process. That works on platforms where Electron can
read and set stable global window coordinates. On KDE Plasma Wayland, the pet
receives mouse events, but compositor-managed global positioning makes the manual
`setBounds()` loop unreliable.

Source inspection confirmed the expected Wayland path:

- Electron `v42.0.0` maps draggable regions to Chromium non-client hit testing.
- Chromium's Wayland toplevel window sends compositor-managed movement requests.
- KWin accepts move requests via `XdgToplevelInterface::moveRequested` and starts
  interactive move/resize from a valid pointer serial.

## Accepted Wayland trade-offs

Using native draggable regions fixes the important failure: the pet can be moved
on KDE Wayland. It has two accepted limitations:

- The pet sprite does not receive normal drag mouse events while the compositor
  owns the move, so drag-time sprite animation is not available.
- Right-click on the draggable sprite region is handled as non-client/system
  input by Electron/KWin. We tried intercepting Electron's Linux
  `system-context-menu` event and showing the OpenPets menu, but the menu did not
  appear reliably in the KDE Wayland VM. Treat right-click on the sprite as a
  known Wayland limitation.

Speech bubbles and other non-drag UI remain regular client content. Emoji/status
glyph rendering is handled by the bundled `NotoColorEmoji.ttf`, so fresh Linux
installs do not depend on system emoji fonts.

Passive pet windows are created as non-focusable on Linux and are shown inactive,
so the transparent overlay should not take keyboard focus when it appears or
re-assert focus during the session. Pet windows temporarily opt back into
focusability when the rendered plugin bubble includes an inline input/select,
because those controls need keyboard focus after the user clicks them. This
addresses the focus-stealing class of issues on Wayland compositors such as Niri,
without breaking plugin bubbles that need typed input, but it does not change the
accepted native Wayland limitations around cross-workspace stickiness or
compositor-controlled window placement.

## Reproduction and validation notes

The KDE Wayland repro VM lives at:

```text
/Volumes/external/vmware/ubuntu24-kde-wayland
```

Validated behavior in KDE Plasma Wayland:

- Default/manual `setBounds()` drag path: pet appears, but dragging is unreliable.
- Forced X11/XWayland inside a Plasma Wayland session: Electron starts, but the
  pet was not a usable workaround in the VM.
- Native draggable sprite region on real Wayland: pet dragging works; drag-time
  sprite animation and right-click menu on the sprite do not.

Do not document a stronger Wayland workaround unless it has been verified in the
VM. For deeper source inspection, the relevant local read-only clones are listed
in `AGENTS.md` under "Cloned Dependency Source".

## Plugin OAuth on KDE/Wayland

Two separate issues block plugin OAuth (`ctx.auth.oauth`, e.g. Calendar Airmail)
on KDE Plasma/Wayland sessions, independent of the pet-dragging behavior above.
Verified on real hardware: CachyOS Linux, KDE Plasma 6.7.4, KWin 6.7.4, Wayland
session, `--ozone-platform=x11` forced (see "Accepted Wayland trade-offs" above
for why x11/XWayland is forced at all).

### Browser launch: `shell.openExternal()` can silently no-op

`plugin-oauth.ts` used to call Electron's `shell.openExternal(authUrl)` to open
the system browser for the PKCE authorization step. On this configuration it
resolves without throwing, but no browser process or window is ever launched —
confirmed by monitoring running processes and the window list for 25s
bracketing the call: no new browser process, no new `xdg-open` process, no new
window. A plain `xdg-open <url>` from a terminal in the same session works
instantly.

Fix: call `xdg-open` directly on Linux (falling back to `shell.openExternal` if
it fails), which isn't subject to whatever internal ozone-platform/session
mismatch makes `shell.openExternal()` a no-op here.

A second, narrower issue sits underneath that: Electron force-sets
`GDK_BACKEND=x11` in its own process environment when the ozone platform is
forced to x11, for its own GTK dialogs/theming. Spawning `xdg-open` (or a
browser directly) with that inherited means the spawned browser can end up in
a broken half-Wayland/half-X11 state — observed concretely as Firefox refusing
to open at all with `Failed to open Wayland display, fallback to X11 ...
Wayland only build is missing Wayland display`, even though the identical
command works fine from a plain terminal where `GDK_BACKEND` isn't set. Strip
`GDK_BACKEND` from the environment passed to the spawned browser process.

### Secret storage: `gnome-libsecret` doesn't satisfy Electron on KDE

`password-store` was hardcoded to `gnome-libsecret` on Linux. On KDE this makes
`safeStorage.isEncryptionAvailable()` return `false`, so a successfully-obtained
OAuth token can't be persisted, failing with `"Secret storage encryption is
unavailable on this system."`

This isn't a broken keyring: `org.freedesktop.secrets` is registered and
running (KDE's `ksecretd`, via `secretservicecompat`), and a manual
`secret-tool store`/`secret-tool lookup` round-trip (the same libsecret
mechanism Electron's OSCrypt backend uses) succeeds cleanly. `gnome-libsecret`
is Electron's OSCrypt backend written against real GNOME Keyring; KWallet's
secret-service-compat layer implements the same D-Bus API surface but doesn't
satisfy Electron's stricter `gnome-libsecret` compatibility check.

Fix: select the `kwallet6` backend when `XDG_CURRENT_DESKTOP` indicates a KDE
session, keeping `gnome-libsecret` elsewhere on Linux.
