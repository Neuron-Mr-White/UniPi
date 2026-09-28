---
name: image
scope: agent
description: |
  Generate, edit and read images with the image_generate, image_edit and
  image_recognize tools (@pi-unipi/utility). Use when the user asks for a
  picture, icon, illustration, mockup or logo, wants an existing image
  changed, or needs a screenshot/diagram read while the session model
  cannot see images.
---

# Image tools

| Tool | Use for |
|------|---------|
| `image_generate(prompt, model?)` | A new image from text |
| `image_edit(prompt, image, model?)` | Change an existing image (`image` = file path, data: URL or base64) |
| `image_recognize(image, prompt?, model?)` | Read an image with a vision model — only offered while your own model cannot see images |

## Prompting

- Be concrete: subject, style, composition, lighting, colours, text to render.
- Say what you want, not what you don't — negation is unreliable.
- For edits, say what to change AND what to keep; unmentioned details can drift.
- Images cost money. Generate once, show the result, and only retry when asked.

## Models

Omit `model` to use the one set in `/unipi:settings` → Image. To override, pass
`provider/model-id`, e.g. `openrouter/black-forest-labs/flux.2-klein-4b` or
`fal/fal-ai/flux-2/klein/4b` (edits: `fal/fal-ai/flux-2/klein/4b/edit`).

## Results

Images come back inline and are saved under `~/.unipi/images/` (path in the
result). If a call fails, the error says which key or setting is missing —
tell the user that instead of retrying.
