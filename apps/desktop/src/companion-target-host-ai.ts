import { HostAiGateway, type HostAiHealthSnapshot } from "./host-ai-gateway.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetRequest, CompanionTargetResult } from "./companion-targets.js";

export class HostAiCompanionTarget implements CompanionTarget {
  readonly id = "host-ai" as const;
  readonly #gateway: HostAiGateway;

  constructor(gateway: HostAiGateway) {
    this.#gateway = gateway;
  }

  async health(force = false): Promise<CompanionTargetHealth> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref?.();
    let health: HostAiHealthSnapshot;
    try {
      health = await this.#gateway.probeHealth({ force, signal: controller.signal });
    } catch (error) {
      const snapshot = await this.#gateway.getHealthSnapshot();
      return {
        targetId: "host-ai",
        checkedAt: snapshot.checkedAt ?? Date.now(),
        configured: snapshot.configured,
        ready: false,
        method: snapshot.evidence ?? "host AI provider readiness probe",
        provider: snapshot.provider,
        model: snapshot.model || undefined,
        reason: controller.signal.aborted ? "The configured AI provider readiness check timed out." : cleanError(error),
      };
    } finally {
      clearTimeout(timeout);
    }
    return {
      targetId: "host-ai",
      checkedAt: health.checkedAt ?? Date.now(),
      configured: health.configured,
      ready: health.ready,
      method: health.evidence ?? "host AI provider configuration",
      provider: health.provider,
      model: health.model || undefined,
      reason: health.error ?? (health.configured ? (health.ready ? undefined : "The configured AI provider has not passed its readiness check.") : "Configure an AI provider in OpenPets settings."),
    };
  }

  async send(request: CompanionTargetRequest): Promise<CompanionTargetResult> {
    if (request.signal.aborted) throw abortError();
    const result = await this.#gateway.complete({
      messages: [{ role: "user", content: request.prompt }],
      maxTokens: 420,
      temperature: 0.75,
    }, { signal: request.signal });
    const text = result.text.trim();
    if (!text) throw new Error("The configured AI provider returned an empty response.");
    return { text };
  }

  dispose(): void {
    // The host gateway owns no persistent connection or worker to tear down.
  }
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, "provider endpoint").slice(0, 240);
}

function abortError(): Error {
  const error = new Error("Companion conversation was cancelled.");
  error.name = "AbortError";
  return error;
}
