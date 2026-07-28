import { describe, expect, it } from "bun:test";
import { redactRpcUrlSecrets } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const REDACTED = "[credential_redacted]";

describe("RPC provider observation URL redaction", () => {
	it("redacts sensitive query values across every supported URL reference shape", () => {
		const secret = "low-entropy-secret";
		const references = [
			"https://provider.example/api/v1?token=low-entropy-secret&mode=safe",
			"//provider.example/api/v1?token=low-entropy-secret&mode=safe",
			"/api/v1?token=low-entropy-secret&mode=safe",
			"./api/v1?token=low-entropy-secret&mode=safe",
			"../api/v1?token=low-entropy-secret&mode=safe",
			"?token=low-entropy-secret&mode=safe",
			"api/v1?token=low-entropy-secret&mode=safe",
		];

		for (const reference of references) {
			const result = redactRpcUrlSecrets(reference);
			expect(result).not.toContain(secret);
			expect(result).toContain(`token=${REDACTED}`);
			expect(result).toContain("mode=safe");
		}
	});

	it("redacts the review's rootless low-entropy credential without changing its URL shape", () => {
		expect(redactRpcUrlSecrets("api/v1?token=low-entropy-secret")).toBe(`api/v1?token=${REDACTED}`);
	});

	it("preserves references and ordinary text exactly when no sensitive query value is present", () => {
		const values = [
			"https://provider.example/api/v1?mode=safe",
			"//provider.example/api/v1?mode=safe",
			"/api/v1?mode=safe",
			"./api/v1?mode=safe",
			"../api/v1?mode=safe",
			"?mode=safe",
			"api/v1?mode=safe",
			"Could this be plain text? token is just a word, not a query parameter.",
		];

		for (const value of values) expect(redactRpcUrlSecrets(value)).toBe(value);
	});
});
