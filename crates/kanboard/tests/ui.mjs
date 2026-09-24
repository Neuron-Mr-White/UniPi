#!/usr/bin/env node
/**
 * UI checks for the kanboard board, driven over the Chrome DevTools Protocol
 * (no Playwright dependency: Node 24 has a global WebSocket).
 *
 *   node crates/kanboard/tests/ui.mjs                  # own temp serve + checks
 *   node crates/kanboard/tests/ui.mjs --url http://coffee:37473 --shots /tmp/kanboard-evidence
 *
 * In `--url` mode it does not start a server; it drives the running one and takes
 * the screenshot set (dark/light × 1440/1920 + panels).
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const binary = process.env.UNIPI_KANBOARD_BIN ?? join(repo, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const urlMode = flag("--url", null);
const shotDir = flag("--shots", null);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// ── optional: own server ────────────────────────────────────────────────────
let server = null;
let home = null;
let workspace = null;
let base = urlMode;
let slug = flag("--project", null);

if (!urlMode) {
  home = mkdtempSync(join(tmpdir(), "kb-ui-home-"));
  workspace = mkdtempSync(join(tmpdir(), "kb-ui-ws-"));
  const env = { ...process.env, UNIPI_KANBOARD_HOME: home };
  const kb = (...call) => JSON.parse(execFileSync(binary, [...call, "--json"], { env, cwd: workspace, encoding: "utf-8" }));
  slug = kb("project", "add", "--name", "UI Check").slug;
  const ids = ["b", "t1", "t2", "r1", "chain"].map((name, index) =>
    kb("add", `${name} task`, "--status", index === 2 || index === 4 ? "todo" : "backlog").id,
  );
  kb("add", "dependent task", "--status", "todo", "--after", ids[2]);
  // chain demo: head, unrelated, child (after head) — the child must be drawn under the head
  const head = kb("add", "chain head", "--status", "todo").id;
  kb("add", "unrelated between", "--status", "todo");
  kb("add", "chain child", "--status", "todo", "--after", head);
  // locked: a todo task whose parent stays in backlog
  const parked = kb("add", "parked parent").id;
  kb("add", "locked child", "--status", "todo", "--after", parked);
  const harsh = "X".repeat(140);
  kb("add", harsh, "--status", "backlog");
  // One task in review so the comment-required move can be exercised.
  kb("claim-next", "--session", "ui-check", "--pid", "1", "--host", "test");
  kb("release", ids[2], "--to", "in_review", "--comment", "ready for review");

  const port = 4399 + (process.pid % 100);
  server = spawn(binary, ["serve", "--port", String(port), "--idle-secs", "900"], { env, cwd: workspace, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  console.log(`serve: ${base} (project ${slug})`);
}

const cleanup = () => {
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
  if (workspace) rmSync(workspace, { recursive: true, force: true });
};

// ── CDP plumbing ────────────────────────────────────────────────────────────
async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* chromium still starting */
    }
    await sleep(250);
  }
  throw new Error("no CDP page target");
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = fail;
    });
    const session = new Session(ws);
    ws.onclose = () => {
      for (const [, entry] of session.pending) entry.reject(new Error("CDP socket closed"));
      session.pending.clear();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const entry = message.id && session.pending.get(message.id);
      if (!entry) return;
      session.pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    };
    return session;
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  /** Poll an expression until the predicate accepts it (a reloaded page takes time). */
  async until(expression, accept, timeoutMs = 20000, step = 400) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await this.evaluate(expression);
        if (accept(last)) return last;
      } catch (error) {
        last = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (Date.now() > deadline) return last;
      await sleep(step);
    }
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return result.result?.value;
  }
  async shot(file) {
    if (!shotDir) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(join(shotDir, file), Buffer.from(data, "base64"));
    console.log(`  saved ${join(shotDir, file)}`);
  }
}

// Runs IN THE PAGE: paste a PNG + a log into the comment box, post, report.
async function pasteAndPost() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const area = document.querySelector(".composer textarea");
  const png = new File([bytes], "image.png", { type: "image/png" });
  const log = new File([new TextEncoder().encode("panic at line 42\n")], "crash.log", { type: "text/plain" });
  const dt = new DataTransfer();
  dt.items.add(png);
  dt.items.add(log);
  area.focus();
  area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: dt }));
  for (let i = 0; i < 40 && !/crash\.log\]\(att:/.test(area.value); i += 1) await sleep(150);
  await sleep(200);
  const draft = area.value;
  const preview = document.querySelectorAll(".composer-preview img").length;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  set.call(area, "Header renders twice on Safari\n" + draft);
  area.dispatchEvent(new Event("input", { bubbles: true }));
  [...document.querySelectorAll(".composer .btn.primary")].find((b) => b.textContent.includes("Comment")).click();
  for (let i = 0; i < 40 && !document.querySelector(".timeline .att-image img"); i += 1) await sleep(150);
  const img = document.querySelector(".timeline .att-image img");
  const chip = document.querySelector(".timeline .att-chip");
  const loaded = img
    ? await new Promise((ok) => {
        if (img.complete && img.naturalWidth) return ok(true);
        img.onload = () => ok(true);
        img.onerror = () => ok(false);
        setTimeout(() => ok(img.naturalWidth > 0), 3000);
      })
    : false;
  return {
    draft,
    preview,
    img: !!img,
    loaded,
    imgSrc: img ? img.getAttribute("src") : null,
    chip: chip ? chip.textContent : null,
    chipHref: chip ? chip.getAttribute("href") : null,
    rail: document.querySelectorAll(".att-rail-item").length,
    rawRefShown: [...document.querySelectorAll(".timeline .what")].some((n) => n.textContent.includes("att:")),
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
const chromium = spawn("chromium", [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "kb-ui-chrome-"))}`,
  "about:blank",
], { stdio: "ignore" });

try {
  const page = await pageTarget();
  const session = await Session.open(page.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Record page errors so a blank screen is diagnosable (and checkable).
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__kbErrors = []; window.addEventListener('error', (e) => window.__kbErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__kbErrors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));`,
  });
  // `--url` may carry the daemon token (`http://host:port/?t=…`); keep it and
  // append the project, so the remote board's API calls stay authorized.
  const boardUrl = (project) => {
    const [root, query] = base.split("?");
    const params = new URLSearchParams(query ?? "");
    if (project) params.set("project", project);
    const search = params.toString();
    return `${root}${search ? `?${search}` : ""}`;
  };
  await session.send("Page.navigate", { url: boardUrl(null) });
  await sleep(2500);

  // 1. the all-projects page (breadcrumb "Projects")
  await session.until(`document.querySelectorAll('.sidebar .nav-item').length`, (n) => n >= 1, 20000);
  await session.evaluate(`(() => {
    const crumb = [...document.querySelectorAll('.crumbs .crumb')].find((b) => b.textContent === 'Projects');
    if (crumb) { crumb.click(); return 'crumb'; }
    return 'already';
  })()`);
  const picker = await session.until(`document.querySelectorAll('.project-card').length`, (n) => n >= 1, 20000);
  check("project picker lists projects", picker >= 1, `${picker} cards`);
  await session.shot("k7-picker-light-1440.png");

  // open the board
  await session.send("Page.navigate", { url: boardUrl(slug) });
  await sleep(2000);
  const lanes = await session.until(`document.querySelectorAll('.lane').length`, (n) => n >= 7, 25000);
  const cards = await session.evaluate(`document.querySelectorAll('.card').length`);
  check("board renders lanes", lanes >= 7, `${lanes} lanes`);
  check("board renders cards", cards >= 4, `${cards} cards`);

  // 1b. long unbroken text must not escape the card, and titles clamp to 3 lines
  const tight = await session.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const overflowing = cards.filter((card) => card.scrollWidth > card.clientWidth + 1);
    const title = [...document.querySelectorAll('.card .card-title')].find((node) => node.textContent.length > 100);
    const line = title ? parseFloat(getComputedStyle(title).lineHeight) : 0;
    return {
      cards: cards.length,
      overflowing: overflowing.length,
      long: !!title,
      clamped: title ? title.scrollHeight <= title.clientHeight + 2 : null,
      lines: title && line ? Math.round(title.getBoundingClientRect().height / line) : null,
    };
  })()`);
  check("no card overflows horizontally", tight.overflowing === 0, `${tight.cards} cards, ${tight.overflowing} overflowing`);
  // The hostile title is seeded by this script's own temp home; a remote board
  // (coffee) has none, so report that instead of failing.
  if (tight.long) {
    check(
      "a 140-char title clamps to 3 lines",
      tight.lines !== null && tight.lines <= 3,
      `rendered ${tight.lines} lines (overflow ${tight.clamped ? "clipped" : "visible"})`,
    );
  } else {
    console.log("· a 140-char title clamps to 3 lines — skipped (no long title on this board)");
  }

  // 2. lanes start at the left edge with no dead space
  const geometry = await session.until(`(() => {
    const laneNode = document.querySelector('.lane');
    if (!laneNode) return null;
    const lane = laneNode.getBoundingClientRect();
    const wrap = document.querySelector('.board-wrap').getBoundingClientRect();
    const styles = getComputedStyle(document.querySelector('.board'));
    return { laneLeft: lane.left - wrap.left, laneWidth: lane.width, gap: styles.gap };
  })()`, (value) => !!value, 15000);
  check("first lane is at the left edge", geometry.laneLeft <= 20, `offset ${Math.round(geometry.laneLeft)}px`);
  check("lane width is ~288px", Math.abs(geometry.laneWidth - 288) <= 2, `${Math.round(geometry.laneWidth)}px`);

  // 3. scrollbar is themed (not the browser default white)
  const scroll = await session.evaluate(`(() => {
    document.querySelector('.board-wrap').style.scrollbarColor = '';
    return getComputedStyle(document.querySelector('.board-wrap')).scrollbarColor;
  })()`);
  check("board scrollbar is themed", /rgb|#/.test(String(scroll)), String(scroll));

  // 4. detail panel opens and closes
  const openedLong = await session.evaluate(`(() => {
    const title = [...document.querySelectorAll('.card .card-title')].find((node) => node.textContent.length > 100);
    const card = title?.closest('.card') ?? document.querySelector('.card');
    card.click();
    return title ? 'long' : 'first';
  })()`);
  await sleep(700);
  const panel = await session.evaluate(`(() => {
    const node = document.querySelector('.panel');
    if (!node) return null;
    return { title: node.querySelector('.title-edit')?.value ?? '', body: !!node.querySelector('.body-view'), timeline: node.querySelectorAll('.timeline li').length, composer: !!node.querySelector('.composer textarea') };
  })()`);
  check("detail panel opens with the task", !!panel && panel.title.length > 0, panel ? `${panel.title.length}-char title` : "missing");
  check("panel has a description, timeline and composer", !!panel && panel.body && panel.timeline >= 1 && panel.composer);
  const panelFit = await session.evaluate(`(() => {
    const panel = document.querySelector('.panel');
    if (!panel) return null;
    const box = panel.getBoundingClientRect();
    const escaping = [...panel.querySelectorAll('button, input, textarea')]
      .filter((node) => node.getBoundingClientRect().right > box.right + 1)
      .map((node) => (node.textContent || node.getAttribute('aria-label') || node.tagName).trim().slice(0, 24));
    return { scroll: panel.scrollWidth - panel.clientWidth, escaping };
  })()`);
  check(
    "nothing in the panel overflows it",
    !!panelFit && panelFit.scroll <= 1 && panelFit.escaping.length === 0,
    panelFit ? `scroll delta ${panelFit.scroll}${panelFit.escaping.length ? ` · escaping: ${panelFit.escaping.join(", ")}` : ""}` : "no panel",
  );
  // actions menu: Duplicate + Cancel task as menu items
  await session.evaluate(`document.querySelector('.panel [aria-label="Task actions"]').click()`);
  await sleep(300);
  const actions = await session.evaluate(`[...document.querySelectorAll('.popover .menu-item')].map((node) => node.textContent.trim())`);
  check("task actions menu has Duplicate and Cancel task", actions.includes("Duplicate") && actions.includes("Cancel task"), actions.join(" · "));
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  // status picker: glyph menu limited to allowed moves
  await session.evaluate(`document.querySelector('.panel #status').click()`);
  await sleep(300);
  const statusBits = await session.evaluate(`(() => {
    const labels = [...document.querySelectorAll('.popover [role=option]')].map((node) => node.querySelector('.menu-label').textContent.trim());
    return { labels, glyphs: document.querySelectorAll('.popover [role=option] .glyph').length, current: document.querySelector('.panel #status').textContent.trim() };
  })()`);
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check("status picker is a glyph menu", statusBits.glyphs === statusBits.labels.length && statusBits.labels.length >= 1, `${statusBits.labels.length} options`);
  const token = new URLSearchParams(base.split("?")[1] ?? "").get("t");
  const rulesDoc = await session.evaluate(
    `fetch('/api/rules${token ? `?t=${token}` : ""}').then((response) => response.json())`,
  );
  const label = (id) => ({ backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", blocked: "Blocked", done: "Done", cancelled: "Cancelled", archived: "Archive" })[id];
  const currentId = Object.keys(rulesDoc.allowedMoves ?? {}).find((id) => label(id) === statusBits.current) ?? "backlog";
  const allowed = new Set([label(currentId), ...(rulesDoc.allowedMoves?.[currentId] ?? []).map(label)]);
  check(
    "the status picker offers allowed moves only",
    statusBits.labels.every((option) => allowed.has(option)),
    statusBits.labels.join(","),
  );
  const titleLength = panel?.title.length ?? 0;
  if (openedLong === "long") {
    check("the clamped title is intact in the panel", titleLength === 140, `${titleLength} chars`);
  } else {
    check("the panel shows the task title", titleLength > 0, `opened ${openedLong} card`);
  }
  await session.shot("k7-detail-light-1440.png");
  await session.evaluate(`document.querySelector('[aria-label="Close details"]').click()`);
  await sleep(400);

  // 5. drag a todo card into backlog (HTML5 drag events, real handlers).
  //    A remote board may have no todo card (the runner drains them), so create
  //    one through the page — it holds the token — instead of skipping the check.
  const hasTodo = await session.evaluate(`document.querySelectorAll('.lane[data-lane="todo"] .card').length`);
  if (hasTodo === 0) {
    const token = new URLSearchParams(base.split("?")[1] ?? "").get("t");
    await session.evaluate(
      `fetch('/api/tasks/${slug}/create${token ? `?t=${token}` : ""}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ui check: drag me', status: 'todo' }) }).then((r) => r.json())`,
    );
    await session.send("Page.reload");
    await session.until(`document.querySelectorAll('.lane[data-lane="todo"] .card').length`, (n) => n >= 1, 20000);
  }
  const before = await session.evaluate(`document.querySelectorAll('.lane[data-lane="backlog"] .card').length`);
  const drag = await session.evaluate(`(async () => {
    const card = document.querySelector('.lane[data-lane="todo"] .card');
    if (!card) return 'no todo card';
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 200));
    const dragging = document.querySelectorAll('.card.dragging').length;
    const lane = document.querySelector('.lane[data-lane="backlog"]');
    lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: lane.getBoundingClientRect().top + 40 }));
    await new Promise((r) => setTimeout(r, 200));
    const lines = document.querySelectorAll('.drop-line').length;
    const okLane = document.querySelectorAll('.lane.drop-ok').length;
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 400));
    const optimistic = document.querySelectorAll('.lane[data-lane="backlog"] .card').length;
    const modalOpen = !!document.querySelector('.dialog.modal');
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('/');
    return card.dataset.id + ' dragging=' + dragging + ' lines=' + lines + ' drop-ok=' + okLane +
      ' optimistic=' + optimistic + ' modal=' + modalOpen + ' toasts=' + toasts + ' trace=' + (document.documentElement.dataset.kbDrop ?? 'none');
  })()`);
  let after = before;
  for (let attempt = 0; attempt < 24 && after !== before + 1; attempt += 1) {
    await sleep(250);
    after = await session.evaluate(`document.querySelectorAll('.lane[data-lane="backlog"] .card').length`);
  }
  const toastText = await session.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  check(
    "dragging todo → backlog moves the card",
    after === before + 1,
    `${before} → ${after} (dragged ${drag})${toastText ? ` · toasts: ${toastText}` : ""}`,
  );

  // 6. a move that needs a comment opens the modal
  const modal = await session.evaluate(`(async () => {
    const card = document.querySelector('.lane[data-lane="in_review"] .card');
    if (!card) return 'no in_review card';
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const lane = document.querySelector('.lane[data-lane="todo"]');
    lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise((done) => setTimeout(done, 900));
    const node = document.querySelector('.dialog.modal');
    return node ? node.querySelector('.prompt')?.textContent ?? 'no prompt' : 'no modal';
  })()`);
  check("comment-required move shows the modal", typeof modal === "string" && !modal.startsWith("no "), String(modal));
  await session.shot("k7-comment-light-1440.png");
  await session.evaluate(`document.querySelector('.dialog [aria-label="Cancel"]').click()`);
  await sleep(300);

  // 7. new-task dialog (C shortcut)
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
  await sleep(500);
  const dialog = await session.evaluate(`(() => {
    const node = document.querySelector('.dialog');
    return node ? { title: !!node.querySelector('.dialog-title-input'), body: !!node.querySelector('.dialog-body-input'), chips: node.querySelectorAll('.prop-chip').length } : null;
  })()`);
  check("C opens the new-task dialog", !!dialog && dialog.title && dialog.body && dialog.chips === 4, JSON.stringify(dialog));
  await session.shot("k7-newtask-light-1440.png");
  await session.evaluate(`document.querySelector('.dialog [aria-label="Close"]').click()`);
  await sleep(300);

  // 7b. command palette (Ctrl+K) finds a task and opens it
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await sleep(400);
  const palette = await session.evaluate(`(async () => {
    const input = document.querySelector('.palette-input input');
    if (!input) return 'no palette';
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const wanted = [...document.querySelectorAll('.card .card-title')].map((n) => n.textContent).find((t) => t.length > 6 && t.length < 60) ?? '';
    set.call(input, wanted);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const first = document.querySelector('.palette .option[aria-selected="true"] .label')?.textContent ?? '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { wanted, first, opened: document.querySelector('.panel .title-edit')?.value ?? 'no panel' };
  })()`);
  check("⌘K palette finds and opens a task", !!palette?.wanted && palette.first === palette.wanted && palette.opened === palette.wanted, JSON.stringify(palette));
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  // 7c. J/K selection + Enter opens it
  const keys = await session.evaluate(`(async () => {
    const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    document.activeElement?.blur();
    for (let i = 0; i < 20; i += 1) press('k');
    press('j'); await new Promise((r) => setTimeout(r, 40)); press('k');
    press('j'); await new Promise((r) => setTimeout(r, 80));
    const first = document.querySelector('.card.selected')?.dataset.id;
    press('j'); await new Promise((r) => setTimeout(r, 80));
    const second = document.querySelector('.card.selected')?.dataset.id;
    press('k'); await new Promise((r) => setTimeout(r, 80));
    const back = document.querySelector('.card.selected')?.dataset.id;
    press('Enter'); await new Promise((r) => setTimeout(r, 400));
    const opened = document.querySelector('.panel .crumb-pill')?.textContent.trim();
    return { first, second, back, opened };
  })()`);
  check("J/K move the selection and Enter opens it", !!keys.first && keys.first !== keys.second && keys.back === keys.first && keys.opened === keys.first, JSON.stringify(keys));
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  // 7d. sidebar: list view + review queue + collapse
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('List')).click()`);
  await sleep(400);
  const list = await session.evaluate(`({ groups: document.querySelectorAll('.list .group-head').length, rows: document.querySelectorAll('.list .row').length })`);
  check("sidebar List shows grouped rows", list.groups >= 2 && list.rows >= 4, JSON.stringify(list));
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Review queue')).click()`);
  await sleep(400);
  const review = await session.evaluate(`[...document.querySelectorAll('.list .group-head')].map((node) => node.textContent.trim())`);
  check("Review queue shows only In Review", review.length === 1 && review[0].startsWith("In Review"), review.join(" | "));
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Board')).click()`);
  await sleep(400);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }))`);
  await sleep(300);
  const collapsed = await session.evaluate(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }))`);
  await sleep(300);
  check("[ collapses the sidebar to a rail", collapsed <= 60, `${collapsed}px`);

  // 7e. chains: same-lane dependents drawn right under their parent, with chain markers
  if (!urlMode) {
    const chain = await session.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.lane[data-lane="todo"] .card')];
      const title = (card) => card.querySelector('.card-title').textContent;
      const at = (text) => cards.findIndex((card) => title(card) === text);
      const head = cards[at('chain head')], child = cards[at('chain child')];
      return { head: at('chain head'), child: at('chain child'), headChain: head?.dataset.chain, childChain: child?.dataset.chain,
        childTag: child?.querySelector('.tag.dep')?.textContent ?? null };
    })()`);
    check("a same-lane dependent is drawn right under its parent", chain.child === chain.head + 1 && chain.headChain === "first" && chain.childChain === "last", JSON.stringify(chain));
    check("the connector replaces the 'after' tag inside a chain", chain.childTag === null, String(chain.childTag));

    const locked = await session.evaluate(`(() => {
      const card = [...document.querySelectorAll('.card')].find((node) => node.querySelector('.card-title').textContent === 'locked child');
      const tag = card?.querySelector('.tag.dep');
      return { locked: card?.classList.contains('locked'), tagLocked: tag?.classList.contains('locked'), text: tag?.textContent };
    })()`);
    check("a task behind a Backlog parent shows as locked", locked.locked && locked.tagLocked && /not scheduled/.test(locked.text ?? ""), JSON.stringify(locked));

    // Drop target never lands between chain members: hovering the child's top half snaps to the head.
    const snapped = await session.evaluate(`(async () => {
      const lane = document.querySelector('.lane[data-lane="todo"]');
      const mover = [...lane.querySelectorAll('.card')].find((c) => c.querySelector('.card-title').textContent === 'unrelated between');
      const child = [...lane.querySelectorAll('.card')].find((c) => c.querySelector('.card-title').textContent === 'chain child');
      const dt = new DataTransfer();
      mover.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 120));
      lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: child.getBoundingClientRect().top + 4 }));
      await new Promise((r) => setTimeout(r, 150));
      const line = lane.querySelector('.drop-line');
      const after = line?.nextElementSibling?.querySelector('.card-title')?.textContent ?? null;
      mover.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return after;
    })()`);
    check("the drop line snaps outside a chain", snapped === "chain head", String(snapped));

    // Moving a task into Todo while its parent is in Backlog offers to schedule the parent.
    const offer = await session.evaluate(`(async () => {
      const parked = [...document.querySelectorAll('.card')].find((n) => n.querySelector('.card-title').textContent === 'parked parent').dataset.id;
      const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const probe = await post('/api/tasks/${slug}/create', { title: 'offer probe', status: 'backlog', after: [parked] });
      await new Promise((r) => setTimeout(r, 900)); // SSE refresh
      const lane = document.querySelector('.lane[data-lane="todo"]');
      const card = document.querySelector('.card[data-id="' + probe.id + '"]');
      if (!card) return 'probe card missing';
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: lane.getBoundingClientRect().bottom - 20 }));
      lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 1200));
      const toast = [...document.querySelectorAll('.toast')].find((t) => /is locked/.test(t.textContent));
      if (!toast) return 'no offer: ' + [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
      const button = [...toast.querySelectorAll('button')].find((b) => /to Todo/.test(b.textContent));
      button.click();
      await new Promise((r) => setTimeout(r, 1200));
      const parent = await fetch('/api/tasks/${slug}/' + parked).then((r) => r.json());
      return 'offered, parent now ' + parent.status;
    })()`);
    check("moving to Todo offers to schedule a Backlog parent", offer === "offered, parent now todo", String(offer));
  }

  // 7f. attachments: paste an image into the comment box, post it, and see it rendered
  {
    const firstCard = await session.evaluate(`document.querySelector('.lane[data-lane="todo"] .card')?.dataset.id ?? document.querySelector('.card').dataset.id`);
    await session.evaluate(`document.querySelector('.card[data-id="${firstCard}"]').click()`);
    await sleep(500);
    const postedRaw = await session.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(${pasteAndPost.toString()})()` }, 30000);
    if (postedRaw.exceptionDetails) console.log("  eval error:", JSON.stringify(postedRaw.exceptionDetails).slice(0, 600));
    const posted = postedRaw.result?.value ?? {};
    check("pasted files upload and land in the comment as markdown", /!\[screenshot-[\d-]+\.png\]\(att:/.test(posted.draft) && /\[crash\.log\]\(att:/.test(posted.draft), posted.draft);
    check("the composer previews attachments before posting", posted.preview === 1, `${posted.preview} preview image(s)`);
    check("a comment renders its image inline", posted.img && posted.loaded && /^\/api\/files\//.test(posted.imgSrc ?? ""), JSON.stringify({ img: posted.img, loaded: posted.loaded, src: posted.imgSrc }));
    check("a comment renders a text file as a chip", /crash\.log/.test(posted.chip ?? "") && /^\/api\/files\//.test(posted.chipHref ?? ""), String(posted.chip));
    check("raw att: references never show as text", posted.rawRefShown === false);
    check("the rail lists the task's attachments", posted.rail === 2, `${posted.rail} items`);
    await session.shot("k9-attachments-light-1440.png");
    await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
    await sleep(300);
  }

  // 8. theme toggle + light screenshots + 1920
  const initialTheme = await session.evaluate(`document.documentElement.dataset.theme`);
  await session.evaluate(`document.querySelector('[aria-label="Toggle theme"]').click()`);
  await sleep(400);
  const theme = await session.evaluate(`document.documentElement.dataset.theme`);
  check("theme toggle flips the theme", theme !== initialTheme, `${initialTheme} → ${theme}`);
  if (theme !== "light") {
    await session.evaluate(`document.querySelector('[aria-label="Toggle theme"]').click()`);
    await sleep(400);
  }
  await session.shot("k7-board-light-1440.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await session.shot("k7-board-light-1920.png");
  await session.evaluate(`document.querySelector('[aria-label="Toggle theme"]').click()`);
  await sleep(400);
  await session.shot("k7-board-dark-1920.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await session.shot("k7-board-dark-800.png");

  // 9. no page errors during the session
  const errors = await session.evaluate(`window.__kbErrors ?? []`);
  check("no uncaught page errors", errors.length === 0, errors.join(" · ") || "none");
  const bodyText = await session.evaluate(`document.body.innerText.slice(0, 120)`);
  console.log(`  page text: ${JSON.stringify(bodyText)}`);
} catch (error) {
  check("ui checks completed", false, error instanceof Error ? error.message : String(error));
} finally {
  chromium.kill();
  cleanup();
}

console.log(failures === 0 ? "\n✓ all UI checks passed" : `\n✗ ${failures} UI check(s) failed`);
process.exit(failures === 0 ? 1 * 0 : 1);
