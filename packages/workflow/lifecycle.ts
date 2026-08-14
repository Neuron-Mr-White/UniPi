import type { UnipiWorkflowEvent } from "@pi-unipi/core";

interface WorkflowMessage {
  role: string;
  stopReason?: string;
}

export interface CompletedWorkflowEvent extends UnipiWorkflowEvent {
  success: boolean;
  durationMs: number;
}

/** Single-active workflow lifecycle state shared by slash handlers and agent_end. */
export class WorkflowLifecycle {
  private active: (UnipiWorkflowEvent & { startedAt: number }) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  start(event: UnipiWorkflowEvent): boolean {
    if (this.active) return false;
    this.active = { ...event, startedAt: this.now() };
    return true;
  }

  complete(messages: WorkflowMessage[]): CompletedWorkflowEvent | undefined {
    if (!this.active) return undefined;
    const workflow = this.active;
    this.active = null;
    const finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const success = finalAssistant?.stopReason !== "error" && finalAssistant?.stopReason !== "aborted";
    return {
      command: workflow.command,
      fullCommand: workflow.fullCommand,
      args: workflow.args,
      success,
      durationMs: this.now() - workflow.startedAt,
    };
  }

  reset(): void {
    this.active = null;
  }
}
