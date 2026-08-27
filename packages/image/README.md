# @pi-unipi/image

Image generation and image recognition tools for the agent.

## Tools

| Tool | Description |
|------|-------------|
| `image_generate` | Generate an image from a text prompt. Returned inline and saved to disk. |
| `image_recognize` | Analyze an image with a vision model. Accepts a file path, `data:` URL, or base64. Automatically hidden while the session model itself has vision. |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:image-settings` | Configure models, output directory and the recognition system prompt |

## image_generate

```
image_generate(prompt: "A cutaway diagram of a submarine, technical illustration")
image_generate(prompt: "...", model: "flux.2-pro")
```

Models come from two places, merged into one list:

- pi-ai's built-in image catalog — 34 models including FLUX.2, Gemini 3 Pro
  Image, GPT-5 Image, Recraft and Riverflow — served through **OpenRouter**
  ([get a key](https://openrouter.ai/keys)).
- **Any provider registered by another extension.** Third-party providers
  publish no image metadata, so these are detected by name; a real registry
  with 393 models contributed 12 generators (FLUX, Nano Banana, Ideogram,
  Recraft, Seedream, Stable Diffusion) alongside the built-ins.

Because that detection is heuristic, the picker has a **custom entry** — press
`c` in `/unipi:image-settings` and type any `provider/model-id`. A
well-formed reference is always accepted, even when the catalog has never
heard of it, so no model is ever unreachable.

The `model` parameter is fuzzy-matched, so `flux`, `recraft` and
`gemini-3-pro` all work. Omit it to use the model chosen in
`/unipi:image-settings`.

Images are returned inline **and** written to `~/.unipi/images` by default;
the saved path is reported back to the agent. A failed write never discards a
successfully generated image.

## image_recognize

```
image_recognize(image: "./screenshot.png")
image_recognize(image: "./error.png", prompt: "What does the stack trace say?")
```

Uses any chat model whose input modality includes `image`. A model that cannot
accept images is rejected up front with a clear message rather than failing
inside the provider.

Input can be a local file path, a `data:` URL, or raw base64. The media type is
detected from the file's magic numbers, so a `.jpg` that is really a PNG still
works. Supported: PNG, JPEG, GIF, WebP. Remote URLs are not fetched.

Prefer file paths — inlining base64 into the conversation is far more
expensive in tokens.

**Vision models don't get this tool.** When the session's current model already
accepts image input, `image_recognize` is dropped from the active tool set —
the model reads images natively through pi's own tools, so a separate
recognition round-trip through another model would only duplicate that ability
and burn context. Switch to a text-only model (via `/model`) and the tool comes
back automatically.

## Configuration

`~/.unipi/config/image/config.json`:

```json
{
  "generate": {
    "enabled": true,
    "model": "openrouter/google/gemini-3-pro-image",
    "outputDir": "~/.unipi/images",
    "saveToDisk": true
  },
  "recognize": {
    "enabled": true,
    "model": "",
    "systemPrompt": "You are a precise image analyst…"
  }
}
```

- `recognize.model` empty means "use the session's current model".
- The system prompt is fully customizable, and can be overridden per call.
- Enabling or disabling a tool takes effect next session, since tools are
  registered at startup.
- Every read falls back to defaults, so a corrupt config never breaks the tools.

Set `UNIPI_IMAGE_CONFIG_DIR` to relocate the config directory (used by tests).
