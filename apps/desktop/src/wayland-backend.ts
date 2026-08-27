/**
 * Pure, dependency-free Wayland/Ozone backend decision logic.
 *
 * This logic is extracted out of `pet-window.ts` (which imports Electron and so
 * cannot be loaded by the plain-Node `node:test` runner) so the exact production
 * predicate can be unit-tested directly instead of through a hand-rolled copy.
 * `pet-window.ts` reads the live runtime values and delegates here, guaranteeing
 * the tests and production never drift.
 */

/**
 * Whether OpenPets is effectively running on a native Wayland backend, where
 * programmatic window positioning and z-ordering are unsupported.
 *
 * `ozoneSwitch` is the value of `app.commandLine.getSwitchValue("ozone-platform")`:
 *   - "wayland"     → native Wayland (true)
 *   - "x11"         → x11/XWayland (false)
 *   - "" / "auto"   → undecided; fall back to the session env vars
 *                     (XDG_SESSION_TYPE / WAYLAND_DISPLAY)
 */
export function computeEffectiveWaylandBackend(
  platform: NodeJS.Platform | string,
  ozoneSwitch: string,
  xdgSessionType: string | undefined,
  waylandDisplay: string | undefined,
): boolean {
  if (platform !== "linux") return false;
  if (ozoneSwitch === "wayland") return true;
  if (ozoneSwitch === "x11") return false;
  // ozone is "" or "auto" — fall back to session-type env vars.
  return xdgSessionType === "wayland" || Boolean(waylandDisplay);
}

/**
 * Whether the transparent pet overlay should be allowed to receive input focus.
 *
 * Linux compositors, especially native Wayland compositors such as Niri, can
 * treat the pet as a normal focusable toplevel unless Electron opts it out.
 * Keep passive overlays non-focusable on Linux, but allow focus when a plugin
 * bubble hosts an inline input/select that needs keyboard input. Preserve the
 * existing focusable behavior on macOS and Windows.
 */
export function shouldPetWindowBeFocusable(
  platform: NodeJS.Platform | string,
  _effectiveWaylandBackend: boolean,
  hasInteractiveInput = false,
): boolean {
  if (hasInteractiveInput) return true;
  return platform !== "linux";
}

/**
 * Whether the experimental native Wayland `wlr-layer-shell` backend is
 * requested.
 *
 * This is an opt-in, Linux-only experimental backend: the pet is carried by a
 * real layer-shell overlay surface (via a small native helper process) instead
 * of an XDG toplevel, so it is not a normal application window, does not take
 * keyboard focus, and is not subject to window close/kill shortcuts or tiling
 * layout. It is enabled with `OPENPETS_NATIVE_WAYLAND=1`; it is never the
 * default.
 */
export function isLayerShellBackendRequested(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined> = {},
): boolean {
  if (platform !== "linux") return false;
  return env.OPENPETS_NATIVE_WAYLAND === "1";
}
