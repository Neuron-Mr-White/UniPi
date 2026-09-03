/**
 * @pi-unipi/footer — glance icon-mode + rainbow painting tests
 *
 * Issue #34: the rainbow painter must never split surrogate pairs (🤖/🔀)
 * or detach VS16 emoji presentation, and the glance frame must compose its
 * titles per icon style — text mode shows `branch:main` / `workspace:unipi`
 * with no robot glyph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lolcatRainbow, paintLolcatGradient } from "../src/rendering/lolcat.js";
import { setIconStyle } from "../src/rendering/icons.js";
import { composeGlanceTitles } from "../src/glance-editor.js";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

/** A surrogate half not paired with its other half — the #34 corruption. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("paintLolcatGradient (issue #34)", () => {
	it("keeps emoji surrogate pairs intact", () => {
		const src = "🤖 UNIPI │ 🔀 main";
		const painted = paintLolcatGradient(src, 0.5);
		assert.equal(painted.replace(ANSI_RE, ""), src, "text survives verbatim after stripping SGR");
		assert.doesNotMatch(painted, LONE_SURROGATE_RE, "no lone surrogate halves");
	});

	it("never inserts SGR inside a surrogate pair or before VS16", () => {
		const src = "📁 unipi ⬇️";
		const painted = paintLolcatGradient(src, 0);
		assert.ok(painted.includes("📁"), "📁 contiguous");
		assert.ok(painted.includes("⬇️"), "VS16 stays attached to its base");
	});

	it("copies ANSI/OSC/APC sequences verbatim", () => {
		const src = "\x1b]133;A\x07\x1b_pi:c\x07\x1b[31mred\x1b[39m";
		const painted = paintLolcatGradient(src, 0);
		assert.ok(painted.includes("\x1b]133;A\x07"), "OSC 133 marker untouched");
		assert.ok(painted.includes("\x1b_pi:c\x07"), "APC cursor marker untouched");
		assert.ok(painted.includes("\x1b[31m"), "existing SGR passes through verbatim");
		assert.equal(painted.replace(ANSI_RE, ""), "red");
	});

	it("plain ASCII painting matches the per-char gradient", () => {
		const painted = paintLolcatGradient("abc", 0);
		assert.equal(painted.replace(ANSI_RE, ""), "abc");
		assert.match(painted, /\x1b\[38;2;\d+;\d+;\d+ma/);
	});
});

describe("lolcatRainbow", () => {
	it("strips back to the plain word", () => {
		assert.equal(lolcatRainbow("UNIPI", 1).replace(ANSI_RE, ""), "UNIPI");
	});
});

describe("composeGlanceTitles icon modes", () => {
	it("text mode: no robot glyph, branch:main, workspace:unipi", () => {
		setIconStyle("text");
		const { titleParts, leftTitle } = composeGlanceTitles("UNIPI", "main", "unipi");
		assert.deepEqual(titleParts, ["UNIPI", "branch:main"]);
		assert.equal(leftTitle, " workspace:unipi ");
	});

	it("text mode with no branch: brand only", () => {
		setIconStyle("text");
		const { titleParts, leftTitle } = composeGlanceTitles("UNIPI", null, "unipi");
		assert.deepEqual(titleParts, ["UNIPI"]);
		assert.equal(leftTitle, " workspace:unipi ");
	});

	it("emoji mode: glyph prefixes (current behavior)", () => {
		setIconStyle("emoji");
		const { titleParts, leftTitle } = composeGlanceTitles("UNIPI", "feat/x", "proj");
		assert.deepEqual(titleParts, ["🤖 UNIPI", "🔀 feat/x"]);
		assert.equal(leftTitle, " 📁 proj ");
	});

	it("nerd mode: nerd glyph prefixes", () => {
		setIconStyle("nerd");
		const { titleParts, leftTitle } = composeGlanceTitles("UNIPI", "main", "ws");
		assert.deepEqual(titleParts, ["\u{F06A9} UNIPI", "\uEAFE main"]);
		assert.equal(leftTitle, " \u{F1154} ws ");
	});

	it("nerd mode: brand carries the model glyph (󰚩), not the unused brand key", () => {
		setIconStyle("nerd");
		const { titleParts } = composeGlanceTitles("UNIPI", "main", "ws");
		assert.equal(titleParts[0], "\u{F06A9} UNIPI");
	});
});
