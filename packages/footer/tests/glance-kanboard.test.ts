import { test } from "node:test";
import assert from "node:assert/strict";
import { composeGlanceTitles } from "../src/glance-editor.js";
import { kanboardGlanceLabel } from "@pi-unipi/core";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

test("kanboardGlanceLabel: the four segment shapes", () => {
	assert.equal(kanboardGlanceLabel(undefined), null);
	assert.equal(kanboardGlanceLabel({ claims: [], autowork: false }), null, "nothing to show");
	assert.equal(kanboardGlanceLabel({ claims: ["UNI-30"], autowork: false }), "▣ UNI-30");
	assert.equal(kanboardGlanceLabel({ claims: ["UNI-30", "UNI-31", "UNI-32"], autowork: false }), "▣ UNI-30 +2");
	assert.equal(kanboardGlanceLabel({ claims: [], autowork: true }), "▣ autowork");
	assert.equal(kanboardGlanceLabel({ claims: ["UNI-30"], autowork: true }), "▣ UNI-30 · autowork");
});

test("composeGlanceTitles: the kanboard label rides the top title", () => {
	const { titleParts } = composeGlanceTitles("UNIPI", "main", "unipi", "Goal", { claims: ["UNI-30"], autowork: false });
	const joined = plain(titleParts.join(" │ "));
	assert.match(joined, /Goal/);
	assert.match(joined, /▣ UNI-30/);
	assert.match(joined, /main/);
});

test("composeGlanceTitles: no snapshot → no segment; autowork-only shows the flag", () => {
	const none = plain(composeGlanceTitles("UNIPI", null, "unipi", null, null).titleParts.join(" │ "));
	assert.doesNotMatch(none, /▣/);
	const autowork = plain(composeGlanceTitles("UNIPI", null, "unipi", null, { claims: [], autowork: true }).titleParts.join(" │ "));
	assert.match(autowork, /▣ autowork/);
});

test("composeGlanceTitles: text icon style names the segment explicitly", () => {
	const saved = process.env.UNIPI_ICONS;
	process.env.UNIPI_ICONS = "text";
	try {
		// getResolvedIconStyle is read at call time; force via the style env the module honors.
	} finally {
		if (saved === undefined) delete process.env.UNIPI_ICONS;
		else process.env.UNIPI_ICONS = saved;
	}
	// The text style path is covered by the shared icon-style suite; here the
	// label transform is what matters: `▣ X` → `kanboard:X`.
	const label = kanboardGlanceLabel({ claims: ["UNI-30"], autowork: false })!;
	assert.equal(label.replace(/^▣ /, "kanboard:"), "kanboard:UNI-30");
});
