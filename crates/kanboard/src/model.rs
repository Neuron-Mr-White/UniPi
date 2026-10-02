//! Domain model: statuses, priorities, actors, run metadata, tasks, activity.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serializer;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use crate::error::{Error, Result};

/// JSON dates use the same second-precision form as the task files.
pub(crate) fn serialize_iso<S: Serializer>(
    value: &DateTime<Utc>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
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

    /// Sort weight — `next` suggests priority desc, then order asc.
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
pub enum Strategy {
    None,
    Goal,
    Ralph,
    Swarm,
    Graph,
}

impl Strategy {
    pub const ALL: [Strategy; 5] = [
        Strategy::None,
        Strategy::Goal,
        Strategy::Ralph,
        Strategy::Swarm,
        Strategy::Graph,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::None => "none",
            Strategy::Goal => "goal",
            Strategy::Ralph => "ralph",
            Strategy::Swarm => "swarm",
            Strategy::Graph => "graph",
        }
    }
}

impl fmt::Display for Strategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Strategy {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "none" => Ok(Strategy::None),
            "goal" => Ok(Strategy::Goal),
            "ralph" => Ok(Strategy::Ralph),
            "swarm" => Ok(Strategy::Swarm),
            "graph" => Ok(Strategy::Graph),
            other => Err(format!("unknown strategy {other:?} (none|goal|ralph|swarm|graph)")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    #[serde(alias = "direct")]
    None,
    Plan,
    Goal,
    Ralph,
    Swarm,
    Graph,
}

impl RunMode {
    pub const ALL: [RunMode; 6] = [
        RunMode::None,
        RunMode::Plan,
        RunMode::Goal,
        RunMode::Ralph,
        RunMode::Swarm,
        RunMode::Graph,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RunMode::None => "none",
            RunMode::Plan => "plan",
            RunMode::Goal => "goal",
            RunMode::Ralph => "ralph",
            RunMode::Swarm => "swarm",
            RunMode::Graph => "graph",
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
        // `direct` is the pre-CP3.5 name for `none` — kept for old files.
        let value = if value == "direct" { "none" } else { value };
        RunMode::ALL
            .into_iter()
            .find(|mode| mode.as_str() == value)
            .ok_or_else(|| {
                Error::usage(format!(
                    "unknown mode \"{value}\" (expected none|plan|goal|ralph|swarm|graph)"
                ))
            })
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
            // Archived counts: the task was accepted before archiving — and a
            // cold-storage dep resolves with its frozen status.
            ChainGate::InReview => {
                matches!(status, Status::InReview | Status::Done | Status::Archived)
            }
            ChainGate::Done => matches!(status, Status::Done | Status::Archived),
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
            .ok_or_else(|| {
                Error::usage(format!(
                    "unknown chain gate \"{value}\" (expected in_review|done)"
                ))
            })
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
    /// Who holds the claim: the agent itself (`start`) or `system` — the
    /// default, found only in files written before the headless runner was
    /// removed. Only agent claims can be `finish`ed.
    #[serde(default)]
    pub owner: RunOwner,
}

/// Who took a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOwner {
    /// Legacy: a system claim from before the runner was removed (old task
    /// files still carry it). Nothing creates these any more; the reaper or a
    /// user `release` hands them back.
    #[default]
    System,
    /// The agent self-claimed it (`start`); it moves it on with `finish`.
    Agent,
}

impl RunOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            RunOwner::System => "system",
            RunOwner::Agent => "agent",
        }
    }
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
    /// The claiming session, recorded for agent writes (`[agent:<session>]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
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
    /// Legacy `strategy:` frontmatter from the removed runner's routing. Kept
    /// only so old task files parse and re-render byte-for-byte (canonical
    /// form); never set by commands and not part of the JSON output.
    #[serde(default, skip_serializing)]
    pub strategy: Option<Strategy>,
    /// Legacy `plan:` frontmatter (same as `strategy`: read and re-rendered,
    /// never exposed).
    #[serde(default, skip_serializing)]
    pub plan: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
    /// Who created the task — set once at creation, never written again
    /// (UNI-59). `None` only for files written before the field existed; the
    /// display falls back to the first activity entry's actor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<Actor>,
    /// Everything between the frontmatter and `## Activity`.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub activity: Vec<ActivityEntry>,
}

impl Task {
    pub fn new(
        id: String,
        title: String,
        status: Status,
        priority: Priority,
        order: i64,
        now: DateTime<Utc>,
    ) -> Self {
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
            strategy: None,
            plan: None,
            run: None,
            creator: None,
            body: String::new(),
            activity: Vec::new(),
        }
    }

    /// The creator to display: the persisted field, else the first activity
    /// entry's actor (older files), else user.
    pub fn creator_of(&self) -> Actor {
        self.creator.unwrap_or_else(|| {
            self.activity
                .first()
                .map(|entry| entry.actor)
                .unwrap_or(Actor::User)
        })
    }

    pub fn push_activity(&mut self, at: DateTime<Utc>, actor: Actor, text: impl Into<String>) {
        self.push_activity_session(at, actor, None, text);
    }

    /// Same as `push_activity`, tagging the entry with the acting session.
    /// The tag renders only for agents (`[agent:<session>]`).
    pub fn push_activity_session(
        &mut self,
        at: DateTime<Utc>,
        actor: Actor,
        session: Option<&str>,
        text: impl Into<String>,
    ) {
        self.activity.push(ActivityEntry {
            at,
            actor,
            session: session
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty()),
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

    /// The title shown in listings: the task's own title when it has one, else
    /// a title derived from the first body line that carries text. Attachment
    /// embeds and bare images never become the title.
    pub fn display_title(&self) -> String {
        if !self.title.trim().is_empty() {
            return self.title.clone();
        }
        for line in self.body.lines() {
            let line = line.trim();
            if line.is_empty() || is_embed(line) {
                continue;
            }
            let stripped = strip_leading_markers(line);
            let stripped = stripped.trim();
            if stripped.is_empty() || is_embed(stripped) {
                continue;
            }
            return truncate_chars(stripped, DISPLAY_TITLE_MAX_CHARS);
        }
        "(untitled)".to_string()
    }
}

/// Longest derived title before a `…` is appended (characters, not bytes).
const DISPLAY_TITLE_MAX_CHARS: usize = 80;

/// Lines that are only an attachment embed (`…](att:…)`) or an image
/// (`![label](url)`) carry no title-worthy text.
fn is_embed(line: &str) -> bool {
    if line.contains("](att:") {
        return true;
    }
    let trimmed = line.trim_start_matches('!');
    trimmed.starts_with('[') && line.ends_with(')') && line.contains("](")
}

/// Strip the markdown that prefixes a line: headings and block quotes strip
/// unconditionally; list bullets (`-`, `*`, `+`) and ordered markers (`1.`,
/// `2)`) only when whitespace follows — `-5 degrees` and `3.0 release` are
/// text, not lists. Repeated, so `> - ## done` reduces to `done`.
fn strip_leading_markers(line: &str) -> &str {
    let mut rest = line;
    loop {
        let trimmed = rest.trim_start();
        rest = if let Some(after) = trimmed.strip_prefix('#') {
            after
        } else if let Some(after) = trimmed.strip_prefix('>') {
            after
        } else if let Some(after) = trimmed
            .strip_prefix('-')
            .or_else(|| trimmed.strip_prefix('*'))
            .or_else(|| trimmed.strip_prefix('+'))
        {
            if after.starts_with(char::is_whitespace) {
                after
            } else {
                return rest;
            }
        } else {
            let digits = trimmed.len() - trimmed.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if digits == 0 {
                return rest;
            }
            let after_digits = &trimmed[digits..];
            let Some(after) = after_digits
                .strip_prefix('.')
                .or_else(|| after_digits.strip_prefix(')'))
            else {
                return rest;
            };
            if after.starts_with(char::is_whitespace) {
                after
            } else {
                return rest;
            }
        };
    }
}

/// Char-safe cut: at most `max` characters, a `…` marks the loss.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}\u{2026}")
}
