/**
 * @unipi/web-api — error serialization
 *
 * Engines and providers throw a mix of Error instances and plain objects
 * (FetchError-shaped payloads, wreq-js native errors, provider API bodies).
 * `String()` on a plain object yields "[object Object]", which masked the
 * real diagnosis behind "Read failed: [object Object]". Everything that
 * surfaces an error to the agent must go through describeError().
 */

/** Best-effort human-readable message for any thrown value. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.toString();
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const obj = error as Record<string, unknown>;
		for (const key of ["message", "error", "reason", "detail"]) {
			const v = obj[key];
			if (typeof v === "string" && v.trim()) return v;
		}
		try {
			return JSON.stringify(error) ?? String(error);
		} catch {
			// circular or otherwise unserializable — describe by shape
			const keys = Object.getOwnPropertyNames(obj).join(",");
			return keys ? `[${keys}]` : String(error);
		}
	}
	return String(error);
}
