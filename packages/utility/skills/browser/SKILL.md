---
name: browser
description: Use the PC's browser — the one the user sees in the UniPi app — with agent-browser. agent-browser is already pointed at it (AGENT_BROWSER_CDP), so just run `agent-browser open <url>`, `snapshot`, `click @e1`… with no start or connect step. Use when the user asks to browse, scrape a site, fill a form, log in somewhere, check a web page, or anything in a real browser — especially bot-protected sites or ones that need the user's login. Also covers picking a profile and importing the user's Chrome login for one site.
---

# browser — the browser the user sees in the UniPi app

`agent-browser` is **already connected** to the PC's browser. `AGENT_BROWSER_CDP` is set for you while the browser is on. Just use it:

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e3
```

There is no start or connect step: the first command starts the browser if needed.

- **Never** pass `--cdp`, `--headed`, `--executable-path` or `--profile`.
- **Never** run `agent-browser connect` or `agent-browser install`.

Those would launch a separate Chrome the user can't see.

For the command reference, which matches the installed version: `agent-browser skills get core`.

## What it is

- **CloakBrowser**, a Chromium with source-level fingerprint patches. It runs on a hidden display, so it shows **only in the UniPi app**: the browser pane beside the chat, the phone sheet, and any phone connected to this PC.
- The user may be watching, and can **take over** at any time. The user can also show it as a real window on the PC.
- Your clicks, typing and scrolling are made to look human on the way to the browser. Don't add your own sleeps between keystrokes; waiting for the page is still right.
- `agent-browser close` closes only the tabs you opened. The browser keeps running for the user.

## Profiles (only when it matters)

```bash
unipi-host browser use              # which profile agent-browser drives now
unipi-host browser profiles         # name, last used, which sites have logins, running
```

- **A profile already lists the site's domain** → it is already logged in. Switch to it: `unipi-host browser use shop`.
- **A fresh identity or a clean scrape** → `unipi-host browser profile create shop-scrape && unipi-host browser use shop-scrape`.
- **Otherwise** → `default`. Switch back with `unipi-host browser use default` when you're done with a special profile.

## The user's login for one site (only when the task needs it)

When the task needs the user's account on a site, copy **only that site's** cookies from their everyday browser into a fresh profile, then use it:

```bash
unipi-host browser cookies --list-sources
unipi-host browser profile create shop-scrape
unipi-host browser cookies --from chrome --domain example.com --into shop-scrape
unipi-host browser use shop-scrape
```

- Use the narrowest domain that works. It covers its subdomains. Never import everything.
- The keyring may ask the user to unlock it. Tell them why first.
- Never print, log or paste cookie values.
- Windows sources aren't supported yet. Ask the user to log in in the app pane instead.

## Manners

- Open your own tab for the task, and leave the user's tabs alone.
- **"The user has taken over the browser; wait or ask them"** → stop, tell the user you're waiting or ask, and don't retry in a loop.
- CAPTCHAs and 2FA: ask the user to do them in the app pane (they can take over), then continue.
- Respect sites: no credential stuffing, no account-creation abuse, no hammering.
- When done: close your tabs. To close your tab: `agent-browser tab list`, then `agent-browser tab close t2`. Ids look like `t2`, not `2`. agent-browser won't close the last tab; that's fine, so leave it. Mention the profile you used. Remove a throwaway profile only if the user agrees, because it holds their login (`unipi-host browser profile rm <name>`).

## Troubleshooting

- **A 503 or "The browser is off on this PC"** → ask the user to turn it on in the UniPi app. Don't retry or enable it yourself.
- **`AGENT_BROWSER_CDP` is empty** (`echo $AGENT_BROWSER_CDP`) → the UniPi host isn't running, or the browser is off. Tell the user.
- **The pane or start says "Less stealthy" / "Not stealthy"** → tell the user before scraping a bot-protected site.
- **`agent-browser` not found** → `npm i -g agent-browser`.
- **Still blocked on a protected site** → say so honestly. Don't escalate to evasion tricks.
