//! Dependency DAG: cycle rejection, readiness under a chain gate.

use crate::error::{Error, Result};
use crate::model::{ChainGate, Status, Task};

/// Why a task is not ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked {
    /// Dependency ids that have not reached the gate, with their status.
    pub pending: Vec<(String, Option<Status>)>,
}

impl Blocked {
    pub fn describe(&self, gate: ChainGate) -> String {
        let items: Vec<String> = self
            .pending
            .iter()
            .map(|(id, status)| match status {
                Some(status) => format!("{id} ({status})"),
                None => format!("{id} (missing)"),
            })
            .collect();
        format!(
            "waiting for {} to reach {}",
            items.join(", "),
            gate.as_str()
        )
    }
}

/// A task is ready when it is an unclaimed todo whose deps all reached the gate.
/// Cancelled and missing deps block.
pub fn blocked_by(task: &Task, by_id: &dyn Fn(&str) -> Option<Task>, gate: ChainGate) -> Option<Blocked> {
    if task.status != Status::Todo || task.is_claimed() {
        return None;
    }
    let pending: Vec<(String, Option<Status>)> = task
        .deps
        .iter()
        .filter_map(|dep| {
            let status = by_id(dep).map(|task| task.status);
            match status {
                Some(status) if gate.satisfied_by(status) => None,
                other => Some((dep.clone(), other)),
            }
        })
        .collect();
    if pending.is_empty() {
        None
    } else {
        Some(Blocked { pending })
    }
}

/// Dependencies that cannot progress on their own: still in Backlog (the runner
/// never claims Backlog) or missing. A task waiting on these is "locked" until a
/// human schedules the dependency — distinct from waiting on work in flight.
pub fn locked_by(task: &Task, by_id: &dyn Fn(&str) -> Option<Task>, gate: ChainGate) -> Vec<String> {
    match blocked_by(task, by_id, gate) {
        None => Vec::new(),
        Some(blocked) => blocked
            .pending
            .into_iter()
            .filter(|(_, status)| matches!(status, None | Some(Status::Backlog)))
            .map(|(id, _)| id)
            .collect(),
    }
}

pub fn is_ready(task: &Task, by_id: &dyn Fn(&str) -> Option<Task>, gate: ChainGate) -> bool {
    task.status == Status::Todo && !task.is_claimed() && blocked_by(task, by_id, gate).is_none()
}

/// Reject a dep that would close a cycle. `new_dep` is the id being added to
/// `task_id`'s deps.
pub fn check_cycle(tasks: &[Task], task_id: &str, new_dep: &str) -> Result<()> {
    if task_id == new_dep {
        return Err(Error::rule(format!(
            "a task cannot depend on itself ({task_id})"
        )));
    }
    // Walking the new dep's transitive deps must never reach task_id.
    let mut stack = vec![new_dep.to_string()];
    let mut seen = Vec::new();
    while let Some(current) = stack.pop() {
        if current == task_id {
            return Err(Error::rule(format!(
                "link would create a cycle: {task_id} → {new_dep} → … → {task_id}"
            )));
        }
        if seen.contains(&current) {
            continue;
        }
        seen.push(current.clone());
        if let Some(task) = tasks.iter().find(|task| task.id == current) {
            for dep in &task.deps {
                stack.push(dep.clone());
            }
        }
    }
    Ok(())
}

/// Detect cycles anywhere in the graph (used by `validate`).
pub fn find_cycles(tasks: &[Task]) -> Vec<String> {
    let mut cycles = Vec::new();
    for task in tasks {
        let mut stack = task.deps.clone();
        let mut seen = Vec::new();
        while let Some(current) = stack.pop() {
            if current == task.id {
                cycles.push(task.id.clone());
                break;
            }
            if seen.contains(&current) {
                continue;
            }
            seen.push(current.clone());
            if let Some(next) = tasks.iter().find(|candidate| candidate.id == current) {
                stack.extend(next.deps.iter().cloned());
            }
        }
    }
    cycles.sort();
    cycles.dedup();
    cycles
}
