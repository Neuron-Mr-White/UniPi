# Topcoat spike — findings (K1, throwaway)

Question: can [Topcoat](https://github.com/tokio-rs/topcoat) (crates.io `topcoat`,
tokio-rs, early-stage) serve the kanboard v3 UI? This directory is a spike, **not**
a dependency of `crates/kanboard` and not part of the product.

- Version tested: **topcoat 0.8.1** (crates.io), `rust-version = "1.98"`, MIT.
- Toolchain: rustc/cargo **1.98.1**.
- Demo: two lanes (Todo, In Progress), server-rendered cards, HTML5 drag & drop
  between lanes, SSE stream that notifies the client on every board revision.
- Caveat: agent-reported, host-verified only where stated. The demo runs from
  `cargo run` (see "How to re-run").

## Verdict per question

| # | Question | Verdict | Evidence |
|---|---|---|---|
| a | Embed in our own axum app / run on a listener we choose | **Yes** (listener: proven; axum: API-supported, not wired here) | `topcoat::serve(listener, router)` takes any `Listener`; the demo binds `127.0.0.1:0` itself and prints the OS-assigned port: `spike listening on http://127.0.0.1:11737`. `Router::handle(Request) -> Response` exists for hosts that receive requests themselves (docs/router.md: *"Serving is the only part … behind the `serve` feature … `Router::handle` turns a Request into a Response directly, with no listener involved"*), which is what an axum handler would call — it needs a request/response type conversion, so I did not wire it in the hour. |
| b | Board page with drag between lanes | **Yes** | Cards render with `draggable="true" data-id=N`; ~15 lines of plain JS (`dragstart` → `fetch POST /move` → swap `innerHTML`) move a card; the POST returns the **server-rendered fragment**: after moving KS-3 to Todo the fragment reports `todo: [1,2,3]`, `in_progress: []`. No client build, no wasm. Topcoat's own `$()`/`#[shard]` reactivity would also work (finer-grained, and it keeps state in signals) but it needs the runtime asset (see d). |
| c | Live updates pushed from the server when files change | **Yes** | `#[route(GET "/events")]` returns `Sse<impl Stream<Item = Result<Event>>>`; a background tokio task bumps a revision and broadcasts. `curl -N /events` shows `: connected` then `data: 2`, `data: 3`, `data: 4` five seconds apart; the client `EventSource` refetches the fragment on each event. Topcoat also ships a **websocket** feature and a **datastar** integration (SSE element/signal patching) if we want the server to push HTML directly; the demo pushes a revision and re-fetches, which keeps rendering context-free. |
| d | Single static binary, no extra assets/build steps | **Partly — this is the real caveat.** Proven: the paths used in the demo (`page`, `route`, `view!`, `Sse`) need **no build step, no assets, no extra files** — `cargo build` and run. Broken: anything using the client runtime (`$()`, `#[shard]`) must load `AssetBundle::load()`, and without a bundle the router builder **panics** (reproduced): `asset bundle: Custom { kind: NotFound, error: "no asset bundle at …/target/debug/assets" }`. The bundle is produced by the `topcoat` CLI (`topcoat asset bundle`, Rust-only — not a JS toolchain), i.e. an extra build step and an `assets/` directory deployed next to the binary. | 
| e | Binary size and compile time | **Acceptable for a daemon we ship per platform** | Debug build 9.1 s cold; **release build 9.8 s**, binary **5.3 MB** (spike profile has no `lto`/`strip`; our kanboard crate's profile already sets both, which would cut it further). Dynamically linked against libc/libgcc/libm — a fully static binary needs the usual `musl` / `+crt-static` target flag. For comparison: the kanboard core crate is 1.5 MB stripped. |

## Things that matter for K2 (if we adopt it)

1. **Edition 2024 is required in practice.** Components/pages returning
   `impl View` fail to compile under **edition 2021** with
   `error[E0700]: hidden type for impl View captures lifetime '__a ...`
   (the 2024 RPIT capture rules make it compile). The crate's MSRV is 1.98, and
   `cargo new` defaults to edition 2024 — but an existing edition-2021 crate
   (like `crates/kanboard`) cannot host these functions; the UI crate must be
   edition 2024.
2. **Feature selection is meaningful.** `default-features = false, features =
   ["router","serve","view","sse","discover"]` was enough for the whole demo —
   notably without `runtime`, `asset`, `tailwind`, `font`, or `icon`. Skipping
   `tailwind`/`asset` is what keeps a single-binary build possible.
3. **Fragments are the natural unit.** `view! { cx => component() }.single().await?`
   yields a `ViewHandle` that can be returned from a plain route — exactly the
   "re-render one lane, swap it in" shape the board needs (detail drawer, drag,
   comment boxes). K2 does not need a client framework for the first version.
4. **No `View -> String` helper is public**, so "render a fragment inside a
   background task / SSE stream" needs a request context (`cx`); push a small
   event and let the client fetch the fragment, or use the datastar integration.
5. The framework is early-stage (0.8.x, API moving); pin the version and expect
   breakage on minor upgrades.

## How to re-run

```bash
cd crates/kanboard-topcoat-spike
cargo run                     # prints "spike listening on http://127.0.0.1:<port>"
curl -s  http://127.0.0.1:<port>/ | head -c 400
curl -s  http://127.0.0.1:<port>/board | head -c 200
curl -s -X POST http://127.0.0.1:<port>/move -H 'content-type: application/json' \
     -d '{"id":3,"lane":"todo"}'
curl -sN http://127.0.0.1:<port>/events | head -6      # live pushes every 5s
```

Open the URL in a browser to drag cards between lanes.
