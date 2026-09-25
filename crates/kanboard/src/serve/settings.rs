//! Panel settings, stored server-side at `<home>/settings.json` so every
//! browser that opens this daemon sees the same agent command and summary
//! instruction.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store::{Layout, write_atomic};

/// The built-in prompt for "Summarize & archive" — kept in its own file so it
/// reads like the document it is.
pub const DEFAULT_SUMMARY_INSTRUCTION: &str = include_str!("summary-instruction.md");

/// The fixed style tail summarize() always appends after the (default or
/// custom) instruction — deliberately no URLs or skill references so the agent
/// never goes looking for anything.
pub const SUMMARY_STYLE: &str = "Style: plain words only. No inflated words like \"robust\", \"seamless\" or \"significant\", no em dashes, no bold, no filler or hedging. Do not invent anything: every name, number and claim must come from the tasks below; if a detail is missing, leave it out.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PanelSettings {
    /// How to invoke pi for summaries: `[execPath, argv1?]` — argv1 is the
    /// script when pi runs under node, absent for a compiled binary. Written
    /// by the extension on session start; legacy `agentCommand` is ignored.
    #[serde(rename = "piCommand", default)]
    pub pi_command: Vec<String>,
    /// The user's available models as "provider/id" (whitelist for
    /// `summaryModel` — remote binds stay safe because only these pass).
    #[serde(rename = "models", default)]
    pub models: Vec<String>,
    /// Model for summarize runs; empty = pi's default.
    #[serde(rename = "summaryModel", default)]
    pub summary_model: String,
    /// Custom instruction for the summarize prompt; empty/whitespace = default.
    #[serde(rename = "summaryInstruction", default)]
    pub summary_instruction: String,
}

impl PanelSettings {
    /// The instruction actually used: the configured one, or the default.
    pub fn effective_instruction(&self) -> &str {
        if self.summary_instruction.trim().is_empty() {
            DEFAULT_SUMMARY_INSTRUCTION
        } else {
            &self.summary_instruction
        }
    }
}

pub fn path(layout: &Layout) -> PathBuf {
    layout.home.join("settings.json")
}

/// Missing or unreadable settings fall back to defaults.
pub fn load(layout: &Layout) -> PanelSettings {
    std::fs::read_to_string(path(layout))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(layout: &Layout, settings: &PanelSettings) -> Result<()> {
    write_atomic(
        &path(layout),
        &format!("{}\n", serde_json::to_string_pretty(settings)?),
    )
}
