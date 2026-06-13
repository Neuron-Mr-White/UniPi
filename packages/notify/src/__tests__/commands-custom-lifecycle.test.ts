/**
 * Test: Notify — custom overlay lifecycle
 *
 * ctx.ui.custom() returns a Promise that resolves when the overlay calls done().
 * Overlay commands must await that Promise so Pi keeps the command/UI lifecycle
 * alive while the overlay has keyboard focus.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../../");

function readSource(relativePath: string): string {
	const fullPath = join(ROOT, relativePath);
	if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
	return readFileSync(fullPath, "utf-8");
}

describe("notify — custom overlay lifecycle", () => {
	it("does not launch ctx.ui.custom() without await or void", () => {
		const src = readSource("packages/notify/commands.ts");

		const bareCustomCalls = src
			.split("\n")
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.startsWith("ctx.ui.custom("));

		assert.deepStrictEqual(
			bareCustomCalls,
			[],
			"ctx.ui.custom() should be awaited for command overlays or explicitly voided for nested fire-and-forget overlays",
		);
	});

	it("awaits top-level notify overlay commands", () => {
		const src = readSource("packages/notify/commands.ts");

		const awaitedOverlayCalls = [...src.matchAll(/await ctx\.ui\.custom\(/g)]
			.length;

		assert.equal(
			awaitedOverlayCalls,
			5,
			"All five notify overlay commands should await ctx.ui.custom()",
		);
	});

	it("marks nested overlay launches as intentional fire-and-forget", () => {
		const src = readSource("packages/notify/commands.ts");

		assert.match(
			src,
			/void ctx\.ui\.custom\(/,
			"Nested overlay launches should use void ctx.ui.custom() to make the lifecycle choice explicit",
		);
	});
});
