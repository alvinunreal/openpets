import type { BrowserWindow } from "electron";

/** Fail request-scoped playback as soon as its renderer can no longer complete it. */
export function installWindowLossHandlers(window: BrowserWindow, onLost: () => void): () => void {
  const cleanup = () => {
    window.off("closed", onClosed);
    window.webContents.off("destroyed", onDestroyed);
    window.webContents.off("render-process-gone", onRenderProcessGone);
    window.webContents.off("did-navigate", onNavigate);
    window.webContents.off("did-navigate-in-page", onNavigateInPage);
    window.webContents.off("did-fail-load", onFailLoad);
  };
  const onClosed = () => { cleanup(); onLost(); };
  const onDestroyed = () => { cleanup(); onLost(); };
  const onRenderProcessGone = () => { cleanup(); onLost(); };
  const onNavigate = () => { cleanup(); onLost(); };
  const onNavigateInPage = () => { cleanup(); onLost(); };
  const onFailLoad = () => { cleanup(); onLost(); };
  window.on("closed", onClosed);
  window.webContents.on("destroyed", onDestroyed);
  window.webContents.on("render-process-gone", onRenderProcessGone);
  window.webContents.on("did-navigate", onNavigate);
  window.webContents.on("did-navigate-in-page", onNavigateInPage);
  window.webContents.on("did-fail-load", onFailLoad);
  return cleanup;
}
