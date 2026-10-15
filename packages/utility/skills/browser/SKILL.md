---
name: browser
description: Drive the PC's stealth browser (CloakBrowser, a visible window the user can watch and take over in the UniPi app) with agent-browser. Use when the user asks to browse, scrape a site, fill a form, log in somewhere, check a web page, or do anything in a real browser — especially sites with bot protection or that need the user's login. Covers starting the browser, choosing or creating a profile, importing the user's Chrome cookies for one site, connecting agent-browser through the human-input gate, and cleaning up.
---

# browser — UniPi's shared stealth browser

The PC runs one browser per **profile**, owned by `unipi-host`:
- **CloakBrowser**, a Chromium build with source-level fingerprint patches. It always has a visible window.
- The user can watch it live in the UniPi app (the browser pane beside the chat, or the sheet on the phone), and can **take over** at any time.
- You drive it with `agent-browser`, connected through the host's **agent endpoint**, never the raw DevTools port. That endpoint:
  - makes your clicks, typing and scrolling look human (curved mouse paths, per-key typing, eased scrolling);
  - pauses you while the user has taken over;
  - keeps `close` scoped to the tabs you opened.

## 1. Pick the profile

```bash
unipi-host browser profiles          # name, last used, which sites have logins (cookie domains), running
```

- **A profile already lists the site's domain** → reuse it. It is already logged in.
- **A fresh identity or a clean scrape** (no history, a new fingerprint) → create one with a short, descriptive name:
  `unipi-host browser profile create shop-scrape`
- **Otherwise** → `default`.

Each profile keeps its own fingerprint, cookies and history. Don't mix unrelated accounts in one profile.

## 2. The user's login for a site (only when the task needs it)

When the task needs the user's account on a site (scrape their orders, fill a form while logged in), copy **only that site's** cookies from their everyday browser into a profile:

```bash
unipi-host browser cookies --list-sources                 # which browsers/profiles exist (no secrets)
unipi-host browser cookies --from chrome --domain example.com --into shop-scrape
# other sources: --from chrome:"Profile 1" | chromium | brave[:<profile>]
```

- Prefer a **fresh profile** for this (step 1), not `default`.
- Import the narrowest domain that works (`example.com` also covers its subdomains). Never import everything.
- The keyring may ask the user to unlock it. Tell them why ("to copy your example.com login into the browser").
- Never print, log or paste cookie values.
- Windows sources aren't supported yet. Say so, and ask the user to log in in the window instead.

## 3. Start and connect

```bash
unipi-host browser start --profile shop-scrape --json
```

Read the JSON:
- `agent_http` is the agent endpoint, e.g. `http://127.0.0.1:41234`. Use its port.
- `stealth`: `false` means a plain Chrome fallback, with the reason in `stealth_reason`.
- `engine` and `profile` confirm which browser and profile started.

Then:

```bash
agent-browser connect 41234        # the agent_http port, never the raw `http` port
```

- If `stealth` is false, tell the user before scraping a bot-protected site: "the stealth browser isn't available (<reason>); this is plain Chrome and may get blocked".
- If start fails with `no_display`, the PC has no screen session. CloakBrowser needs a visible window, so tell the user.
- If it fails with `too_many`, too many profiles' browsers are open. Stop one you started (`unipi-host browser stop --profile <name>`) or ask.

## 4. Work

For commands (open, snapshot, click, fill, type, scroll, screenshot, get text, wait…), load agent-browser's own guide, which matches the installed version:

```bash
agent-browser skills get core
```

Rules on top of it:
- **Open your own tab** for the task rather than hijacking a tab the user has open. Leave the user's tabs alone.
- The user may be watching. Work in a sensible order and don't flash through pages pointlessly.
- If a command fails with **"The user has taken over the browser; wait or ask them"**:
  - stop driving;
  - tell the user you're waiting, or ask what they want;
  - don't retry in a loop.
- Speed: input is humanized and slower than raw automation. Don't add your own sleeps between keystrokes. Waiting for the page (agent-browser's wait commands) is still right.
- CAPTCHAs and 2FA prompts: don't try to solve them. Ask the user to do it in the window or app pane (they can take over), then continue.
- Respect the site: no credential stuffing, no account creation abuse, no hammering. Keep request rates human.

## 5. Finish

- Close the tabs you opened (`agent-browser close` through the endpoint closes only your tabs; the browser keeps running for the user).
- Leave the browser running unless you started a throwaway profile just for this task and the user doesn't need it. Then stop it:
  `unipi-host browser stop --profile <name>`.
- Delete a throwaway profile only if the user agrees. It holds their imported login:
  `unipi-host browser profile rm <name>`.
- Report what you did and where the results are. Mention the profile you used, so the user can reuse it.

## Troubleshooting

- `unipi-host` not found → the UniPi host isn't installed on this PC. Tell the user, who can install it with the UniPi installer.
- The browser feature is off → `unipi-host browser enable` (the user's choice; ask first).
- Still blocked on a protected site with `stealth: true` → say so honestly. Don't escalate to evasion tricks.
