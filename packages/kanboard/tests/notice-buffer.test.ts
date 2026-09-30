import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NoticeBuffer, flushNotices } from "../src/notice-buffer.js";

function spyPi() {
	const calls = {
		appendEntry: [] as Array<{ customType: string; data: unknown }>,
		sendMessage: [] as Array<{ message: unknown; options: unknown }>,
	};
	return {
		calls,
		pi: {
			appendEntry: (customType: string, data?: unknown) => {
				calls.appendEntry.push({ customType, data });
			},
			sendMessage: (message: unknown, options?: unknown) => {
				calls.sendMessage.push({ message, options });
			},
		},
	};
}

test("monitor notices only queue: nothing is sent while queued", () => {
	const { calls, pi } = spyPi();
	const buffer = new NoticeBuffer();
	buffer.queue("kanboard: autowork done · 5 in review · 0 blocked");
	buffer.queue("kanboard: ⚠ UNI-30 stalled — no progress after 2 nudges", "warning");
	assert.deepEqual(calls.appendEntry, [], "queued notices do not append");
	assert.deepEqual(calls.sendMessage, [], "queued notices NEVER sendMessage (they would leak as user-role LLM messages)");
	assert.equal(buffer.pending, 2);
});

test("agent_settled flush: appendEntry per notice, no sendMessage, buffer cleared", () => {
	const { calls, pi } = spyPi();
	const buffer = new NoticeBuffer();
	buffer.queue("kanboard: UNI-1 left In Progress — the agent asked you a question");
	buffer.queue("kanboard: goal paused — UNI-1 left In Progress", "warning");
	let toast: Array<{ text: string; level: string }> = [];
	flushNotices(pi, buffer, { hasUI: true, notify: (text, level) => toast.push({ text, level: level ?? "info" }) });
	assert.equal(calls.sendMessage.length, 0, "notices must never become messages");
	assert.deepEqual(
		calls.appendEntry.map((c) => c.customType),
		["unipi:kanboard-notice", "unipi:kanboard-notice"],
	);
	assert.deepEqual((calls.appendEntry[0]!.data as { text: string }).text, "kanboard: UNI-1 left In Progress — the agent asked you a question");
	assert.deepEqual((calls.appendEntry[0]!.data as { level: string }).level, "info");
	assert.deepEqual((calls.appendEntry[1]!.data as { level: string }).level, "warning");
	assert.deepEqual(toast.map((t) => t.level), ["info", "warning"]);
	assert.equal(buffer.pending, 0, "drained");
	// A second flush is a no-op.
	toast = [];
	flushNotices(pi, buffer);
	assert.deepEqual(calls.appendEntry.length, 2);
	assert.deepEqual(toast, []);
});

test("flush without a UI: entry only, no toast", () => {
	const { calls, pi } = spyPi();
	const buffer = new NoticeBuffer();
	buffer.queue("kanboard: autowork done · 0 in review · 0 blocked");
	flushNotices(pi, buffer, { hasUI: false, notify: () => assert.fail("no toast without a UI") });
	assert.equal(calls.appendEntry.length, 1);
	assert.equal(calls.sendMessage.length, 0);
});

test("an appendEntry failure never loses the toast", () => {
	const buffer = new NoticeBuffer();
	buffer.queue("kanboard: ⚠ autowork stalled on UNI-9", "warning");
	const toasts: string[] = [];
	flushNotices(
		{
			appendEntry: () => {
				throw new Error("boundary dropped it");
			},
		},
		buffer,
		{ hasUI: true, notify: (text) => toasts.push(text) },
		(line) => {
			assert.match(line, /appendEntry dropped/);
		},
	);
	assert.deepEqual(toasts, ["kanboard: ⚠ autowork stalled on UNI-9"]);
});
