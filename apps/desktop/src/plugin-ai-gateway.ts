import { HostAiGateway } from "./host-ai-gateway.js";

/**
 * Compatibility name for existing plugin and voice call sites. The provider
 * implementation is host-owned; plugins are only one consumer of it.
 */
export class PluginAiGateway extends HostAiGateway {}

export {
  HostAiGateway,
  hostAiApiKeySecret,
  hostSecretsOwner,
} from "./host-ai-gateway.js";

export type {
  HostAiCallOptions,
  HostAiGatewayOptions,
  HostAiHealthEvidence,
  HostAiHealthSnapshot,
  HostAiHealthStatus,
  HostAiProbeOptions,
  HostAiRequest,
  HostAiResult,
  HostAiSecrets,
} from "./host-ai-gateway.js";
