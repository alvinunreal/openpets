export const pluginSdkAsyncRoutes = [
  "pet.speak", "pet.react", "pet.setAnimation", "pet.setScale", "pet.setStatusReaction", "pet.moveBy", "pet.wander", "pet.moveToHome", "pet.moveTo", "pet.followCursor", "pet.physics", "pet.onTick", "pet.offTick", "pet.getState", "pet.show", "pet.hide", "pet.close",
  "pets.list", "pets.spawn", "pets.onChange", "pets.offChange",
  "ui.bubble", "ui.alert", "ui.bubbleUpdate", "ui.bubbleDismiss", "ui.bubblePin", "ui.bubbleUnpin", "ui.bubbleSubscribe", "ui.toast", "ui.panel", "ui.panelShow", "ui.panelHide", "ui.panelPost", "ui.panelClose", "ui.panelOnMessage", "ui.delivery", "ui.deliveryDismiss", "ui.deliverySubscribe", "ui.menuSetItems", "ui.menuOnSelect", "ui.menuOffSelect",
  "audio.play", "audio.importUserSound", "audio.forgetUserSound", "audio.stop",
  "events.on", "events.off",
  "assets.resolve",
  "bus.publish", "bus.subscribe", "bus.unsubscribe",
  "schedule.once", "schedule.every", "schedule.daily", "schedule.cron", "schedule.at", "schedule.list", "schedule.cancel", "schedule.cancelAll",
  "storage.get", "storage.set", "storage.delete", "storage.keys", "storage.subscribe", "storage.unsubscribe",
  "config.get", "config.onChange", "config.offChange",
  "net.fetch", "net.stream",
  "notify.notify",
  "ai.available", "ai.complete", "ai.stream",
  "secrets.get", "secrets.set", "secrets.delete", "secrets.has",
  "voice.speak", "voice.listen",
  "auth.oauth", "auth.refresh", "auth.signOut",
  "files.pick", "files.read", "files.save",
  "system.info", "system.metrics", "system.openExternal", "system.readClipboardText", "system.writeClipboardText",
  "commands.register", "commands.unregister", "status.set", "status.clear", "http.fetch",
  "assistant.registerCapability", "assistant.unregisterCapability",
  "log.debug", "log.info", "log.warn", "log.error",
] as const;

export const pluginSdkSyncRoutes = ["i18n.t", "i18n.locale"] as const;
export const pluginSdkRoutes = [...pluginSdkAsyncRoutes, ...pluginSdkSyncRoutes] as const;
export type PluginSdkRoute = typeof pluginSdkRoutes[number];

export function isPluginSdkRoute(path: string): path is PluginSdkRoute {
  return (pluginSdkRoutes as readonly string[]).includes(path);
}
