import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MODULES = { SUBAGENTS: "subagents" } as const;

export const UNIPI_EVENTS = {
  MODULE_READY: "unipi:module:ready",
  BADGE_GENERATE_REQUEST: "unipi:badge:generate:request",
} as const;

export interface UnipiBadgeGenerateRequestEvent {
  conversationSummary?: string;
}

export function emitEvent(
  pi: Pick<ExtensionAPI, "events">,
  eventName: string,
  payload: unknown,
): boolean {
  try {
    pi.events.emit(eventName, payload);
    return true;
  } catch {
    return false;
  }
}

export async function withHerdrBlocked<T>(
  pi: Pick<ExtensionAPI, "events">,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  emitEvent(pi, "herdr:blocked", { active: true, label });
  try {
    return await fn();
  } finally {
    emitEvent(pi, "herdr:blocked", { active: false, label });
  }
}
