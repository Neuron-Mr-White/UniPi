import { test } from "node:test";
import assert from "node:assert/strict";
import { kanboardClaimsReminder } from "./kanboard-label.js";

test("kanboardClaimsReminder: null without status or claims", () => {
	assert.equal(kanboardClaimsReminder(undefined), null);
	assert.equal(kanboardClaimsReminder(null), null);
	assert.equal(kanboardClaimsReminder({ claims: [], autowork: true, cli: "kb" }), null, "clean board → no reminder");
});

test("kanboardClaimsReminder: one id with the real cli prefix", () => {
	const r = kanboardClaimsReminder({
		claims: ["UNI-1"],
		autowork: false,
		cli: "unipi-kanboard --actor agent --project acme",
	});
	assert.ok(r, "claims present → reminder");
	assert.match(r, /^Kanboard: this session holds UNI-1 In Progress\. /);
	assert.ok(r.includes('`unipi-kanboard --actor agent --project acme finish <ID> --comment "<summary>"`'));
	assert.ok(r.includes('`unipi-kanboard --actor agent --project acme move <ID> blocked --comment "<what you need>"`'));
	assert.ok(r.includes("`unipi-kanboard --actor agent --project acme show <ID>`"));
});

test("kanboardClaimsReminder: two ids joined; cli falls back to unipi-kanboard", () => {
	const r = kanboardClaimsReminder({ claims: ["UNI-1", "UNI-2"], autowork: true });
	assert.ok(r, "claims present → reminder");
	assert.ok(r.includes("holds UNI-1, UNI-2 In Progress"));
	assert.ok(r.includes('`unipi-kanboard finish <ID> --comment "<summary>"`'), "cli fallback");
	assert.ok(r.includes('`unipi-kanboard move <ID> blocked --comment "<what you need>"`'));
	assert.ok(r.includes("`unipi-kanboard show <ID>`"));
});
