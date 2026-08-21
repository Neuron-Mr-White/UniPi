/**
 * @pi-unipi/subagents — Authority policy
 *
 * Ported from pi-subagents src/policy/authority.ts. Small fixed policy for
 * operational actions: "confirm" requires explicit user confirmation;
 * "auto" proceeds without asking.
 */

export type AuthorityDecision = "auto" | "confirm" | "forbid";

export interface AuthorityPolicyConfig {
  discardWorktree?: "confirm" | "auto";
  destructiveCleanup?: "confirm" | "auto";
  spawnBudgetGrant?: "confirm" | "auto";
  scheduleCreate?: "confirm" | "auto";
}

export type AuthorityAction = keyof AuthorityPolicyConfig;

const DEFAULT_POLICY: Required<AuthorityPolicyConfig> = {
  discardWorktree: "confirm",
  destructiveCleanup: "confirm",
  spawnBudgetGrant: "confirm",
  scheduleCreate: "auto",
};

export function resolveAuthorityDecision(input: {
  action: AuthorityAction;
  policy?: AuthorityPolicyConfig;
  confirmed?: boolean;
}): AuthorityDecision {
  const configured = input.policy?.[input.action] ?? DEFAULT_POLICY[input.action];
  if (configured === "auto") return "auto";
  return input.confirmed ? "auto" : "confirm";
}

export function authorityPolicyFromConfig(raw: unknown): AuthorityPolicyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const result: AuthorityPolicyConfig = {};
  for (const action of Object.keys(DEFAULT_POLICY) as AuthorityAction[]) {
    if (value[action] === "confirm" || value[action] === "auto") {
      result[action] = value[action] as "confirm" | "auto";
    }
  }
  return result;
}
