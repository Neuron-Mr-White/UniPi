/**
 * The approval prompt shown when a tool call needs a human decision.
 *
 * Option order is deliberate: "Allow once" is first, so Enter allows and keeps
 * the agent moving. Esc (undefined) denies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addPermissionRule, type PermissionSettings } from "./settings.js";
import { suggestPattern, type PermissionRule } from "./rules.js";

export interface ApprovalRequest {
  toolName: string;
  /** One-line summary of what is about to run (≤120 chars). */
  summary: string;
  /** Why we are asking, e.g. `dangerous: rm -rf` or `jev: needs_approval 0.82`. */
  reason: string;
  /** Subject the rules match against (command or resolved path). */
  subject: string;
}

export interface ApprovalOutcome {
  decision: "allow" | "deny";
  /** Note from "Deny with note…", appended to the block reason. */
  note?: string;
  /** Rule saved by "Always allow …". */
  savedRule?: PermissionRule;
}

const ALLOW_ONCE = "Allow once";
const DENY = "Deny";
const DENY_NOTE = "Deny with note…";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export async function requestApproval(
  ctx: ExtensionContext,
  request: ApprovalRequest,
  settings: PermissionSettings,
): Promise<ApprovalOutcome> {
  const pattern = suggestPattern(request.toolName, request.subject);
  const alwaysLabel = `Always allow \`${clip(pattern, 60)}\``;
  const options = [ALLOW_ONCE, alwaysLabel, DENY, DENY_NOTE];
  const title = `Allow ${request.toolName}: ${clip(request.summary, 120)}?\n${clip(request.reason, 120)}`;

  const choice = await ctx.ui.select(title, options);

  if (choice === ALLOW_ONCE) return { decision: "allow" };

  if (choice === alwaysLabel) {
    const rule: PermissionRule = {
      tool: request.toolName,
      pattern,
      decision: "allow",
      scope: "project",
    };
    addPermissionRule(rule, ctx.cwd);
    ctx.ui.notify(`Permission rule saved: allow ${request.toolName} \`${pattern}\``, "info");
    return { decision: "allow", savedRule: rule };
  }

  if (choice === DENY_NOTE && typeof ctx.ui.input === "function") {
    const note = await ctx.ui.input("Why deny? (sent to the agent)", "");
    return { decision: "deny", note: note?.trim() || undefined };
  }

  // DENY, Esc (undefined) and anything unexpected all deny.
  void settings;
  return { decision: "deny" };
}
