//! The daemon embeds its web UI from `ui-dist/` (rust-embed, src/serve/assets.rs).
//! Since UNI-117 that is the UniPi app's web build; `scripts/build-ui.mjs`
//! fills it (env dir → unipi-app checkout → pinned published build → the old
//! `web/` UI with a warning). When `ui-dist` is missing we run that script once
//! so a plain `cargo build` works; without Node it fails with instructions.

use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=ui-dist/index.html");
    println!("cargo:rerun-if-changed=ui-dist/.source.json");
    println!("cargo:rerun-if-env-changed=UNIPI_KANBOARD_UI_DIST");

    let index = Path::new("ui-dist/index.html");
    if !index.exists() {
        let status = Command::new("node")
            .args(["scripts/build-ui.mjs", "--if-missing"])
            .status();
        match status {
            Ok(status) if status.success() => {}
            Ok(status) => panic!(
                "building the kanboard web UI failed ({status}); run `node crates/kanboard/scripts/build-ui.mjs` (see its header for the sources)"
            ),
            Err(error) => panic!(
                "ui-dist/ is missing and Node isn't available to build it ({error}); run `node crates/kanboard/scripts/build-ui.mjs` first"
            ),
        }
    }
    if !index.exists() {
        panic!(
            "ui-dist/index.html is still missing; run `node crates/kanboard/scripts/build-ui.mjs`"
        );
    }

    // Which UI got embedded: reported by /api/health as `ui`.
    let source = std::fs::read_to_string("ui-dist/.source.json").unwrap_or_default();
    let field = |name: &str| -> String {
        let key = format!("\"{name}\":");
        source
            .find(&key)
            .map(|at| source[at + key.len()..].trim_start())
            .and_then(|rest| rest.strip_prefix('"'))
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("")
            .to_string()
    };
    let kind = match field("source").as_str() {
        "" => "unknown".to_string(),
        other => other.to_string(),
    };
    println!("cargo:rustc-env=KANBOARD_UI_SOURCE={kind}");
    println!("cargo:rustc-env=KANBOARD_UI_VERSION={}", field("version"));
    if kind == "legacy" {
        println!(
            "cargo:warning=embedding the deprecated kanboard web UI (crates/kanboard/web); build unipi-app or pin a published web build — see crates/kanboard/scripts/build-ui.mjs"
        );
    }
}
