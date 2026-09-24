/**
 * "Also move A to Todo": when a task lands in Todo while a dependency is still in
 * Backlog, it is locked (the runner never claims Backlog). Offer — never force —
 * to schedule those dependencies too.
 */
import { api } from "./api.js";
import { board, describe, loadBoard, slug, toast } from "./state.js";

export function offerToSchedule(taskId: string): void {
  const target = slug();
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!target || !task) return;
  const parked = (task.deps ?? []).filter((dep) => board.tasks.find((candidate) => candidate.id === dep)?.status === "backlog");
  if (parked.length === 0) return;
  const list = parked.join(", ");
  toast(`${task.id} is locked: ${list} ${parked.length === 1 ? "is" : "are"} still in Backlog`, "warning", {
    label: `Move ${parked.length === 1 ? list : `${parked.length} tasks`} to Todo`,
    run: async () => {
      try {
        for (const dep of parked) await api.move(target, dep, "todo");
        toast(`Moved ${list} to Todo — ${task.id} unlocks when ${parked.length === 1 ? "it reaches" : "they reach"} review`, "success");
      } catch (error) {
        toast(describe(error), "error");
      } finally {
        await loadBoard(target);
      }
    },
  });
}
