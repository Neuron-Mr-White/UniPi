# Utility

Utility gives UniPi one settings panel, names your sessions, attaches pasted files, and gives the agent image tools.

`@pi-unipi/utility` · part of [UniPi](../../README.md)

## What it does

- Opens one settings hub for every UniPi package (`/unipi:settings`).
- Names the session after a real request starts or changes the topic.
- Lets you answer the questions in the last agent reply without scrolling (`/unipi:answer`).
- Turns pasted or dropped file paths into attachments: `[Image #1]`, `[File #2]`.
- Gives the agent three image tools: generate, edit and recognize.
- Changes how `read`, `bash`, `edit` and `write` calls look in the transcript.

## Quick start

Utility ships in `@pi-unipi/unipi`. To install it alone:

```bash
pi install npm:@pi-unipi/utility
```

1. Type `/unipi:settings` to open the settings hub.
2. Type a search term after the command to filter the hub, for example `/unipi:settings image`.
3. Type `/unipi:doctor` to check the UniPi runtime.

## Commands

| Command | What it does |
|---|---|
| `/unipi:settings [search]` | Opens the settings hub for all UniPi packages. Global and project scopes. |
| `/unipi:continue` | Starts one more agent turn without new text. |
| `/unipi:retry` | Same as `/unipi:continue`. |
| `/unipi:cleanup` | Lists stale UniPi files, then asks before it removes them. `--dry-run` only lists. `--yes` does not ask. |
| `/unipi:doctor` | Checks folders, config files, Node, the model cache, the Decision Model and skill exposure. |
| `/unipi:answer [reply\|questions\|web]` | Opens a screen to answer the last agent reply. |

The skill manager is in [Skill Registry](../skill-registry/README.md) (`/unipi:skills`).

## Agent tools

| Tool | What it does |
|---|---|
| `image_generate` | Makes an image from a text prompt. |
| `image_edit` | Changes an image from a text instruction. The source is a file path, a `data:` URL or base64. |
| `image_recognize` | Describes an image with a vision model. The agent gets this tool only when the session model cannot see images. |

The tools return images inline. `image_generate` and `image_edit` also save files to `~/.unipi/images/`. The default model for both is `openrouter/black-forest-labs/flux.2-klein-4b`.

Utility sends each call to the provider in the model id:

| Model id | Endpoint | Key |
|---|---|---|
| `openrouter/…` | OpenRouter | `keys.openrouter`, then pi `/login`, then `OPENROUTER_API_KEY` |
| `fal/…` | fal.run | `keys.fal`, then `FAL_KEY` or `FAL_API_KEY` |
| other pi provider | that provider, OpenAI images format | pi key for that provider |
| any, with a custom `baseUrl` | your URL, with the format in `api` | the `apiKey` of that endpoint |

## Answer the last reply

`/unipi:answer` has three methods. The `answer.method` setting picks the default. An argument overrides it one time.

- `reply` shows the last reply in a scroll view, with an input box under it. Enter sends your text. Esc goes back to the editor with your draft.
- `questions` fills the editor with `Q1. … / A1:` pairs, one pair for each sentence that ends in `?`. Tab moves to the next answer. Ctrl+G opens `$EDITOR`.
- `web` opens a local form on 127.0.0.1. Over SSH, it does not open a browser. It shows an `ssh -L` command and the URL. Port 47321 is the first try over SSH.

After a reply with questions, a hint line above the editor shows the count. Set `answer.hint` to `false` to hide it.

## Attachments

Paste a screenshot with Ctrl+V, drag a file into the terminal, or paste a path. The path becomes a token in the editor:

- `[Image #N]` for PNG, JPEG, GIF and WebP. Utility sends the image to the model as an image.
- `[File #N]` for other files. Utility sends `[File #N: /path/to/file]`, so the agent can read the file.

Remove a token to remove its attachment. A path that you type stays text. Kitty, Ghostty, iTerm2 and WezTerm show small previews.

## Session names

After each round that ends without an error, Utility can name the session:

1. It skips a round with only a greeting or a short reply and no tool work.
2. jev, the UniPi Decision Model, answers two questions. Did the round start a real task? Did the task change?
3. A separate one-tool session writes the name. It sees only the current name and your last requests.

Utility does not overwrite a name that you set with pi `/name`. If jev does not answer, Utility names only an unnamed session. The round must have tool work or a prompt of 4 or more words. In Herdr, the name also goes to the pane title.

## Settings

Open `/unipi:settings` → Utility, or → Image.

| Key | Default | What it does |
|---|---|---|
| `utility.rename.auto` | `true` | Names the session when the topic starts or changes. |
| `utility.rename.model` | `""` | Model for the naming session. Empty means the session model. |
| `utility.rename.herdrSync` | `true` | Shows the session name as the Herdr pane title and tab label. |
| `utility.answer.method` | `reply` | Default method for `/unipi:answer`. |
| `utility.answer.hint` | `true` | Shows the questions hint above the editor. |
| `utility.answer.port` | `0` | Web form port. `0` means any free port. |
| `utility.attachments.enabled` | `true` | Turns pasted paths into attachments. |
| `utility.attachments.preview` | `true` | Shows inline previews. |
| `utility.render.style` | `regular` | `simple`, `regular` or `advanced` tool rendering. Applies after `/reload`. |
| `image.generate.enabled` | `true` | Gives the agent `image_generate`. Applies after `/reload`. |
| `image.edit.enabled` | `true` | Gives the agent `image_edit`. Applies after `/reload`. |
| `image.recognize.enabled` | `true` | Gives text-only models `image_recognize`. |
| `image.generate.outputDir` | `~/.unipi/images` | Folder for saved images. |

The Image group also has a model, a custom `baseUrl`, an `apiKey` and an `api` format for each tool.

## How it works

- **Model cache.** At each session start, Utility writes the model list to `~/.unipi/config/models-cache.json`. The settings pickers read this file.
- **Rendering.** `simple` shows one line for each tool call. `advanced` adds syntax colors, diffs and test summaries. `regular` is pi's own view. Ctrl+O expands collapsed output in all styles.
- **Cleanup.** `/unipi:cleanup` removes only items on a fixed list: saved tool outputs and `unipi-*` temp files older than 7 days, and the old compactor database. It never removes memory, boards or config.

## See also

- [Settings reference](../../docs/reference/settings.md)
- [Commands reference](../../docs/reference/commands.md)
- [Tools reference](../../docs/reference/tools.md)
- [Glossary](../../docs/reference/glossary.md)
