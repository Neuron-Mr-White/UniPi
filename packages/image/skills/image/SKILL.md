---
name: image
description: Generate images from text prompts and analyze images with vision models
---

# Image Tools

Two agent tools: `image_generate` creates images from a text prompt, and
`image_recognize` analyzes an existing image.

## image_generate

```
image_generate(prompt: "A cutaway diagram of a submarine, technical illustration, muted blues")
image_generate(prompt: "...", model: "flux.2-pro")
```

- `prompt` (required) — describe subject, style, composition and lighting.
  Detail materially improves the result.
- `model` (optional) — fuzzy-matched against the image catalog
  (`flux`, `gemini-3-pro-image`, `recraft-v4`, …). Omit to use the model
  configured in `/unipi:image-settings`.

The image is returned inline and, when `saveToDisk` is on (the default),
written to the output directory (default `~/.unipi/images`). The saved path is
reported in the result.

**Image generation costs money per call.** Never regenerate an image
speculatively — only when the user asks for a change.

Models are served through OpenRouter, so an OpenRouter key is required:
https://openrouter.ai/keys

## image_recognize

```
image_recognize(image: "./screenshot.png")
image_recognize(image: "./error.png", prompt: "What does the stack trace say?")
image_recognize(image: "...", model: "claude-sonnet", systemPrompt: "Reply only with the visible text.")
```

- `image` (required) — a local file path, a `data:` URL, or raw base64.
  **Prefer a file path**: inlining base64 into the conversation is far more
  expensive. Remote URLs are not fetched — download first.
- `prompt` (optional) — the question to ask. Defaults to a general
  description. A specific question gives a far more useful answer.
- `model` (optional) — must accept image input. Omit to use the configured
  model, falling back to the session's current model.
- `systemPrompt` (optional) — override the configured system prompt for one
  call.

Supported types: PNG, JPEG, GIF, WebP. The type is detected from the file's
magic numbers, so a misnamed extension still works.

### When to use it

- Reading a screenshot of an error, a stack trace, or failing UI
- Understanding a design mockup or wireframe before implementing it
- Extracting content from an architecture diagram or flowchart
- Checking what a rendered page or chart actually looks like

## Configuration

`/unipi:image-settings` configures both tools:

- Generation model (picker over the image catalog)
- Recognition model (picker over vision-capable models only)
- Enable/disable either tool
- Output directory and whether to save to disk
- The recognition system prompt

Config lives at `~/.unipi/config/image/config.json`. Toggling a tool on or off
takes effect on the next session, since tools are registered at startup.
