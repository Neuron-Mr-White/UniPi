/**
 * @pi-unipi/workflow — shared plan/permission mode snapshot
 *
 * Plan mode and permission mode each own one half of the bus's sticky
 * WORKFLOW_STATUS payload; this helper patches whichever half changed without
 * clobbering the other. The footer reads the snapshot directly.
 */

import { bus, UNIPI_EVENTS, type WorkflowStatusEvent } from "@pi-unipi/core";

export function updateWorkflowStatus(patch: Partial<WorkflowStatusEvent>): void {
  const cur = bus.get(UNIPI_EVENTS.WORKFLOW_STATUS) ?? { planMode: false, permissionMode: null };
  bus.emit(UNIPI_EVENTS.WORKFLOW_STATUS, { ...cur, ...patch });
}
