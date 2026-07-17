import { BrowserWindow } from "electron";

import { createAppIcon } from "./assets.js";
import { debug } from "./logger.js";

export class VoicePrivacyIndicator {
  #window: BrowserWindow | null = null;
  #liveTracks = 0;

  trackStarted(): void {
    this.#liveTracks += 1;
    this.#show();
  }

  trackStopped(): void {
    this.#liveTracks = Math.max(0, this.#liveTracks - 1);
    if (this.#liveTracks === 0) this.#hide();
  }

  shutdown(): void {
    this.#liveTracks = 0;
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = null;
  }

  #show(): void {
    let window = this.#window;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
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
      window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");
      window.setIgnoreMouseEvents(true);
      if (process.platform === "linux") window.setVisibleOnAllWorkspaces(true);
      const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;font:600 13px system-ui;color:white}.badge{margin:4px;padding:9px 13px;border-radius:18px;background:rgba(153,27,27,.94);box-shadow:0 4px 18px rgba(0,0,0,.25)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#fecaca;margin-right:8px}</style><div class="badge"><span class="dot"></span>OpenPets is listening</div>`;
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      window.once("closed", () => { this.#window = null; if (this.#liveTracks > 0) this.#show(); });
      this.#window = window;
    }
    window.showInactive();
    debug("app", "voice privacy indicator shown", { liveTracks: this.#liveTracks });
  }

  #hide(): void {
    if (this.#window && !this.#window.isDestroyed()) this.#window.hide();
    debug("app", "voice privacy indicator hidden");
  }
}
