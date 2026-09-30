/**
 * Kanboard monitor notices — user-only, never LLM context.
 *
 * The monitor proposes during the settle boundary, where `appendEntry` is
 * dropped and a `sendMessage` custom message would be converted to a
 * user-role LLM message (dist/core/messages.js `case "custom"`). So the
 * monitor only QUEUES text here; kanboard's `agent_settled` handler (post
 * boundary) drains it via `flushNotices`: an `appendEntry` custom entry
 * (rendered by the entry renderer, transcript-only) plus a UI toast.
 */

export type NoticeLevel = "info" | "warning";

export interface NoticeItem {
	text: string;
	level: NoticeLevel;
}

export const NOTICE_ENTRY = "unipi:kanboard-notice";

export class NoticeBuffer {
	private items: NoticeItem[] = [];

	queue(text: string, level: NoticeLevel = "info"): void {
		this.items.push({ text, level });
	}

	/** Return everything queued (newest last) and clear the buffer. */
	drain(): NoticeItem[] {
		return this.items.splice(0);
	}

	get pending(): number {
		return this.items.length;
	}
}

export interface NoticeFlushPi {
	/** Custom entries are transcript-only — never serialized into LLM context. */
	appendEntry(customType: string, data?: unknown): void;
}

export interface NoticeFlushUi {
	hasUI?: boolean;
	notify?(text: string, level?: NoticeLevel): void;
}

/**
 * Drain the buffer: one appendEntry per notice (user-only entry) and, when a
 * dialog-capable UI is attached, a toast. Never sends a message. appendEntry
 * failures are reported to `debug` (the toast still fires, so a notice is
 * never lost even if entries are dropped in odd phases).
 */
export function flushNotices(
	pi: NoticeFlushPi,
	buffer: NoticeBuffer,
	ui?: NoticeFlushUi,
	debug?: (line: string) => void,
): void {
	for (const item of buffer.drain()) {
		try {
			pi.appendEntry(NOTICE_ENTRY, { text: item.text, level: item.level });
		} catch (error) {
			debug?.(`appendEntry dropped: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (ui?.hasUI !== false) {
			try {
				ui?.notify?.(item.text, item.level);
			} catch {
				// A failed toast must never break settlement.
			}
		}
	}
}
