# @pi-unipi/btw

A [pi](https://github.com/badlogic/pi-mono) extension for parallel side conversations with `/btw` — part of the [Unipi](https://github.com/Neuron-Mr-White/unipi) suite.

`/btw` opens a real pi sub-session with coding-tool access, running immediately even while the main agent is still busy.

Based on [pi-btw](https://github.com/Neuron-Mr-White/pi-btw) by Dan Bachelder.

## Install

As part of the full Unipi suite:

```bash
pi install npm:unipi
```

Standalone:

```bash
pi install npm:@pi-unipi/btw
```

## Usage

```text
/btw what file defines this route?
/btw how would you refactor this parser?
/btw --save summarize the last error in one sentence
/btw:new let's start a fresh thread about auth
/btw:tangent brainstorm from first principles without using the current chat context
/btw:inject implement the plan we just discussed
/btw:summarize turn that side thread into a short handoff
/btw:clear
```

## Commands

### /btw [--save] <question>

- runs right away, works while pi is busy
- creates or reuses a real BTW sub-session
- continues the current BTW thread
- opens a focused BTW modal shell
- streams into the BTW modal transcript/status surface
- persists the BTW exchange as hidden thread state
- with `--save`, also saves that single exchange as a visible session note

### /btw:new [question]

- clears the current BTW thread
- starts a fresh thread that still inherits the current main-session context
- optionally asks the first question in the new thread immediately

### /btw:tangent [--save] <question>

- starts or continues a contextless tangent thread
- does not inherit the current main-session conversation
- with `--save`, also saves that single exchange as a visible session note

### /btw:clear

- dismisses the BTW modal/widget
- clears the current BTW thread

### /btw:inject [instructions]

- sends the full BTW thread back to the main agent as a user message
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### /btw:summarize [instructions]

- summarizes the BTW thread with the current model
- injects the summary into the main agent
- clears the BTW thread after sending

## Overlay controls

- `Alt+/` toggles focus between BTW and the main editor without closing the overlay
- `Ctrl+Alt+W` is a fallback focus toggle for terminals that do not deliver `Alt+/` as a usable shortcut
- `Esc` still dismisses BTW immediately while the overlay is focused
- `PgUp`/`PgDn` scrolls the transcript
- BTW opens top-centered so the main session remains visible underneath

## Why

Sometimes you want to:

- ask a clarifying question while the main agent keeps working
- think through next steps without derailing the current turn
- explore an idea, then inject it back once it's ready

## License

MIT
