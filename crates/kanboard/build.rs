//! Guard rail: the web UI is built by a separate `npm` step (crates/kanboard/web)
//! and embedded at compile time. Fail fast with a clear message instead of a
//! confusing embed error.

fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    let dist = std::path::Path::new("web/dist/index.html");
    if !dist.exists() {
        panic!("run `npm --prefix crates/kanboard/web run build` first (web/dist is missing)");
    }
}
