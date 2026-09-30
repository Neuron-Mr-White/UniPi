import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	gatherEvidence,
	registerEvidenceContributor,
	resetEvidenceForTests,
} from "../../evidence.js";

test.beforeEach(() => resetEvidenceForTests());

test("contributions aggregate blocking and notes", async () => {
	const off1 = registerEvidenceContributor("kanboard", async () => ({
		blocking: ["UNI-30 is still In Progress"],
		notes: ["2 tasks in review"],
	}));
	const off2 = registerEvidenceContributor("other", async () => ({ blocking: [], notes: ["note"] }));
	const evidence = await gatherEvidence();
	assert.deepEqual(evidence.blocking, ["UNI-30 is still In Progress"]);
	assert.deepEqual(evidence.notes.sort(), ["2 tasks in review", "note"]);
	off1();
	off2();
});

test("a throwing contributor contributes nothing", async () => {
	registerEvidenceContributor("broken", async () => {
		throw new Error("boom");
	});
	registerEvidenceContributor("ok", async () => ({ blocking: ["b"], notes: [] }));
	const evidence = await gatherEvidence();
	assert.deepEqual(evidence.blocking, ["b"]);
});

test("a slow contributor is time-boxed", async () => {
	registerEvidenceContributor("slow", () => new Promise((resolve) => setTimeout(() => resolve({ blocking: ["late"], notes: [] }), 500)));
	const started = Date.now();
	const evidence = await gatherEvidence(30);
	assert.deepEqual(evidence.blocking, []);
	assert.ok(Date.now() - started < 400, "gather returned at the timeout, not at the contributor");
});

test("re-registering a name replaces; unregister removes", async () => {
	registerEvidenceContributor("kanboard", async () => ({ blocking: ["one"], notes: [] }));
	const unregister = registerEvidenceContributor("kanboard", async () => ({ blocking: ["two"], notes: [] }));
	let evidence = await gatherEvidence();
	assert.deepEqual(evidence.blocking, ["two"]);
	unregister();
	evidence = await gatherEvidence();
	assert.deepEqual(evidence.blocking, []);
});

test("no contributors resolves immediately", async () => {
	const started = Date.now();
	const evidence = await gatherEvidence();
	assert.deepEqual(evidence, { blocking: [], notes: [] });
	assert.ok(Date.now() - started < 50);
});
