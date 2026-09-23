/**
 * @unipi/core — Shared plan-mode / permission-mode holder
 *
 * The workflow module owns both states; the footer renders them. Event
 * subscriptions in the footer happen during its own session_start handler,
 * which runs AFTER the workflow module's — so the first event of a session
 * would be missed. This holder is written by the owner and read at render time.
 */

export interface PlanPermissionStatus {
  /** Plan mode is active (footer PLAN badge). */
  planMode: boolean;
  /** ask | auto | full, or null when unknown. */
  permissionMode: string | null;
}

let shared: PlanPermissionStatus = { planMode: false, permissionMode: null };

export function setSharedPlanMode(active: boolean): void {
  shared = { ...shared, planMode: active };
}

export function setSharedPermissionMode(mode: string | null): void {
  shared = { ...shared, permissionMode: mode };
}

export function getSharedPlanPermissionStatus(): PlanPermissionStatus {
  return shared;
}

/** Test hook. */
export function resetSharedPlanPermissionStatus(): void {
  shared = { planMode: false, permissionMode: null };
}
