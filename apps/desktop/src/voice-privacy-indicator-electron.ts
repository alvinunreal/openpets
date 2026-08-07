import { BrowserWindow } from "electron";

import { createAppIcon } from "./assets.js";
import { debug } from "./logger.js";
import { VoicePrivacyIndicator, type VoicePrivacyIndicatorSurface } from "./voice-privacy-indicator.js";

const indicatorHtml = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;font:600 13px system-ui;color:white}.badge{margin:4px;padding:9px 13px;border-radius:18px;background:rgba(153,27,27,.94);box-shadow:0 4px 18px rgba(0,0,0,.25)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#fecaca;margin-right:8px}</style><div class="badge"><span class="dot"></span>OpenPets is listening</div>`;

class ElectronVoicePrivacyIndicatorSurface implements VoicePrivacyIndicatorSurface {
  #window: BrowserWindow | null = null;
  #visible = false;
  #topmostTimer: NodeJS.Timeout | null = null;

  show(): void {
    this.#visible = true;
    let window = this.#window;
    if (!window || window.isDestroyed()) {
      const created = new BrowserWindow({
        width: 176,
        height: 42,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        icon: createAppIcon(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      created.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");
      created.setIgnoreMouseEvents(true);
      if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      else if (process.platform === "linux") created.setVisibleOnAllWorkspaces(true);
      created.once("closed", () => {
        this.#window = null;
        this.#visible = false;
        if (this.#topmostTimer) clearInterval(this.#topmostTimer);
        this.#topmostTimer = null;
      });
      this.#window = created;
      window = created;
      void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml)}`).then(() => {
        if (this.#visible && this.#window === created && !created.isDestroyed()) created.showInactive();
      }).catch(() => undefined);
    }
    if (!this.#topmostTimer) {
      this.#topmostTimer = setInterval(() => {
        if (!this.#visible || !this.#window || this.#window.isDestroyed()) return;
        this.#window.setAlwaysOnTop(false);
        this.#window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");
      }, 1_000);
      this.#topmostTimer.unref?.();
    }
    if (window && !window.isDestroyed()) window.showInactive();
    debug("app", "voice privacy indicator shown");
  }

  hide(): void {
    this.#visible = false;
    if (this.#topmostTimer) clearInterval(this.#topmostTimer);
    this.#topmostTimer = null;
    if (this.#window && !this.#window.isDestroyed()) this.#window.hide();
    debug("app", "voice privacy indicator hidden");
  }

  destroy(): void {
    const window = this.#window;
    this.#window = null;
    this.#visible = false;
    if (this.#topmostTimer) clearInterval(this.#topmostTimer);
    this.#topmostTimer = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}

export function createElectronVoicePrivacyIndicator(): VoicePrivacyIndicator {
  return new VoicePrivacyIndicator(() => new ElectronVoicePrivacyIndicatorSurface());
}
