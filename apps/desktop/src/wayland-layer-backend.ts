/**
 * Experimental native Wayland `wlr-layer-shell` backend (Linux only).
 *
 * Electron/Chromium's Ozone does not implement `wlr-layer-shell`, so a real
 * layer-shell overlay surface cannot be created from inside Electron. Instead a
 * small native helper process (`openpets-wayland-helper`, a Rust binary built
 * from `apps/desktop/native/openpets-wayland-helper`) owns the layer-shell
 * surface and this module streams rendered frames to it.
 *
 * The pet itself is still rendered by the normal OpenPets renderer: a hidden
 * offscreen `BrowserWindow` keeps running the exact same HTML/CSS pet page,
 * and every composited frame is forwarded to the helper over a Unix socket.
 * The `BrowserWindow`'s display-facing methods (`show`/`hide`/`setPosition`/
 * `getPosition`/...) are patched on the instance so the existing pet
 * controllers keep working unchanged while the visible carrier is a
 * layer-shell overlay instead of an XDG toplevel.
 *
 * This backend is opt-in (`OPENPETS_NATIVE_WAYLAND=1`); when it cannot start
 * the caller falls back to the normal window path.
 */

import { app, BrowserWindow, type NativeImage } from "electron";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { debug, error as logError, info } from "./logger.js";
import type { Point } from "./display.js";

// --- Wire protocol tags (must match apps/desktop/native/openpets-wayland-helper/src/protocol.rs) ---

const TAG_FRAME = 0x01;
const TAG_MOVE = 0x02;
const TAG_SHOW = 0x03;
const TAG_HIDE = 0x04;
const TAG_QUIT = 0x05;
const TAG_READY = 0x81;
const TAG_POINTER = 0x82;
const TAG_POSITION = 0x83;

const PT_MOVE = 0;
const PT_PRESS = 1;
const PT_RELEASE = 2;
const PT_ENTER = 3;
const PT_LEAVE = 4;

const MAX_QUEUED_MESSAGES = 512;
const MAX_CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 50;
/** Poll interval for `capturePage` frame streaming (~30 fps). */
const FRAME_POLL_MS = 33;
/** How long to wait for `beginFrameSubscription` before falling back to polling. */
const FRAME_PROBE_MS = 1200;

/**
 * Resolve the native helper binary path.
 *
 * Priority: `OPENPETS_WAYLAND_HELPER` env override → dev build path → packaged
 * resources path. Returns `null` when no usable binary exists (caller falls
 * back to the normal window path).
 */
export function resolveHelperBinaryPath(): string | null {
  const envPath = process.env.OPENPETS_WAYLAND_HELPER;
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }
  const candidates = [
    // Dev: the crate's release binary inside the repo.
    join(app.getAppPath(), "native", "openpets-wayland-helper", "target", "release", "openpets-wayland-helper"),
    // Packaged: shipped as an extra resource next to the app bundle.
    join(process.resourcesPath ?? "", "openpets-wayland-helper"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Synchronous availability check used before creating an offscreen window. */
export function isLayerShellHelperAvailable(): boolean {
  return resolveHelperBinaryPath() !== null;
}

// --- Wire encoding (little-endian, length-prefixed) ---

function encodeMessage(tag: number, payload: Buffer): Buffer {
  const body = Buffer.allocUnsafe(1 + payload.length);
  body[0] = tag;
  payload.copy(body, 1);
  const msg = Buffer.allocUnsafe(4 + body.length);
  msg.writeUInt32LE(body.length, 0);
  body.copy(msg, 4);
  return msg;
}

function encodeFrame(offsetX: number, offsetY: number, width: number, height: number, stride: number, data: Buffer): Buffer {
  const payload = Buffer.allocUnsafe(20 + data.length);
  payload.writeInt32LE(offsetX, 0);
  payload.writeInt32LE(offsetY, 4);
  payload.writeUInt32LE(width, 8);
  payload.writeUInt32LE(height, 12);
  payload.writeUInt32LE(stride, 16);
  data.copy(payload, 20);
  return encodeMessage(TAG_FRAME, payload);
}

interface CroppedFrame {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly bitmap: Buffer;
}

/** Remove fully transparent canvas margins while preserving logical offsets. */
function cropTransparentFrame(image: NativeImage): CroppedFrame | null {
  const bitmap = image.toBitmap();
  const size = image.getSize();
  if (!bitmap.length || size.width <= 0 || size.height <= 0) return null;
  const sourceStride = bitmap.length / size.height;
  if (!Number.isInteger(sourceStride) || sourceStride < size.width * 4) return null;

  let left = size.width;
  let top = size.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < size.height; y += 1) {
    const row = y * sourceStride;
    for (let x = 0; x < size.width; x += 1) {
      if (bitmap[row + x * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;

  const padding = 4;
  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(size.width - 1, right + padding);
  bottom = Math.min(size.height - 1, bottom + padding);
  const width = right - left + 1;
  const height = bottom - top + 1;
  const stride = width * 4;
  const cropped = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    bitmap.copy(cropped, y * stride, (top + y) * sourceStride + left * 4, (top + y) * sourceStride + (right + 1) * 4);
  }
  return { offsetX: left, offsetY: top, width, height, stride, bitmap: cropped };
}

function encodeMove(x: number, y: number): Buffer {
  const payload = Buffer.allocUnsafe(8);
  payload.writeInt32LE(x, 0);
  payload.writeInt32LE(y, 4);
  return encodeMessage(TAG_MOVE, payload);
}

// --- Surface controller ---

/**
 * Owns one helper process + socket and the frame pipeline for one pet surface.
 */
class LayerShellSurface {
  readonly width: number;
  readonly height: number;
  private frameOffset = { x: 0, y: 0 };

  private readonly socketPath: string;
  private readonly helperPath: string;
  private helper: ReturnType<typeof import("node:child_process").spawn> | null = null;
  private socket: net.Socket | null = null;
  private connected = false;
  private ready = false;
  private destroyed = false;
  private position: Point;
  private visible = true;
  /** Commands queued while the socket is still connecting. */
  private pending: Buffer[] = [];
  private socketBuffer = Buffer.alloc(0);
  private window: BrowserWindow | null = null;

  constructor(options: { helperPath: string; socketPath: string; width: number; height: number; position: Point }) {
    this.helperPath = options.helperPath;
    this.socketPath = options.socketPath;
    this.width = options.width;
    this.height = options.height;
    this.position = { x: options.position.x, y: options.position.y };
  }

  /** Spawn the helper and open the socket. Must be called once. */
  start(): void {
    const child = spawnHelper(this.helperPath, this.socketPath, this.width, this.height, this.position);
    if (!child) {
      throw new Error(`failed to spawn ${this.helperPath}`);
    }
    this.helper = child;
    child.on("exit", () => this.restart());

    // The helper binds its socket shortly after launch; retry the connect so
    // we never lose the race against a fresh process.
    this.connectWithRetry(0);
  }

  /**
   * The helper process exited (crash, lock screen, session teardown) — spawn
   * a fresh one and re-establish the surface so the pet does not vanish until
   * the whole app is restarted.
   */
  private restart(): void {
    if (this.destroyed) return;
    info("pet.wayland", "helper exited; restarting layer-shell surface", { socketPath: this.socketPath });
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // already closed
      }
      this.socket = null;
    }
    this.connected = false;
    this.ready = false;
    this.pending = [];
    this.socketBuffer = Buffer.alloc(0);
    // A killed helper can leave a stale socket file behind; the new helper's
    // `bind` would fail on it, so remove it first.
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
    const child = spawnHelper(this.helperPath, this.socketPath, this.width, this.height, this.position);
    if (!child) {
      logError("pet.wayland", "helper restart failed", { socketPath: this.socketPath });
      return;
    }
    this.helper = child;
    child.on("exit", () => this.restart());
    this.connectWithRetry(0);
    if (!this.visible) this.write(encodeMessage(TAG_HIDE, Buffer.alloc(0)));
  }

  private connectWithRetry(attempt: number): void {
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("connect", () => {
      this.connected = true;
      debug("pet.wayland", "helper socket connected", { socketPath: this.socketPath, attempt });
      this.flushPending();
    });
    socket.on("data", (chunk: Buffer) => this.handleIncoming(chunk));
    socket.on("error", (error) => {
      const refused = (error as NodeJS.ErrnoException).code === "ECONNREFUSED" || (error as NodeJS.ErrnoException).code === "ENOENT";
      if (refused && attempt < MAX_CONNECT_ATTEMPTS) {
        // Not bound yet — tear down and try again shortly.
        socket.destroy();
        this.socket = null;
        setTimeout(() => this.connectWithRetry(attempt + 1), CONNECT_RETRY_MS);
        return;
      }
      logError("pet.wayland", "helper socket error", { socketPath: this.socketPath, error: error.message, attempt });
      socket.destroy();
      this.socket = null;
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.connected = false;
        debug("pet.wayland", "helper socket closed", { socketPath: this.socketPath });
      }
    });
  }

  private write(msg: Buffer): void {
    if (this.destroyed) return;
    if (!this.connected) {
      if (this.pending.length < MAX_QUEUED_MESSAGES) this.pending.push(msg);
      return;
    }
    this.socket?.write(msg);
  }

  private flushPending(): void {
    if (!this.connected) return;
    for (const msg of this.pending) this.socket?.write(msg);
    this.pending = [];
  }

  private handleIncoming(chunk: Buffer): void {
    this.socketBuffer = Buffer.concat([this.socketBuffer, chunk]);
    while (this.socketBuffer.length >= 4) {
      const len = this.socketBuffer.readUInt32LE(0);
      if (this.socketBuffer.length < 4 + len) break;
      const body = this.socketBuffer.subarray(4, 4 + len);
      this.socketBuffer = this.socketBuffer.subarray(4 + len);
      if (body.length === 0) continue;
      const tag = body[0];
      if (tag === TAG_READY && !this.ready) {
        this.ready = true;
        info("pet.wayland", "helper surface ready (layer-shell configured)");
        this.attachFrameStreaming();
      } else if (tag === TAG_POINTER && body.length >= 13) {
        this.handlePointer(body[1], body.readInt32LE(2), body.readInt32LE(6), body.readUInt32LE(10));
      } else if (tag === TAG_POSITION && body.length >= 9) {
        this.handlePositionUpdate(body.readInt32LE(1), body.readInt32LE(5));
      } else if (tag === TAG_POINTER) {
        debug("pet.wayland", "short pointer message", { bodyLen: body.length });
      }
    }
  }

  /**
   * Replay a compositor pointer event into the offscreen renderer so the
   * existing pet click/drag/hover handlers fire unchanged. Coordinates from
   * the helper are surface-local; screen coordinates are derived from the
   * surface's tracked position.
   */
  private handlePointer(kind: number, x: number, y: number, button: number): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return;
    }
    if (kind === PT_ENTER) return;
    if (kind === PT_LEAVE) {
      // Pointer left the pet surface. The inline context menu (if open) must
      // close: clicks outside the surface (desktop / other windows) never
      // reach the offscreen renderer, and layer-shell has no keyboard focus
      // (Escape can't arrive), so this Leave is the only reliable signal.
      try {
        this.window.webContents.send("openpets:pet-menu-close");
      } catch {
        // webContents may be mid-teardown
      }
      return;
    }
    // The helper moves the surface itself while dragging (absolute anchor, so
    // it tracks the cursor precisely); here we just pause frame polling so
    // pointer-motion messages stay responsive and resume on release.
    if (kind === PT_PRESS && button === 0x110 && !this.leftButtonDown) {
      this.leftButtonDown = true;
      this.pauseFrameStreaming();
    } else if (kind === PT_RELEASE && button === 0x110 && this.leftButtonDown) {
      this.leftButtonDown = false;
      this.resumeFrameStreaming();
    }
    const logicalX = x + this.frameOffset.x;
    const logicalY = y + this.frameOffset.y;
    const globalX = this.position.x + logicalX;
    const globalY = this.position.y + logicalY;
    const btn = mapPointerButton(button);
    try {
      if (kind === PT_MOVE) {
        this.window.webContents.sendInputEvent({ type: "mouseMove", x: logicalX, y: logicalY, globalX, globalY } as Electron.MouseInputEvent);
      } else if (kind === PT_PRESS) {
        this.window.webContents.sendInputEvent({ type: "mouseDown", x: logicalX, y: logicalY, globalX, globalY, button: btn, clickCount: 1 } as Electron.MouseInputEvent);
      } else if (kind === PT_RELEASE) {
        this.window.webContents.sendInputEvent({ type: "mouseUp", x: logicalX, y: logicalY, globalX, globalY, button: btn, clickCount: 1 } as Electron.MouseInputEvent);
      }
    } catch (error) {
      debug("pet.wayland", "sendInputEvent failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The helper moved the surface during a drag. Sync our tracked position so
   * `getPosition()` (and therefore position persistence and the motion-state
   * publisher) stays correct, and emit a synthetic `move` so the run-left/
   * run-right animation triggers.
   */
  private handlePositionUpdate(x: number, y: number): void {
    if (this.destroyed) return;
    if (this.position.x === x && this.position.y === y) return;
    this.position = { x, y };
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.window.emit("move");
      } catch {
        // synthetic move is best-effort (drives drag animation only)
      }
    }
  }

  private frameTimer: NodeJS.Timeout | null = null;
  private frameSendFn: ((image: NativeImage) => void) | null = null;
  /** Left button held (drag in progress) → pause frame polling to keep motion snappy. */
  private leftButtonDown = false;

  /**
   * Stream frames from the offscreen renderer. Prefers the event-driven
   * `beginFrameSubscription` (only fires when content changes → smooth, low
   * overhead); falls back to `capturePage` polling when the subscription does
   * not produce frames (it can silently idle for windows never shown on
   * screen on some compositors).
   */
  private attachFrameStreaming(): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      debug("pet.wayland", "frame streaming skipped (window not ready)", {});
      return;
    }
    // A re-attach (helper restart) must stop any previous polling timer first,
    // otherwise old captures and a fresh subscription would double-send frames.
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    debug("pet.wayland", "frame streaming attached", { windowId: this.window.id });
    let lastBitmap: Buffer | null = null;
    let usingSubscription = false;
    let framesSent = 0;
    let framesSkipped = 0;
    const sendFrame = (image: NativeImage): void => {
      const frame = cropTransparentFrame(image);
      if (!frame) return;
      const bitmap = frame.bitmap;
      // Skip frames identical to the previous one (static content) to keep
      // the socket quiet and the helper from re-committing unchanged frames.
      if (lastBitmap && bitmap.length === lastBitmap.length && bitmap.equals(lastBitmap)) {
        framesSkipped += 1;
        if (framesSkipped % 300 === 0) {
          debug("pet.wayland", "frame dedup", { framesSent, framesSkipped });
        }
        return;
      }
      lastBitmap = bitmap;
      framesSent += 1;
      if (framesSent % 60 === 0) {
        debug("pet.wayland", "frame sent", { framesSent, framesSkipped });
      }
      this.frameOffset = { x: frame.offsetX, y: frame.offsetY };
      this.write(encodeFrame(frame.offsetX, frame.offsetY, frame.width, frame.height, frame.stride, bitmap));
    };
    this.frameSendFn = sendFrame;

    // If the subscription yields nothing within the probe window, fall back.
    const probeTimer = setTimeout(() => {
      if (!usingSubscription) this.attachFrameStreamingFallback();
    }, FRAME_PROBE_MS);

    try {
      this.window.webContents.beginFrameSubscription(false, (image: NativeImage) => {
        usingSubscription = true;
        clearTimeout(probeTimer);
        sendFrame(image);
      });
    } catch (error) {
      clearTimeout(probeTimer);
      debug("pet.wayland", "beginFrameSubscription failed; using capturePage polling", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.attachFrameStreamingFallback();
    }
  }

  /** Poll `capturePage` at the animation frame rate (fallback path). */
  private attachFrameStreamingFallback(): void {
    if (this.frameTimer || !this.frameSendFn) return;
    debug("pet.wayland", "frame streaming fallback: capturePage polling", {});
    this.frameTimer = setInterval(() => {
      if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
        this.stopFrameStreaming();
        return;
      }
      void this.window.webContents.capturePage().then(this.frameSendFn!).catch(() => {
        // Transient capture failures are harmless; try again next tick.
      });
    }, FRAME_POLL_MS);
    this.frameTimer.unref?.();
  }

  /**
   * Pause polling-based frame streaming while the pet is being dragged so the
   * main process stays free to service pointer-motion messages (a slow
   * `capturePage` can otherwise starve drag handling and make it stutter).
   */
  private pauseFrameStreaming(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private resumeFrameStreaming(): void {
    this.attachFrameStreamingFallback();
  }

  /** Stop polling frames (called on destroy). */
  private stopFrameStreaming(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  // --- Controller-facing surface operations (called by patched window methods) ---

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.write(encodeMessage(TAG_SHOW, Buffer.alloc(0)));
    }
  }

  hide(): void {
    if (this.visible) {
      this.visible = false;
      this.write(encodeMessage(TAG_HIDE, Buffer.alloc(0)));
    }
  }

  move(x: number, y: number): void {
    if (this.position.x === x && this.position.y === y) return;
    this.position = { x, y };
    this.write(encodeMove(x, y));
  }

  isVisible(): boolean {
    return this.visible;
  }

  getPosition(): Point {
    return { x: this.position.x, y: this.position.y };
  }

  /** Attach a window to stream frames from (call once the offscreen window exists). */
  attachWindow(window: BrowserWindow): void {
    this.window = window;
    if (this.ready) this.attachFrameStreaming();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopFrameStreaming();
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try {
        this.window.webContents.endFrameSubscription();
      } catch {
        // webContents may already be torn down
      }
    }
    if (this.socket) {
      try {
        if (this.connected) this.socket.write(encodeMessage(TAG_QUIT, Buffer.alloc(0)));
      } catch {
        // ignore
      }
      this.socket.destroy();
      this.socket = null;
    }
    if (this.helper && !this.helper.killed) {
      this.helper.kill();
      this.helper = null;
    }
    try {
      // Unix sockets are removed automatically when the last reference closes,
      // but remove explicitly to be safe on abrupt teardown.
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
    } catch {
      // ignore
    }
  }
}

// --- Helper process management ---

function spawnHelper(
  helperPath: string,
  socketPath: string,
  width: number,
  height: number,
  position: Point,
): ReturnType<typeof import("node:child_process").spawn> | null {
  const args = ["--socket", socketPath, "--width", String(width), "--height", String(height), "--x", String(position.x), "--y", String(position.y)];
  try {
    const child = spawn(helperPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) debug("pet.wayland", "helper stderr", { line: line.trim() });
      }
    });
    child.on("error", (error) => {
      logError("pet.wayland", "helper process error", { error: error.message });
    });
    child.on("exit", (code, signal) => {
      info("pet.wayland", "helper process exited", { code, signal });
    });
    return child;
  } catch (error) {
    logError("pet.wayland", "failed to spawn helper", error instanceof Error ? error : { error });
    return null;
  }
}

// --- Window adoption ---

/**
 * Patch a pet `BrowserWindow` so its display-facing methods route to a
 * layer-shell surface, and stream the window's offscreen frames to the helper.
 *
 * The returned window is the same object with instance methods overridden; the
 * existing pet controllers keep working unchanged. Throws when the helper
 * cannot be started (caller should fall back to a normal window).
 */
export function adoptPetWindowForLayerShell(window: BrowserWindow, position: Point): BrowserWindow {
  const helperPath = resolveHelperBinaryPath();
  if (!helperPath) {
    throw new Error("openpets-wayland-helper binary not found");
  }

  const socketPath = join(resolveRuntimeDir(), `openpets-wayland-${process.pid}-${Date.now()}.sock`);
  const surface = new LayerShellSurface({
    helperPath,
    socketPath,
    width: window.getContentSize()[0],
    height: window.getContentSize()[1],
    position,
  });
  surface.start();
  surface.attachWindow(window);

  // Override display-facing methods on the instance so controllers never touch
  // the real (hidden/offscreen) window. This is deliberately narrow: content
  // loading, webContents messaging and lifecycle events keep using the real
  // window underneath.
  patchWindowSurface(window, surface);

  debug("pet.wayland", "layer-shell surface adopted", {
    windowId: window.id,
    position,
    size: [surface.width, surface.height],
    socketPath,
  });
  return window;
}

function resolveRuntimeDir(): string {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  return tmpdir();
}

/** Map a `wl_pointer` (evdev) button code to Electron's button names. */
function mapPointerButton(button: number): "left" | "middle" | "right" {
  if (button === 0x111) return "right";
  if (button === 0x112) return "middle";
  return "left";
}

function patchWindowSurface(window: BrowserWindow, surface: LayerShellSurface): void {
  // Capture the original destroy so we can also tear down the helper.
  const originalDestroy = window.destroy.bind(window);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;

  w.show = () => surface.show();
  w.showInactive = () => surface.show();
  w.hide = () => surface.hide();
  w.isVisible = () => surface.isVisible();
  w.isMinimized = () => false;
  w.restore = () => {};
  w.setPosition = (x: number, y: number) => surface.move(x, y);
  w.getPosition = () => {
    const p = surface.getPosition();
    return [p.x, p.y];
  };
  w.setBounds = (bounds: Electron.Rectangle) => surface.move(bounds.x, bounds.y);
  w.getBounds = () => {
    const p = surface.getPosition();
    return { x: p.x, y: p.y, width: surface.width, height: surface.height };
  };
  w.getContentBounds = () => {
    const p = surface.getPosition();
    return { x: p.x, y: p.y, width: surface.width, height: surface.height };
  };
  w.setContentSize = () => {};
  w.setIgnoreMouseEvents = () => {};
  w.setAlwaysOnTop = () => {};
  w.setVisibleOnAllWorkspaces = () => {};
  w.setFocusable = () => {};
  w.destroy = () => {
    surface.destroy();
    originalDestroy();
  };
}
