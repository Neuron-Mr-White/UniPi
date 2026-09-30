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

// ── pi-side kanboard settings (the unipi "kanboard" namespace) ────────────
//
// The board's Task defaults / session limits / Archive keys live in the same file
// unipi's settings engine uses for the global layer:
// `$HOME/.unipi/config/kanboard/config.json` (a flat JSON object; other
// modules' keys must be preserved on write).

pub const PI_SETTING_KEYS: &[&str] = &[
    "blocking",
    "maxSessions",
    "turnAddLimit",
    "chainGate",
    "archiveAfterDays",
    "retentionDays",
];

pub const BLOCKING: &[&str] = &["avoid", "ask"];
pub const CHAIN_GATES: &[&str] = &["in_review", "done"];

/// `$HOME/.unipi/config/kanboard/config.json` (pi's global settings layer).
/// UNIPI_KANBOARD_HOME is the data dir, not the config home — it is NOT used
/// here so the file lands where the extension actually reads it.
pub fn pi_settings_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".unipi")
            .join("config")
            .join("kanboard")
            .join("config.json")
    })
}

/// Read the raw JSON object (absent/corrupt → empty object).
pub fn load_pi_settings() -> serde_json::Map<String, serde_json::Value> {
    pi_settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Merge-write: only the keys the patch carries change; others survive.
/// tmp+rename via the crate's write_atomic.
pub fn patch_pi_settings(patch: &serde_json::Map<String, serde_json::Value>) -> Result<()> {
    let path = pi_settings_path().ok_or_else(|| crate::error::Error::usage("HOME is not set"))?;
    let mut merged = load_pi_settings();
    for (key, value) in patch {
        merged.insert(key.clone(), value.clone());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(&path, &format!("{}\n", serde_json::to_string_pretty(&merged)?))
}

/// Effective values = stored ⊕ defaults (what GET reports back).
pub fn effective_pi_settings() -> serde_json::Map<String, serde_json::Value> {
    let stored = load_pi_settings();
    let mut out = serde_json::Map::new();
    out.insert(
        "blocking".to_string(),
        stored
            .get("blocking")
            .cloned()
            .filter(|v| v.as_str().is_some_and(|s| BLOCKING.contains(&s)))
            .unwrap_or_else(|| "avoid".into()),
    );
    out.insert(
        "maxSessions".to_string(),
        serde_json::Value::from(stored.get("maxSessions").and_then(|v| v.as_u64()).unwrap_or(2).max(1)),
    );
    out.insert(
        "turnAddLimit".to_string(),
        serde_json::Value::from(stored.get("turnAddLimit").and_then(|v| v.as_u64()).unwrap_or(20)),
    );
    out.insert(
        "chainGate".to_string(),
        stored
            .get("chainGate")
            .cloned()
            .filter(|v| v.as_str().is_some_and(|s| CHAIN_GATES.contains(&s)))
            .unwrap_or_else(|| "in_review".into()),
    );
    out.insert(
        "archiveAfterDays".to_string(),
        serde_json::Value::from(stored.get("archiveAfterDays").and_then(|v| v.as_u64()).unwrap_or(0)),
    );
    out.insert(
        "retentionDays".to_string(),
        serde_json::Value::from(stored.get("retentionDays").and_then(|v| v.as_u64()).unwrap_or(90)),
    );
    out
}

/// Validate a PUT patch into the keys that may be written (enum/number ranges).
pub fn validate_pi_patch(patch: &serde_json::Map<String, serde_json::Value>) -> std::result::Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut out = serde_json::Map::new();
    for (key, value) in patch {
        match key.as_str() {
            "blocking" => {
                let v = value.as_str().ok_or("blocking must be a string")?;
                if !BLOCKING.contains(&v) {
                    return Err(format!("unknown blocking {v:?}"));
                }
                out.insert(key.clone(), value.clone());
            }
            "chainGate" => {
                let v = value.as_str().ok_or("chainGate must be a string")?;
                if !CHAIN_GATES.contains(&v) {
                    return Err(format!("unknown chainGate {v:?}"));
                }
                out.insert(key.clone(), value.clone());
            }
            "turnAddLimit" | "archiveAfterDays" | "retentionDays" => {
                if !value.is_u64() {
                    return Err(format!("{key} must be a non-negative integer"));
                }
                out.insert(key.clone(), value.clone());
            }
            "maxSessions" => {
                let v = value.as_u64().ok_or("maxSessions must be a non-negative integer")?;
                if v < 1 {
                    return Err("maxSessions must be ≥ 1".to_string());
                }
                out.insert(key.clone(), value.clone());
            }
            // Legacy keys (older daemons; the removed runner's routing and
            // queue) — ignored, not rejected, so an older UI can still save.
            "agentCommand" | "defaultStrategy" | "defaultPlan" | "queueMax" => {}
            other => return Err(format!("unknown settings key {other:?}")),
        }
    }
    Ok(out)
}
