//! Sparse ordering inside a lane, with rebalancing when gaps run out.

use crate::error::Result;
use crate::model::Task;

pub const STEP: i64 = 1000;

/// Midpoint between two neighbours, or `None` when the gap is exhausted.
pub fn midpoint(prev: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (prev, next) {
        (None, None) => Some(STEP),
        (None, Some(next)) => Some(next - STEP),
        (Some(prev), None) => Some(prev + STEP),
        (Some(prev), Some(next)) => {
            if next - prev < 2 {
                None
            } else {
                Some(prev + (next - prev) / 2)
            }
        }
    }
}

/// Lane tasks in display order: order asc, then id for stability.
pub fn lane<'a>(tasks: impl IntoIterator<Item = &'a Task>) -> Vec<&'a Task> {
    let mut lane: Vec<&Task> = tasks.into_iter().collect();
    lane.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    lane
}

/// Rewrite a lane's orders as STEP, 2*STEP, … Returns (id, new order) pairs.
pub fn rebalance(lane: &[&Task]) -> Vec<(String, i64)> {
    lane.iter()
        .enumerate()
        .map(|(index, task)| (task.id.clone(), (index as i64 + 1) * STEP))
        .collect()
}

/// Where a new task lands: bottom of the lane.
pub fn bottom_of(lane: &[&Task]) -> i64 {
    lane.last().map(|task| task.order + STEP).unwrap_or(STEP)
}

/// Position for `--before ID`; `None` = no room left, rebalance first.
pub fn before(lane: &[&Task], target: &str) -> Result<Option<i64>> {
    let index = index_of(lane, target)?;
    let prev = if index == 0 {
        None
    } else {
        Some(lane[index - 1].order)
    };
    Ok(midpoint(prev, Some(lane[index].order)))
}

/// Position for `--after-pos ID`; `None` = no room left, rebalance first.
pub fn after(lane: &[&Task], target: &str) -> Result<Option<i64>> {
    let index = index_of(lane, target)?;
    let next = lane.get(index + 1).map(|task| task.order);
    Ok(midpoint(Some(lane[index].order), next))
}

fn index_of(lane: &[&Task], target: &str) -> Result<usize> {
    lane.iter()
        .position(|task| task.id == target)
        .ok_or_else(|| {
            crate::error::Error::not_found(format!("task {target} not found in that lane"))
        })
}
