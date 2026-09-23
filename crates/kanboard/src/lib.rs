//! unipi kanboard v3 — task storage, transition rules, dependency graph, CLI.
//!
//! The library is what K2's daemon reuses: the CLI is a thin wrapper over these
//! functions, so the UI and the terminal enforce exactly the same rules.

pub mod board;
pub mod cli;
pub mod commands;
pub mod deps;
pub mod error;
pub mod format;
pub mod model;
pub mod order;
pub mod run;
pub mod store;
pub mod transitions;

pub use error::{Error, Problem, Result};
pub use model::{Actor, ChainGate, Priority, RunMode, Status, Task};
pub use store::{Layout, Project};
