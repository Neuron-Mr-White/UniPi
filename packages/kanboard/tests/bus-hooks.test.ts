import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { bus, collectCompactionContext, registerCompactionContext, resetBusForTests, UNIPI_EVENTS } from "@pi-unipi/core";
import { kanboardCompactionContext, rearmOnOwnerResume } from "../src/bus-hooks.js";

beforeEach(() => resetBusForTests());

function fakePi() {
	return { on: () => () => {} } as unknown as Parameters<typeof rearmOnOwnerResume>[0];
}

test("compaction context: reminder after a KANBOARD_STATUS emit", () => {
	registerCompactionContext("kanboard", kanboardCompactionContext);
	bus.emit(UNIPI_EVENTS.KANBOARD_STATUS, {
		claims: ["UNI-1"],
		autowork: false,
		cli: "kb --actor agent --project p",
	});
	const block = collectCompactionContext().find((b) => b.id === "kanboard");
	assert.ok(block, "kanboard block present while claims are open");
	assert.match(block.text, /^Kanboard: this session holds UNI-1 In Progress\./);
	assert.ok(block.text.includes("`kb --actor agent --project p finish <ID> --comment \"<summary>\"`"));
});

test("compaction context: clean board → no kanboard block", () => {
	registerCompactionContext("kanboard", kanboardCompactionContext);
	bus.emit(UNIPI_EVENTS.KANBOARD_STATUS, { claims: [], autowork: false });
	assert.equal(
		collectCompactionContext().some((b) => b.id === "kanboard"),
		false,
		"nothing in flight → provider contributes nothing",
	);
});

test("re-arm: owner resumed arms the monitor; activated does not", () => {
	let armed = 0;
	const monitor = {
		arm: (reason?: string) => {
			assert.equal(reason, "owner resumed");
			armed += 1;
		},
	};
	const unsub = rearmOnOwnerResume(fakePi(), monitor);

	bus.emit(UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "activated" });
	assert.equal(armed, 0, "activation must not re-arm");
	bus.emit(UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "suspended" });
	assert.equal(armed, 0, "suspend must not re-arm");
	bus.emit(UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "resumed" });
	assert.equal(armed, 1, "resume re-arms after a goal pause");

	unsub();
	bus.emit(UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "resumed" });
	assert.equal(armed, 1, "unsubscribe stops the re-arms");
});
