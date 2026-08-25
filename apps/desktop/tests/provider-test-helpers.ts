import { createProviderProfile, selectProviderProfile, updateProviderProfile, getPluginPlatformSettings, type ProviderProfileInput, type ProviderRole } from "../src/plugin-platform-settings.js";

export function configureProvider(profile: ProviderProfileInput, role: ProviderRole): void {
  if (getPluginPlatformSettings().profiles[profile.id]) updateProviderProfile(profile.id, profile);
  else createProviderProfile(profile);
  selectProviderProfile(role, profile.id);
}
