//! UNI-57 undo tokens: opaque random tokens backed by daemon-held snapshots.
//! One move mints one token; undo consumes it. Nothing here is reachable from
//! the CLI — undo is a user surface (the web API always acts as `user`) and
//! the store lives in daemon memory, so tokens die with the daemon.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::model::Task;

/// How long an undo token stays valid after its move.
pub const DEFAULT_TTL: Duration = Duration::from_secs(30);

const TOKEN_BYTES: usize = 16;

pub struct UndoEntry {
    pub project: String,
    pub id: String,
    pub before: Task,
    pub after: Task,
    pub created: Instant,
}

#[derive(Debug)]
pub enum UndoRejection {
    /// No such token (unknown, already used, or the daemon restarted).
    Unknown,
    /// Older than the TTL.
    Expired,
    /// Offered for a different task or project (the token survives this).
    WrongTask,
}

pub struct UndoStore {
    entries: Mutex<HashMap<String, UndoEntry>>,
    ttl: Duration,
}

impl Default for UndoStore {
    fn default() -> Self {
        Self::new()
    }
}

impl UndoStore {
    pub fn new() -> Self {
        // Tests shrink the TTL; production uses the fixed 30 seconds.
        let ttl = std::env::var("UNIPI_KANBOARD_UNDO_TTL_SECS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TTL);
        UndoStore {
            entries: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Store one move's snapshots under a fresh opaque token.
    pub fn insert(&self, project: &str, id: &str, before: Task, after: Task) -> String {
        let token = new_token();
        if let Ok(mut entries) = self.entries.lock() {
            // Opportunistic prune: drop expired tokens while we hold the lock.
            entries.retain(|_, entry| entry.created.elapsed() < self.ttl);
            entries.insert(
                token.clone(),
                UndoEntry {
                    project: project.to_string(),
                    id: id.to_string(),
                    before,
                    after,
                    created: Instant::now(),
                },
            );
        }
        token
    }

    /// Atomically consume a token for one (project, id): expiry and unknown
    /// tokens are removed and refused; a token offered for a *different*
    /// task/project is refused but left intact — scoping must not burn the
    /// move's only undo. Everything happens under one lock hold.
    pub fn take(
        &self,
        token: &str,
        project: &str,
        id: &str,
    ) -> Result<UndoEntry, UndoRejection> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| UndoRejection::Unknown)?;
        {
            let entry = entries
                .get(token)
                .ok_or(UndoRejection::Unknown)?;
            if entry.project != project || entry.id != id {
                return Err(UndoRejection::WrongTask);
            }
        }
        let entry = entries
            .remove(token)
            .ok_or(UndoRejection::Unknown)?;
        if entry.created.elapsed() >= self.ttl {
            return Err(UndoRejection::Expired);
        }
        Ok(entry)
    }
}

/// 32 hex chars from OS randomness — opaque, unguessable, no new dependency.
fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("OS randomness for undo tokens");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
