# @pi-unipi/app-bridge

Lets the UniPi phone app mirror a pi session that runs in a herdr pane, live,
and talk to it: what you type on the phone shows in the TUI as a normal
message, and everything pi streams in the TUI streams on the phone.

- TUI mode only. Each pi listens on `~/.unipi/bridge/<pid>.sock` (owner-only)
  and writes `~/.unipi/bridge/<pid>.json` (session file, cwd, herdr pane), so
  `unipi-host` can find the pi behind a herdr pane.
- Sending while pi works steers it (like Enter in the TUI); the app can also
  queue a follow-up.
- Dialogs (`ctx.ui.select / confirm / input / editor`) and `ask_user` can be
  answered from the phone; the first answer wins and the other side closes.
- `/model`, `/thinking` and `/compact` are mapped to bridge calls.
- Off switch: `UNIPI_APP_BRIDGE=0`. Subagent children never open a bridge.

Protocol: `unipi-app/docs/m5/PROTOCOL.md`.
