# @pi-unipi/utility

The settings hub, automatic session naming, image tools, pasted-file attachments, `/unipi:answer`, and a few maintenance commands. Also keeps the shared model cache every other module's model picker reads.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:settings [search]` | Configure every UniPi module in one panel (global + project scopes); a search term opens it filtered (`/unipi:settings image`). Typing `/settings` lists it before pi's own `/settings` |
| `/unipi:continue` (`/unipi:retry`) | Take another turn from where the agent stopped, without adding text |
| `/unipi:cleanup` | Remove stale UniPi temp files and leftovers. Shows what it would remove and asks first; `--dry-run` only lists, `--yes` skips the question |
| `/unipi:doctor` | Check folders, config, the model cache, the Decision Model key and skill exposure |
| `/unipi:answer` (`editor`\|`web`) | Answer the questions in the agent's last reply without scrolling |

Skill exposure and the skill manager live in `@pi-unipi/skill-registry` (`/unipi:skills`).

The agent gets the three image tools (below) and nothing else from this package.

## Automatic session naming

After each round that finished normally, if you typed the prompt:

1. Greetings, thanks, "ok", "continue" and slash commands are skipped outright.
2. jev (the Decision Model) answers two short questions: is this a real request with its own subject, and — if the session already has a name — does it move to a different task? Only a confident "yes" renames.
3. The name is written by a separate throwaway session whose only tool is `rename_session`. It sees the current name and your last few requests, nothing else, and never touches the main session.

A name you set yourself with pi's `/name` is never overwritten. Without a Decision Model key, only an unnamed session gets named, on its first prompt of four words or more.

Inside Herdr, the name is also shown as the pane title and, while the tab still has its default number, the tab label.

Settings (`/unipi:settings` → Utility → Session name): auto-rename on/off, naming model (defaults to the session model), Herdr sync, and a **Rename now** action.

## Answering questions

`/unipi:answer` collects every question in the agent's last reply (lines with a `?`, outside code blocks) and opens one of two answer screens. Settings → Utility → Answer picks the default; `/unipi:answer editor` or `/unipi:answer web` overrides it once.

- **editor** — pi's editor holding only `Q1. … / A1:` pairs (empty when the reply has no questions). The cursor starts on the first answer, Tab / Shift+Tab jump between answers, Ctrl+G opens your `$EDITOR`, Enter sends.
- **web** — a local page with the full reply on the left and one box per question on the right (plus a free-text note). It listens on 127.0.0.1 behind a random URL. Over SSH it doesn't open a browser; it shows the `ssh -L` command to forward the port (47321 unless you set one) and the URL to open on your own machine.

Either way, one message is sent that quotes each question above its answer; empty answers are listed as not answered.

## Pasted images and files

Paste a screenshot (Ctrl+V), drag a file into the terminal, or paste a path, and the path in the editor becomes a token: `[Image #1]` for PNG/JPEG/GIF/WebP, `[File #2]` for documents (PDF, text, office files, archives, media). A chip row above the editor lists what's attached, with small previews in terminals that can draw images (Kitty, Ghostty, iTerm2, WezTerm).

When you send:
- Images go to the model as real images, in the order their tokens appear.
- File tokens become `[File #2: /path/to/file]` so the agent can read them.
- A line under your message in the transcript shows what was attached; the model doesn't see it.

Delete a token to drop its attachment. Only paths that arrive by paste, drop or Ctrl+V are converted; a path you type stays text. Settings → Utility → Attachments turns this or the previews off.

## Image tools

| Tool | What it does |
|------|--------------|
| `image_generate` | Text → image |
| `image_edit` | Image + text → image |
| `image_recognize` | Image → text with a vision model; only offered while the session model can't see images itself |

Settings → Image has one section per tool. Each model picker only lists models that fit: generation shows models whose output includes images, editing shows models that take an image and output one, recognition shows vision models. The list comes from the shared model cache: pi's registry, OpenRouter's image models (refreshed daily), and a few fal models when a fal key is set.

How a model is called depends on its provider:

| Model | Sent to | Key |
|-------|---------|-----|
| `openrouter/…` | OpenRouter (chat with image output) | Settings → Image → Keys, else pi's `/login`, else `OPENROUTER_API_KEY` |
| `fal/…` | fal.run | Settings → Image → Keys, else `FAL_KEY` / `FAL_API_KEY` |
| any other pi provider | that provider's endpoint (OpenAI images format) | pi's key for that provider |
| anything, with a **custom endpoint** set | your base URL, model id sent as typed, format of your choice (OpenAI images, OpenRouter-style, fal) | the endpoint's own key |

Defaults are FLUX.2 [klein] 4B on OpenRouter for both generation and editing, which is cheap and fast. Images are returned inline and saved to `~/.unipi/images/`. When a call fails, the tool reports it as a failure with the missing key or setting spelled out.

## Response formatting

Settings → Utility → Response formatting → Style changes how pi's built-in `read`, `bash`, `edit` and `write` calls look in the transcript. The model sees exactly the same tools either way; only the drawing changes. It applies after `/reload` or in a new session.

- **simple** — one line per tool, output collapsed:
  ```
  ▪ Read   ./demo/app.py · 5 lines
  ▪ Edited ./demo/app.py · +1 -1
  ▪ Ran    cd demo && ls -la && python3 app.py · 7 output lines
  ```
- **regular** (default) — pi's own rendering, untouched.
- **advanced** —
  - Commands are syntax-highlighted. Code embedded in a command is highlighted in its own language: heredoc bodies (`python - <<'PY'`, `cat > x.ts <<EOF`) and `python -c` / `node -e` strings.
  - Output shows its last 10 lines. Whole-output JSON is pretty-printed, test-run summaries (node:test, vitest, cargo, pytest) get a ✓/✗ line, and an exit line shows the code and time.
  - Edits show as a diff with line numbers, syntax colouring by file type, and tinted added/removed lines.
  - Writes and reads are highlighted by file type.

Ctrl+O expands anything collapsed in every style.

## Model cache

On every session start, utility writes pi's live model list (models with credentials) to `~/.unipi/config/models-cache.json`, with each model's input and output modalities. The settings hub pickers and kanboard read it; `readModelCache()` / `filterModels()` in `@pi-unipi/core` give the same list to any module.

## Cleanup safety

`/unipi:cleanup` can only remove what its allowlist names: saved tool outputs and `unipi-*` temp files older than 7 days, and the old compactor continuity database. Memory, v2 backups, kanboard boards, config and workspace state are never candidates.

## License

MIT
