import { app } from "electron";

import { closeAllAgentPets } from "./agent-pet-controller.js";
import { destroyDefaultPet } from "./default-pet-controller.js";
import { info } from "./logger.js";
import { stopLocalIpcServer } from "./local-ipc.js";
import { closeAllLanVisitingPets } from "./lan-pet-controller.js";
import { stopPluginService } from "./plugin-service.js";
import { shutdownPluginVoice } from "./plugin-voice.js";
import { focusOpenTaskWindows } from "./windows.js";

let intentionalQuit = false;
let cleanupStarted = false;
let cleanupFinished = false;
let hardExitTimer: NodeJS.Timeout | null = null;

export function installAppLifecycle(): void {
  app.on("second-instance", () => {
    info("app", "second instance requested");
    console.log("Second OpenPets launch requested; keeping existing instance.");
    focusOpenTaskWindows();
  });

  app.on("window-all-closed", () => {
    if (!intentionalQuit) {
      info("app", "all task windows closed; tray app kept alive");
      console.log("All OpenPets task windows closed; keeping tray app running.");
    }
  });

  app.on("activate", () => {
    info("app", "activate event");
    console.log("OpenPets activate event received; not opening a dashboard window.");
  });

  app.on("before-quit", (event) => {
    if (cleanupFinished) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    intentionalQuit = true;
    info("app", "before quit cleanup begin");
    scheduleHardExitFallback("before-quit");
    void (async () => {
      await shutdownPluginVoice().catch(() => undefined);
      await stopPluginService().catch(() => undefined);
      stopLocalIpcServer();
      closeAllLanVisitingPets();
      closeAllAgentPets();
      destroyDefaultPet();
      cleanupFinished = true;
      app.quit();
    })();
  });
}

export function quitOpenPets(): void {
  intentionalQuit = true;
  info("app", "quit requested");
  scheduleHardExitFallback("quit-requested");
  app.quit();
}

function scheduleHardExitFallback(reason: string): void {
  if (hardExitTimer) return;
  hardExitTimer = setTimeout(() => {
    info("app", "hard exit fallback", { reason });
    app.exit(0);
  }, 2_000);
  hardExitTimer.unref?.();
}
