import { ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
export type FakeAdapterScenario = "success" | "authentication_failure" | "rate_limit" | "timeout" | "transient_failure" | "invalid_response" | "secret_echo" | "delayed";
export class DeterministicFakeProviderAdapter implements ProviderAdapter {
  calls = 0;
  constructor(private readonly scenario: FakeAdapterScenario = "success", private readonly secret = "sk-fake-secret-123456") {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) { this.calls++; if (input.signal.aborted) throw new ProviderGatewayError("CANCELLED"); if (this.scenario === "authentication_failure") throw new ProviderGatewayError("AUTHENTICATION_FAILED"); if (this.scenario === "rate_limit") throw new ProviderGatewayError("RATE_LIMITED"); if (this.scenario === "timeout") throw new ProviderGatewayError("TIMEOUT"); if (this.scenario === "transient_failure") throw new ProviderGatewayError("TRANSIENT_UPSTREAM"); if (this.scenario === "invalid_response") throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); if (this.scenario === "secret_echo") throw new Error(`upstream failed with ${this.secret}`); if (this.scenario === "delayed") await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 5); input.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new ProviderGatewayError("CANCELLED")); }, { once: true }); }); return { response: { fixture: true }, remoteRequestId: `fake-${this.calls}`, usage: { inputTokens: 1, outputTokens: 1 } }; }
}
