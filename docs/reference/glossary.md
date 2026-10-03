# Glossary

This page defines the UniPi terms that a new user meets. The terms are in
alphabetic order. For the design behind the terms, see the
[architecture docs](../architecture/README.md).

## A

**Autowork**
: A kanboard mode for one session. The agent works the ready tasks on the board
  one at a time. Start it with `/unipi:kanboard-autowork start`.

## B

**Background task**
: A shell command that runs after the turn that started it. The agent starts one
  with `bg_run`. You start one with `/unipi:bg`.

## C

**Cache epoch**
: The period in which the provider, model, settings, system prompt, tools and
  earlier messages stay the same. In one epoch, the provider can reuse its
  prefix cache. See [prefix-cache-architecture.md](../prefix-cache-architecture.md).

**Claim**
: A kanboard task that a session started and still holds In Progress. When the
  session ends, UniPi puts its open claims back in Todo.

**Coexist triggers**
: An old term from the v2 docs. It named behavior that changed when two
  packages loaded together. In v3, the `@pi-unipi/unipi` package loads all
  modules, and modules find each other through events such as `MODULE_READY`.

**Compaction**
: The step that makes the session context smaller when it is near the model
  limit. The compactor replaces old turns with a summary. The full history stays
  searchable with session recall.

## D

**Decision Model**
: The shared settings group for jev. Long-horizon, permissions, skills, session
  naming and the watchdog use it, or a custom model of their own.

**`-do` budget**
: The task slots and board writes that `/unipi:kanboard-do` gives the agent for
  one request. Board reads need no budget.

## F

**Fusion**
: A mode that pairs two models. A lead model plans and talks to you. A
  lower-cost sidekick model does the hands-on work. Select a pair with
  `/unipi:model`.

## G

**Glance footer**
: The footer glance mode. It draws a frame around the input box and a live
  session strip. The `footer` setting `glanceMode` turns it on or off.

**Goal**
: A long-horizon mode for one objective. The agent works over many turns until
  an independent verifier accepts the objective, or a budget stops it. Start it
  with `/unipi:goal <prompt>`.

**Graph**
: A long-horizon mode for work with dependent steps. The agent declares a
  graph of items. An item starts when the items that it depends on complete.

## H

**Harness message**
: A message that UniPi, not you, sends to the model as a user message. UniPi
  tags it, so the transcript shows it in a different style.

**Hints**
: One-line tips above the editor. They show at startup and after some events.
  Push `Alt+H` for the next hint. Use `/unipi:hint` to browse all hints.

**Hub**
: See settings hub.

## J

**jev**
: A decision model from TypeSafe. It gives a short judgment with a confidence,
  for example "is this `bash` command safe". The default model ID is
  `typesafe/jev-1.13`.

## K

**Kanboard**
: A task board for each project. A local daemon serves the board in a browser.
  The agent changes the board through the `kanboard` CLI.

## L

**Lead**
: In Fusion, the model that talks to you, plans and gives work to the sidekick.
  The lead owns the outcome.

**Long-horizon mode**
: One of the modes goal, ralph, swarm and graph. Each mode gives the agent its
  own tools for work over many turns. Regular mode is the mode with none of
  them.

## M

**MemPalace**
: The memory store under the memory package. It keeps memories across sessions
  and searches them. Other tools, for example Devin and zcode, can share it.

**Module**
: One UniPi package that the umbrella package loads. Each module sends a
  `MODULE_READY` event when it loads. The info screen and the footer listen for
  this event.

## N

**Namespace**
: The name of the settings group of one module, for example `compactor`.
  UniPi keeps each namespace in `~/.unipi/config/<namespace>/config.json`.

**Nudge**
: A short harness message that tells the agent to continue or to do one more
  step. The turn arbiter sends one nudge at most each time the agent stops.

## O

**Owner**
: The long-horizon mode run that drives the session, for example one goal. A
  session has one active owner at most.

## P

**Park slot**
: A place for one paused owner. When you switch modes, the active owner goes to
  the park slot. Use `resume` to make it active again.

**Permission mode**
: The rule for when the agent must ask you before a tool runs. The modes are
  `ask`, `auto` and `full`. In `auto` mode, jev judges unknown `bash` commands.

**Plan mode**
: A read-only mode. The agent can only write its plan file. Then it asks you
  to approve the plan. Toggle it with `Alt+P` or `/unipi:plan`.

**Prefix cache**
: A provider cache of the start of a model request. When the next request starts
  with the same text, the provider reuses the cache. This makes the request
  less costly. UniPi tries to keep the prefix the same.

## R

**Ralph**
: A long-horizon mode that works through a checklist file over many
  iterations. The file is `.unipi/ralph/<name>.md`. At the end, a verifier
  checks the file.

**Regular mode**
: The mode with no long-horizon tools. Set it with `/unipi:regular`.

## S

**Session recall**
: A search over the full history of the current session, also the compacted
  parts. You use `/unipi:session-recall`. The agent uses `session_recall`.

**Settings hub**
: The one panel for all UniPi settings. Open it with `/unipi:settings`.

**Sidekick**
: In Fusion, the persistent child agent that does the work that the lead gives
  it. Its context and shells stay between handoffs.

**Subagent**
: An independent child agent for one task. It does not see the conversation.
  The agent starts one with `run_subagent`.

**Swarm**
: A long-horizon mode for independent items. Workers run the items in parallel.
  Then the agent writes one synthesis.

## T

**Turn arbiter**
: The one place where UniPi decides what happens when the agent stops. Modules
  propose nudges. Running work, such as a background task, can block a nudge.
  The arbiter sends one nudge at most.

## U

**Unicrab**
: The crab mascot of UniPi. It shows next to hints and on the start screen.

## V

**vcc**
: The name of the lossless compaction method. It writes a structured summary
  from the session history with no model call.

**Verifier**
: An independent model call that checks a goal or a ralph loop before UniPi
  marks it complete. Set its model with the `long-horizon` setting
  `verifierModel`.

## W

**Watchdog**
: A module that asks jev about long-running tool calls. It can kill a stuck
  call or warn you. It is off by default.
