//! Task attachments: files stored beside the board and referenced from markdown.
//!
//! Layout: `projects/<slug>/attachments/<TASK-ID>/<sha8>-<safe-name>`.
//! A reference is ordinary markdown with the `att:` scheme —
//! `![shot.png](att:ATL-5/1a2b3c4d-shot.png)` — so the task file format does not
//! change, comments and descriptions carry attachments as plain text, and the
//! same text renders in the UI (image / player / file chip) and reads fine in a
//! terminal.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::store::Layout;

/// Upload ceiling (bytes). Screenshots, logs, short recordings — not artefact storage.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Stored file name (`<sha8>-<safe-name>`).
    pub name: String,
    /// The original name the user gave it.
    pub original: String,
    /// `att:<TASK>/<name>` — what goes into markdown.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Absolute path (agents read attachments straight from disk).
    pub path: String,
    pub size: u64,
    pub mime: String,
    /// image | video | audio | pdf | text | file — how the UI renders it.
    pub kind: String,
    /// Ready-to-paste markdown (`![…](att:…)` for images, `[…](att:…)` otherwise).
    pub markdown: String,
}

pub fn dir(layout: &Layout, slug: &str, task_id: &str) -> PathBuf {
    layout.project_dir(slug).join("attachments").join(task_id)
}

/// Keep letters, digits, `.`, `-`, `_`; collapse the rest to `-`; bounded length.
pub fn safe_name(original: &str) -> String {
    let base = Path::new(original)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|ch| ch == '-' || ch == '.').to_string();
    let name = if trimmed.is_empty() { "file".to_string() } else { trimmed };
    if name.len() <= 80 {
        return name;
    }
    // keep the extension when shortening
    match name.rsplit_once('.') {
        Some((stem, ext)) if ext.len() <= 10 => format!("{}.{ext}", &stem[..stem.len().min(79 - ext.len())]),
        _ => name[..80].to_string(),
    }
}

pub fn kind_of(mime: &str, name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if mime.starts_with("image/") && !mime.contains("svg") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime == "application/pdf" {
        "pdf"
    } else if (mime.starts_with("text/") && !matches!(mime, "text/html" | "text/xml" | "text/javascript"))
        || mime == "application/json"
        || [".log", ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".toml", ".diff", ".patch"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    {
        "text"
    } else {
        "file"
    }
}

pub fn mime_of(name: &str) -> String {
    mime_guess::from_path(name).first_or_octet_stream().essence_str().to_string()
}

fn describe(layout: &Layout, slug: &str, task_id: &str, name: &str) -> Result<Attachment> {
    let path = dir(layout, slug, task_id).join(name);
    let meta = fs::metadata(&path).map_err(|_| Error::not_found(format!("attachment {task_id}/{name} not found")))?;
    let original = name.split_once('-').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| name.to_string());
    let mime = mime_of(name);
    let kind = kind_of(&mime, name).to_string();
    let reference = format!("att:{task_id}/{name}");
    let label = original.replace(['[', ']'], "");
    let markdown = if kind == "image" {
        format!("![{label}]({reference})")
    } else {
        format!("[{label}]({reference})")
    };
    Ok(Attachment {
        name: name.to_string(),
        original,
        reference,
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        mime,
        kind,
        markdown,
    })
}

/// Store bytes for a task. Identical content under the same name is stored once.
pub fn store(layout: &Layout, slug: &str, task_id: &str, original: &str, bytes: &[u8]) -> Result<Attachment> {
    if bytes.is_empty() {
        return Err(Error::usage("attachment is empty"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Error::usage(format!(
            "attachment is {} MB — the limit is {} MB",
            bytes.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }
    let digest = Sha256::digest(bytes);
    let hash: String = digest.iter().take(4).map(|byte| format!("{byte:02x}")).collect();
    let name = format!("{hash}-{}", safe_name(original));
    let folder = dir(layout, slug, task_id);
    fs::create_dir_all(&folder)?;
    let path = folder.join(&name);
    if !path.exists() {
        let tmp = folder.join(format!(".{name}.tmp-{}", std::process::id()));
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path).map_err(|err| Error::Io(format!("cannot store {}: {err}", path.display())))?;
    }
    describe(layout, slug, task_id, &name)
}

/// Resolve a stored attachment, refusing anything that is not a plain file name.
pub fn resolve(layout: &Layout, slug: &str, task_id: &str, name: &str) -> Result<Attachment> {
    let plain = |part: &str| !part.is_empty() && !part.starts_with('.') && !part.contains(['/', '\\']) && part != "..";
    if !plain(task_id) || !plain(name) {
        return Err(Error::usage("invalid attachment path"));
    }
    describe(layout, slug, task_id, name)
}

pub fn list(layout: &Layout, slug: &str, task_id: &str) -> Vec<Attachment> {
    let Ok(entries) = fs::read_dir(dir(layout, slug, task_id)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names
        .iter()
        .filter_map(|name| describe(layout, slug, task_id, name).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitised_and_bounded() {
        assert_eq!(safe_name("Screen Shot 2026-09-24 at 10.00.png"), "Screen-Shot-2026-09-24-at-10.00.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("日本語.txt"), "txt");
        assert_eq!(safe_name(""), "file");
        let long = format!("{}.log", "a".repeat(200));
        let short = safe_name(&long);
        assert!(short.len() <= 80 && short.ends_with(".log"), "{short}");
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_of("image/png", "a.png"), "image");
        assert_eq!(kind_of("image/svg+xml", "a.svg"), "file", "svg is never inlined");
        assert_eq!(kind_of("video/mp4", "a.mp4"), "video");
        assert_eq!(kind_of("application/pdf", "a.pdf"), "pdf");
        assert_eq!(kind_of("application/octet-stream", "build.log"), "text");
        assert_eq!(kind_of("application/zip", "a.zip"), "file");
        assert_eq!(kind_of("text/html", "a.html"), "file", "markup is downloaded, never previewed");
    }
}
