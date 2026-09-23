//! Domain model: statuses, priorities, actors, run metadata, tasks, activity.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serializer;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use crate::error::{Error, Result};

/// JSON dates use the same second-precision form as the task files.
pub(crate) fn serialize_iso<S: Serializer>(value: &DateTime<Utc>, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Lanes. `Archive` is hidden behind a toggle in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Blocked,
    Done,
    Cancelled,
    Archived,
}

impl Status {
    pub const ALL: [Status; 8] = [
        Status::Backlog,
        Status::Todo,
        Status::InProgress,
        Status::InReview,
        Status::Blocked,
        Status::Done,
        Status::Cancelled,
        Status::Archived,
    ];

    /// Visible lanes, in board order.
    pub const VISIBLE: [Status; 7] = [
        Status::Backlog,
        Status::Todo,
        Status::InProgress,
        Status::InReview,
        Status::Blocked,
        Status::Done,
        Status::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Backlog => "backlog",
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::InReview => "in_review",
            Status::Blocked => "blocked",
            Status::Done => "done",
            Status::Cancelled => "cancelled",
            Status::Archived => "archived",
        }
    }

    /// Terminal lanes: nothing may leave them (archive excepted).
    pub fn is_final(self) -> bool {
        matches!(self, Status::Done | Status::Cancelled | Status::Archived)
    }

    /// Ready-to-claim source lane.
    pub fn is_claimable(self) -> bool {
        self == Status::Todo
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Status {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        Status::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
            .ok_or_else(|| {
                Error::usage(format!(
                    "unknown status \"{value}\" (expected {})",
                    Status::ALL
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join("|")
                ))
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    pub const ALL: [Priority; 5] = [
        Priority::None,
        Priority::Low,
        Priority::Medium,
        Priority::High,
        Priority::Urgent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Priority::None => "none",
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Urgent => "urgent",
        }
    }

    /// Sort weight — `claim-next` takes priority desc, then order asc.
    pub fn rank(self) -> u8 {
        match self {
            Priority::None => 0,
            Priority::Low => 1,
            Priority::Medium => 2,
            Priority::High => 3,
            Priority::Urgent => 4,
        }
    }
}

impl fmt::Display for Priority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Priority {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        Priority::ALL
            .into_iter()
            .find(|priority| priority.as_str() == value)
            .ok_or_else(|| {
                Error::usage(format!(
                    "unknown priority \"{value}\" (expected {})",
                    Priority::ALL
                        .iter()
                        .map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join("|")
                ))
            })
    }
}

/// Who is performing an action. The actor is an honour system (see the spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    User,
    Agent,
    System,
}

impl Actor {
    pub const ALL: [Actor; 3] = [Actor::User, Actor::Agent, Actor::System];

    pub fn as_str(self) -> &'static str {
        match self {
            Actor::User => "user",
            Actor::Agent => "agent",
            Actor::System => "system",
        }
    }
}

impl fmt::Display for Actor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Actor {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        Actor::ALL
            .into_iter()
            .find(|actor| actor.as_str() == value)
            .ok_or_else(|| {
                Error::usage(format!(
                    "unknown actor \"{value}\" (expected user|agent|system)"
                ))
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    Direct,
    Plan,
    Goal,
}

impl RunMode {
    pub const ALL: [RunMode; 3] = [RunMode::Direct, RunMode::Plan, RunMode::Goal];

    pub fn as_str(self) -> &'static str {
        match self {
            RunMode::Direct => "direct",
            RunMode::Plan => "plan",
            RunMode::Goal => "goal",
        }
    }
}

impl fmt::Display for RunMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for RunMode {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        RunMode::ALL
            .into_iter()
            .find(|mode| mode.as_str() == value)
            .ok_or_else(|| Error::usage(format!("unknown mode \"{value}\" (expected direct|plan|goal)")))
    }
}

/// Chain gate: which dependency statuses count as "the chain reached this task".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainGate {
    InReview,
    Done,
}

impl ChainGate {
    pub const ALL: [ChainGate; 2] = [ChainGate::InReview, ChainGate::Done];

    pub fn as_str(self) -> &'static str {
        match self {
            ChainGate::InReview => "in_review",
            ChainGate::Done => "done",
        }
    }

    /// Dependency statuses that satisfy the gate. Cancelled is deliberately absent.
    pub fn satisfied_by(self, status: Status) -> bool {
        match self {
            ChainGate::InReview => matches!(status, Status::InReview | Status::Done),
            ChainGate::Done => status == Status::Done,
        }
    }
}

impl fmt::Display for ChainGate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ChainGate {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        ChainGate::ALL
            .into_iter()
            .find(|gate| gate.as_str() == value)
            .ok_or_else(|| Error::usage(format!("unknown chain gate \"{value}\" (expected in_review|done)")))
    }
}

/// The run block, present only while a task is claimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub session: String,
    pub pid: u32,
    pub host: String,
    pub mode: RunMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(serialize_with = "serialize_iso")]
    pub started: DateTime<Utc>,
}

/// How a claimed task's process looks from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Staleness {
    /// pid is alive on this host.
    Running,
    /// pid is gone on this host (or a foreign host had its task verified dead).
    Stale,
    /// Claimed on another host: we cannot know.
    Unknown,
}

impl Staleness {
    pub fn as_str(self) -> &'static str {
        match self {
            Staleness::Running => "running",
            Staleness::Stale => "stale",
            Staleness::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEntry {
    #[serde(serialize_with = "serialize_iso")]
    pub at: DateTime<Utc>,
    pub actor: Actor,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    /// Sparse sort key inside a lane.
    pub order: i64,
    pub deps: Vec<String>,
    pub labels: Vec<String>,
    #[serde(serialize_with = "serialize_iso")]
    pub created: DateTime<Utc>,
    #[serde(serialize_with = "serialize_iso")]
    pub updated: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
    /// Everything between the frontmatter and `## Activity`.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub activity: Vec<ActivityEntry>,
}

impl Task {
    pub fn new(id: String, title: String, status: Status, priority: Priority, order: i64, now: DateTime<Utc>) -> Self {
        Task {
            id,
            title,
            status,
            priority,
            order,
            deps: Vec::new(),
            labels: Vec::new(),
            created: now,
            updated: now,
            run: None,
            body: String::new(),
            activity: Vec::new(),
        }
    }

    pub fn push_activity(&mut self, at: DateTime<Utc>, actor: Actor, text: impl Into<String>) {
        self.activity.push(ActivityEntry {
            at,
            actor,
            // Trailing whitespace/newlines would round-trip as blank
            // continuation lines; normalise on the way in.
            text: text.into().trim_end().to_string(),
        });
        self.updated = at;
    }

    /// Text of the activity entries relevant to a fresh claim: unblock answers
    /// and rework notes are what the next agent needs to see.
    pub fn handoff_notes(&self) -> Vec<&ActivityEntry> {
        self.activity
            .iter()
            .filter(|entry| {
                let text = entry.text.to_lowercase();
                text.contains("unblock")
                    || text.contains("rework")
                    || text.contains("blocked")
                    || text.contains("suggest cancel")
            })
            .collect()
    }

    /// Claim is only possible from todo, without an active run.
    pub fn is_claimed(&self) -> bool {
        self.run.is_some()
    }
}
