//! clap definitions for `unipi-kanboard`.

use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

use crate::model::{ChainGate, Priority, RunMode, Status};

#[derive(Debug, Parser)]
#[command(
    name = "unipi-kanboard",
    version,
    about = "unipi kanboard — deferred-work board for a project",
    long_about = "Every write goes through this binary: it validates the task format and transition rules and writes atomically under a per-project lock."
)]
pub struct Cli {
    /// Project slug (defaults to the project registered for the current git root).
    #[arg(long, global = true, value_name = "SLUG")]
    pub project: Option<String>,

    /// Who is acting: user | agent | system (defaults to $UNIPI_KANBOARD_ACTOR, else user).
    #[arg(long, global = true, value_name = "ACTOR")]
    pub actor: Option<String>,

    /// Session identity for claims and the per-session queue
    /// (defaults to $UNIPI_KANBOARD_SESSION).
    #[arg(long, global = true, value_name = "ID")]
    pub session: Option<String>,

    /// Chain gate for readiness: in_review | done.
    #[arg(long, global = true, value_name = "GATE", default_value = "in_review")]
    pub gate: String,

    /// Machine-readable output.
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum SettingsSub {
    /// Print piCommand, the model list and effective limits.
    Show,
    /// Change a setting: `pi-command` (JSON argv), `models` (JSON array),
    /// `summary-model` (provider/id, empty clears).
    Set {
        /// The field name.
        #[arg(value_name = "FIELD")]
        field: String,
        /// The new value (empty string clears).
        #[arg(value_name = "VALUE", default_value = "")]
        value: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Register or inspect projects.
    #[command(subcommand)]
    Project(ProjectCommand),

    /// Create a task (Backlog by default).
    Add {
        /// Task title.
        title: String,
        /// Body text, or `-` to read stdin.
        #[arg(long)]
        body: Option<String>,
        /// Read the body from a file (overrides --body).
        #[arg(long, value_name = "FILE")]
        body_file: Option<PathBuf>,
        /// Attach a file (may repeat); the file's path in the body is replaced
        /// by its attachment markdown.
        #[arg(long, value_name = "FILE")]
        attach: Vec<PathBuf>,
        /// Landing lane.
        #[arg(long, value_name = "backlog|todo")]
        status: Option<String>,
        /// Priority.
        #[arg(long, value_name = "none|low|medium|high|urgent")]
        priority: Option<String>,
        /// Dependency ids (may repeat).
        #[arg(long = "after", value_name = "ID")]
        after: Vec<String>,
    },

    /// List tasks.
    List {
        #[arg(long, value_name = "STATUS")]
        status: Option<String>,
        /// Only tasks whose deps reached the chain gate.
        #[arg(long)]
        ready: bool,
    },

    /// Show one task.
    Show { id: String },

    /// Move a task to another lane.
    Move {
        id: String,
        status: String,
        /// Required for some transitions (rework notes, block/unblock answers).
        #[arg(long)]
        comment: Option<String>,
    },

    /// Append an activity note.
    Note { id: String, text: String },

    /// Attach a file (image, log, document…) to a task and log a comment embedding it.
    Attach {
        id: String,
        /// File to attach.
        file: std::path::PathBuf,
        /// Comment text shown above the attachment.
        #[arg(long)]
        note: Option<String>,
        /// Name to store it under (defaults to the file name).
        #[arg(long)]
        name: Option<String>,
    },

    /// List a task's attachments.
    Attachments { id: String },

    /// Edit task fields.
    Edit {
        id: String,
        #[arg(long)]
        title: Option<String>,
        /// New body, or `-` to read stdin.
        #[arg(long)]
        body: Option<String>,
        #[arg(long, value_name = "PRIORITY")]
        priority: Option<String>,
        /// Comma-separated labels.
        #[arg(long, value_name = "A,B")]
        labels: Option<String>,
    },

    /// Add a dependency.
    Link {
        id: String,
        #[arg(long = "after", value_name = "DEP")]
        after: String,
    },

    /// Remove a dependency.
    Unlink {
        id: String,
        #[arg(long = "after", value_name = "DEP")]
        after: String,
    },

    /// Reposition a task inside its lane.
    Order {
        id: String,
        #[arg(long, value_name = "ID")]
        before: Option<String>,
        #[arg(long = "after-pos", value_name = "ID")]
        after_pos: Option<String>,
        #[arg(long)]
        top: bool,
        #[arg(long)]
        bottom: bool,
    },

    /// Claim the next ready task (system; uses the global --session).
    ClaimNext {
        /// Claim this specific task instead of the top of the queue.
        #[arg(long, value_name = "ID")]
        id: Option<String>,
        #[arg(long)]
        pid: u32,
        #[arg(long)]
        host: String,
        #[arg(long, value_name = "direct|plan|goal", default_value = "direct")]
        mode: String,
    },

    /// Show what claim-next would pick without claiming (read-only).
    Next,

    /// Release in-progress tasks whose session pid is gone (system).
    Reap {
        /// Report what would be released without writing.
        #[arg(long)]
        dry_run: bool,
    },

    /// Append task ids to this session's work queue (at most 5).
    Queue {
        /// Task ids to enqueue; empty with --list shows the queue.
        ids: Vec<String>,
        /// Show the queue instead of appending.
        #[arg(long)]
        list: bool,
    },

    /// Remove task ids from this session's queue (no ids clears it).
    Unqueue { ids: Vec<String> },

    /// Show a task's dependency chain (upstream deps and downstream dependents).
    Chain { id: String },

    /// Case-insensitive search over id, title and body.
    Search {
        text: String,
        /// Include archived tasks.
        #[arg(long)]
        all: bool,
    },

    /// Release a claimed task (system).
    Release {
        id: String,
        #[arg(long = "to", value_name = "todo|in_review|blocked")]
        to: String,
        #[arg(long)]
        comment: String,
    },

    /// Record the mode/goal of a claimed task (system).
    SetRun {
        id: String,
        #[arg(long, value_name = "direct|plan|goal")]
        mode: String,
        #[arg(long)]
        goal: Option<String>,
    },

    /// Copy a task into Backlog.
    Duplicate { id: String },

    /// Archive done/cancelled tasks older than N days.
    ArchiveSweep {
        #[arg(long = "after-days", value_name = "N")]
        after_days: Option<i64>,
        /// Move Archived/Cancelled tasks older than N days into cold storage.
        #[arg(long = "retention-days", value_name = "N")]
        retention_days: Option<i64>,
    },

    /// Start the daemon: UI + JSON API + SSE (single instance).
    Serve {
        /// Bind address: 127.0.0.1 (default, open) or e.g. 0.0.0.0 (token-gated).
        #[arg(long, default_value = "127.0.0.1", value_name = "ADDR")]
        host: String,
        /// Port to bind (0 = let the OS choose).
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Shut down after this many idle minutes with no UI and no clients.
        #[arg(long = "idle-min", value_name = "N")]
        idle_min: Option<u64>,
        /// Hidden: idle seconds instead of minutes (tests).
        #[arg(long = "idle-secs", value_name = "N", hide = true)]
        idle_secs: Option<u64>,
        /// Require the access token on loopback binds too (remote always does).
        #[arg(long = "require-auth")]
        require_auth: bool,
        /// Reuse the token stored in <home>/token so links survive restarts.
        #[arg(long = "keep-token")]
        keep_token: bool,
    },

    /// Show or change board settings (agent command, effective limits).
    Settings {
        #[command(subcommand)]
        sub: SettingsSub,
    },

    /// Drop the persistent access token (the next daemon start mints a fresh one).
    RotateToken,

    /// Show the recorded daemon (pid, port, version) and whether it is alive.
    Status,

    /// Stop the daemon (SIGTERM, waits up to --timeout).
    Stop {
        #[arg(long, default_value_t = 3, value_name = "SECS")]
        timeout: u64,
    },

    /// Check every task file (and the board) for rule violations.
    Validate {
        /// Rewrite canonical formatting where the file is otherwise valid.
        #[arg(long)]
        fix: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum ProjectCommand {
    /// Register a project (defaults to the current git root).
    Add(AddProjectArgs),
    /// List registered projects.
    List,
    /// Show one project and its lane counts.
    Show,
    /// Hide a project from the sidebar/overview (still reachable by URL).
    Archive { slug: String },
    /// Bring an archived project back.
    Unarchive { slug: String },
}

#[derive(Debug, Args)]
pub struct AddProjectArgs {
    #[arg(long, value_name = "PATH")]
    pub root: Option<PathBuf>,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long, value_name = "PREFIX")]
    pub prefix: Option<String>,
}

/// Values clap validates at parse time.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum GateArg {
    #[value(name = "in_review")]
    InReview,
    #[value(name = "done")]
    Done,
}

impl From<GateArg> for ChainGate {
    fn from(value: GateArg) -> Self {
        match value {
            GateArg::InReview => ChainGate::InReview,
            GateArg::Done => ChainGate::Done,
        }
    }
}

pub fn parse_status(value: &str) -> crate::error::Result<Status> {
    value.parse()
}

pub fn parse_priority(value: &str) -> crate::error::Result<Priority> {
    value.parse()
}

pub fn parse_mode(value: &str) -> crate::error::Result<RunMode> {
    value.parse()
}
