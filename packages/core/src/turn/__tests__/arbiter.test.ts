import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	decideSettle,
	installArbiter,
	isChildProcess,
	type Nudge,
	onSettleDecision,
	registerNudgeProvider,
	registerWaitSource,
	resetArbiterForTests,
	type SettleDecision,
	type SettleInfo,
} from "../arbiter.js";

function baseInfo(overrides: Partial<SettleInfo> = {}): SettleInfo {
	return {
		outcome: "completed",
		pendingMessages: 0,
		lastAssistantText: "done",
		lastAssistantHadToolCalls: true,
		toolCallsThisRun: 3,
		...overrides,
	};
}

function nudge(source: string, priority: number, extras: Partial<Nudge> = {}): Nudge {
	return { source, priority, customType: `nudge:${source}`, content: `go ${source}`, display: true, ...extras };
}

const info = baseInfo();

test.beforeEach(() => resetArbiterForTests());

test("isChildProcess checks the three child env vars", () => {
	assert.equal(isChildProcess({}), false);
	assert.equal(isChildProcess({ UNIPI_FUSION_CHILD: "1" }), true);
	assert.equal(isChildProcess({ UNIPI_SUBAGENT_CHILD: "1" }), true);
	assert.equal(isChildProcess({ UNIPI_KANBOARD_CHILD: "1" }), true);
	assert.equal(isChildProcess({ UNIPI_SUBAGENT_CHILD: "0" }), false);
});

test("highest-priority provider wins; exactly one nudge", async () => {
	registerNudgeProvider("low", 40, () => nudge("low", 40));
	registerNudgeProvider("high", 100, () => nudge("high", 100));
	const { decision, nudge: chosen } = await decideSettle(info, false);
	assert.deepEqual(decision, { kind: "nudge", source: "high", priority: 100 });
	assert.equal(chosen?.source, "high");
});

test("priority tie resolves to the earliest-registered provider", async () => {
	registerNudgeProvider("first", 50, () => nudge("first", 50));
	registerNudgeProvider("second", 50, () => nudge("second", 50));
	const { decision, nudge: chosen } = await decideSettle(info, false);
	assert.equal(chosen?.source, "first");
	assert.deepEqual(decision, { kind: "nudge", source: "first", priority: 50 });
});

test("pendingMessages suppresses (defence only)", async () => {
	let called = 0;
	registerNudgeProvider("p", 50, () => {
		called += 1;
		return nudge("p", 50);
	});
	const { decision } = await decideSettle(baseInfo({ pendingMessages: 2 }), false);
	assert.deepEqual(decision, { kind: "none", reason: "pending" });
	assert.equal(called, 0, "providers are not consulted when an event is pending");
});

test("already-continuing suppresses", async () => {
	registerNudgeProvider("p", 50, () => nudge("p", 50));
	const { decision } = await decideSettle(info, true);
	assert.deepEqual(decision, { kind: "none", reason: "continuing" });
});

test("a non-null wait source suppresses with source:reason detail", async () => {
	registerNudgeProvider("p", 50, () => nudge("p", 50));
	registerWaitSource("bg", () => "npm test");
	const { decision } = await decideSettle(info, false);
	assert.deepEqual(decision, { kind: "none", reason: "wait", detail: "bg: npm test" });
});

test("a throwing wait source is ignored", async () => {
	registerNudgeProvider("p", 50, () => nudge("p", 50));
	registerWaitSource("broken", () => {
		throw new Error("boom");
	});
	const { decision, nudge: chosen } = await decideSettle(info, false);
	assert.equal(chosen?.source, "p");
	assert.equal((decision as { kind: string }).kind, "nudge");
});

test("aborted and error outcomes suppress", async () => {
	registerNudgeProvider("p", 50, () => nudge("p", 50));
	assert.deepEqual((await decideSettle(baseInfo({ outcome: "aborted" }), false)).decision, {
		kind: "none",
		reason: "outcome",
		detail: "aborted",
	});
	assert.deepEqual((await decideSettle(baseInfo({ outcome: "error" }), false)).decision, {
		kind: "none",
		reason: "outcome",
		detail: "error",
	});
});

test("a throwing provider is ignored; others still propose", async () => {
	registerNudgeProvider("broken", 100, () => {
		throw new Error("boom");
	});
	registerNudgeProvider("ok", 40, () => nudge("ok", 40));
	const { decision, nudge: chosen } = await decideSettle(info, false);
	assert.equal(chosen?.source, "ok");
	assert.deepEqual(decision, { kind: "nudge", source: "ok", priority: 40 });
});

test("a provider slower than the (injectable) timeout is ignored", async () => {
	resetArbiterForTests({ providerTimeoutMs: 30 });
	registerNudgeProvider("slow", 100, () => new Promise((resolve) => setTimeout(() => resolve(nudge("slow", 100)), 200)));
	registerNudgeProvider("fast", 40, () => nudge("fast", 40));
	const { decision, nudge: chosen } = await decideSettle(info, false);
	assert.equal(chosen?.source, "fast");
	assert.deepEqual(decision, { kind: "nudge", source: "fast", priority: 40 });
});

test("no providers → no-proposal", async () => {
	const { decision } = await decideSettle(info, false);
	assert.deepEqual(decision, { kind: "none", reason: "no-proposal" });
});

test("async providers are awaited", async () => {
	registerNudgeProvider("async", 50, async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return nudge("async", 50);
	});
	const { nudge: chosen } = await decideSettle(info, false);
	assert.equal(chosen?.source, "async");
});

interface FakePi {
	handlers: Map<string, (...args: never[]) => unknown>;
	on(event: string, handler: (...args: never[]) => unknown): () => void;
}

/** The test process itself may run as a fusion/subagent child — pin lead env. */
function withLeadEnv<T>(fn: () => T): T {
	const keys = ["UNIPI_FUSION_CHILD", "UNIPI_SUBAGENT_CHILD", "UNIPI_KANBOARD_CHILD"] as const;
	const saved = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	try {
		return fn();
	} finally {
		keys.forEach((key, index) => {
			const previous = saved[index];
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
}

function fakePi(): FakePi {
	const handlers = new Map<string, (...args: never[]) => unknown>();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	};
}

interface SettleEvent {
	outcome: "completed" | "aborted" | "error";
	continue: boolean;
	entries: unknown[];
	context: { pendingMessages: unknown[]; contextMessages: unknown[]; canContinue: boolean };
}

function settleEvent(overrides: Partial<SettleEvent> = {}): SettleEvent {
	return {
		outcome: "completed",
		continue: false,
		entries: [],
		context: { pendingMessages: [], contextMessages: [], canContinue: true },
		...overrides,
	};
}

const assistant = (parts: unknown[]): unknown => ({ role: "assistant", content: parts });

test("installArbiter: nudge turn concats event.entries, continue:true, onDelivered fires", async () => {
	const pi = fakePi();
	withLeadEnv(() => installArbiter(pi));
	const handler = pi.handlers.get("agent_before_settle");
	assert.ok(handler, "before_settle handler registered");
	let delivered = 0;
	registerNudgeProvider("p", 50, () =>
		nudge("p", 50, { onDelivered: () => (delivered += 1) }),
	);
	const existing = [{ type: "custom", customType: "prior" }];
	const result = (await handler(settleEvent({ entries: existing }) as never, {} as never)) as {
		entries: Array<{ customType?: string; type: string }>;
		continue: boolean;
	};
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 2, "existing entries are preserved");
	assert.deepEqual(result.entries[0], existing[0]);
	assert.equal(result.entries[1]?.type, "custom_message");
	assert.equal(result.entries[1]?.customType, "nudge:p");
	assert.equal(delivered, 1);
});

test("installArbiter: none decision returns undefined", async () => {
	const pi = fakePi();
	withLeadEnv(() => installArbiter(pi));
	const handler = pi.handlers.get("agent_before_settle");
	assert.ok(handler);
	const result = await handler(settleEvent() as never, {} as never);
	assert.equal(result, undefined);
});

test("installArbiter: counts tool_call events and resets at agent_start", async () => {
	const pi = fakePi();
	withLeadEnv(() => installArbiter(pi));
	const onSettle = pi.handlers.get("agent_before_settle");
	assert.ok(onSettle);
	const onStart = pi.handlers.get("agent_start");
	const onToolCall = pi.handlers.get("tool_call");
	assert.ok(onStart && onToolCall);
	let seen = 0;
	onSettleDecision((_d, s) => {
		seen = s.toolCallsThisRun;
	});
	onStart(undefined as never, {} as never);
	onToolCall(undefined as never, {} as never);
	onToolCall(undefined as never, {} as never);
	await onSettle(settleEvent() as never, {} as never);
	assert.equal(seen, 2);
	onStart(undefined as never, {} as never);
	await onSettle(settleEvent() as never, {} as never);
	assert.equal(seen, 0);
});

test("installArbiter: SettleInfo is built from the last assistant message", async () => {
	const pi = fakePi();
	withLeadEnv(() => installArbiter(pi));
	const onSettle = pi.handlers.get("agent_before_settle");
	assert.ok(onSettle);
	let captured: SettleInfo | undefined;
	onSettleDecision((_d, s) => {
		captured = s;
	});
	const event = settleEvent();
	event.context.contextMessages = [
		{ role: "user", content: "hi" },
		assistant([{ type: "text", text: "partial " }, { type: "toolCall", name: "bash" }, { type: "text", text: "answer" }]),
	];
	await onSettle(event as never, {} as never);
	assert.equal(captured?.lastAssistantText, "partial answer");
	assert.equal(captured?.lastAssistantHadToolCalls, true);
	assert.equal(captured?.pendingMessages, 0);
	event.context.contextMessages = [assistant("plain string")];
	await onSettle(event as never, {} as never);
	assert.equal(captured?.lastAssistantText, "plain string");
	assert.equal(captured?.lastAssistantHadToolCalls, false);
});

test("installArbiter: every decision notifies listeners", async () => {
	const pi = fakePi();
	withLeadEnv(() => installArbiter(pi));
	const onSettle = pi.handlers.get("agent_before_settle");
	assert.ok(onSettle);
	const decisions: SettleDecision[] = [];
	onSettleDecision((d) => decisions.push(d));
	registerNudgeProvider("p", 50, () => nudge("p", 50));
	await onSettle(settleEvent() as never, {} as never);
	await onSettle(settleEvent({ outcome: "aborted" }) as never, {} as never);
	assert.deepEqual(decisions[0], { kind: "nudge", source: "p", priority: 50 });
	assert.deepEqual(decisions[1], { kind: "none", reason: "outcome", detail: "aborted" });
});

test("installArbiter is idempotent: the first call wins", () => {
	withLeadEnv(() => {
		const first = fakePi();
		const second = fakePi();
		installArbiter(first);
		installArbiter(second);
		assert.ok(first.handlers.has("agent_before_settle"));
		assert.equal(second.handlers.size, 0, "second install is a no-op");
	});
});

test("installArbiter is a no-op in child processes", async () => {
	const env = { UNIPI_SUBAGENT_CHILD: "1" };
	assert.equal(isChildProcess(env), true);
	const previous = process.env.UNIPI_SUBAGENT_CHILD;
	process.env.UNIPI_SUBAGENT_CHILD = "1";
	try {
		const pi = fakePi();
		installArbiter(pi);
		assert.equal(pi.handlers.size, 0, "no handlers registered in a child");
	} finally {
		if (previous === undefined) delete process.env.UNIPI_SUBAGENT_CHILD;
		else process.env.UNIPI_SUBAGENT_CHILD = previous;
	}
});
