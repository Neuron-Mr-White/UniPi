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
  // Two done tasks for the summarize & archive flow: claim → review → done.
  // Seeded first so claim-next (order = creation) picks them, not the fixtures below.
  for (const name of ["shipped alpha", "shipped beta"]) {
    kb("add", name, "--status", "todo");
    const claimed = kb("claim-next", "--session", "ui-check", "--pid", "1", "--host", "test");
    kb("release", claimed.task.id, "--to", "in_review", "--comment", "shipped");
    kb("move", claimed.task.id, "done");
  }
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
  // An agent-style release summary: a table, a list and a long unbroken token.
  const report = kb("add", "activity markdown", "--status", "backlog").id;
  kb(
    "note",
    report,
    [
      "Findings:",
      "",
      "| Task | State | Note |",
      "|---|---|---|",
      "| PIT-19 | no body | The task has and is one of several drag fixtures (same title) |",
      "| PIT-21 | done | smoke: drag me from todo to backlog and then back again to review |",
      "",
      "- first point with **bold**",
      "- second point",
      "",
      `token ${"a".repeat(180)}`,
      "",
      ...Array.from({ length: 10 }, (_, index) => `line ${index + 1} of a long summary`),
    ].join("\n"),
  );
  // One task in review so the comment-required move can be exercised.
  kb("claim-next", "--session", "ui-check", "--pid", "1", "--host", "test");
  kb("release", ids[2], "--to", "in_review", "--comment", "ready for review");
  // One blocked task with a reason (card callout + panel banner).
  const blockedId = kb("claim-next", "--session", "ui-check", "--pid", "1", "--host", "test").task.id;
  kb("move", blockedId, "blocked", "--comment", "need the API endpoint before I can continue", "--actor", "agent", "--session", "ui-check");
  // A second, archived project — the overview's collapsed "Archived" section.
  const otherRoot = mkdtempSync(join(tmpdir(), "kb-ui-other-"));
  const otherSlug = kb("project", "add", "--root", otherRoot, "--name", "Old side project").slug;
  kb("project", "archive", otherSlug);
  // No piCommand yet: the summarize flow must show the needsAgent banner first.
  writeFileSync(join(home, "settings.json"), JSON.stringify({ models: ["test/model-a", "test/model-b"] }));
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

  // 1a. lane order: Blocked sits before In Review so review is next to Done.
  const laneOrder = await session.evaluate(`[...document.querySelectorAll('.lane')].map((lane) => lane.dataset.lane)`);
  check(
    "lanes are ordered backlog → todo → in progress → blocked → in review → done → cancelled",
    JSON.stringify(laneOrder) === JSON.stringify(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"]),
    laneOrder.join(", "),
  );

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

  // 7g. activity markdown: tables/lists render at full column width, clamped with "Show more"
  if (!urlMode) {
    const activity = await session.evaluate(`(async () => {
      const card = [...document.querySelectorAll('.card')].find((n) => n.querySelector('.card-title').textContent === 'activity markdown');
      if (!card) return 'no card';
      card.click();
      await new Promise((r) => setTimeout(r, 700));
      const entry = [...document.querySelectorAll('.timeline .what')].find((n) => n.querySelector('table'));
      if (!entry) return 'no table entry';
      const column = entry.parentElement.getBoundingClientRect().width;
      const width = entry.getBoundingClientRect().width;
      const cell = entry.querySelector('td:last-child').getBoundingClientRect().width;
      const clamped = entry.classList.contains('clamped');
      const more = entry.parentElement.querySelector('.show-more');
      const clampedHeight = entry.getBoundingClientRect().height;
      more?.click();
      await new Promise((r) => setTimeout(r, 300));
      const openHeight = entry.getBoundingClientRect().height;
      const overflow = document.querySelector('.panel').scrollWidth - document.querySelector('.panel').clientWidth;
      // Markdown lists/paragraphs must span the column (the timeline's own
      // grid <li> rules used to shrink them to one character wide).
      const entryW = entry.getBoundingClientRect().width;
      const thinBlocks = [...entry.querySelectorAll('li, p')].filter((el) => el.getBoundingClientRect().width < entryW * 0.6).length;
      const narrow = [...entry.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && el.textContent.trim().length > 10 && el.getBoundingClientRect().width < 100,
      ).length;
      return { column: Math.round(column), width: Math.round(width), cell: Math.round(cell), clamped, more: !!more, clampedHeight: Math.round(clampedHeight), openHeight: Math.round(openHeight), overflow, thinBlocks, narrow };
    })()`);
    check(
      "a markdown activity entry fills its column",
      typeof activity === "object" && activity.width >= activity.column - 2 && activity.width > 200 && activity.cell >= 60,
      JSON.stringify(activity),
    );
    check("long activity entries clamp with Show more", activity?.clamped && activity.more && activity.openHeight > activity.clampedHeight + 40, JSON.stringify(activity));
    check("activity markdown never widens the panel", activity?.overflow <= 1, String(activity?.overflow));
    check(
      "markdown lists and paragraphs span the entry's full width",
      activity?.thinBlocks === 0 && activity?.narrow === 0,
      `thinBlocks=${activity?.thinBlocks} narrow=${activity?.narrow}`,
    );
    await session.shot("k10-activity-md-light-1440.png");
    await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
    await sleep(300);
  }

  // 7h. identical toasts fold into one with a count; at most 3 visible
  {
    const toasts = await session.evaluate(`(async () => {
      document.querySelectorAll('.toast [aria-label="Dismiss"]').forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 100));
      const k = window.__kbToast;
      if (!k) return 'no hook';
      k('PIT-22 cannot move', 'error'); k('PIT-22 cannot move', 'error'); k('PIT-22 cannot move', 'error');
      k('a', 'info'); k('b', 'info'); k('c', 'info');
      await new Promise((r) => setTimeout(r, 100));
      const nodes = [...document.querySelectorAll('.toast')];
      return { visible: nodes.length, counts: nodes.map((n) => n.querySelector('.toast-count')?.textContent ?? '') };
    })()`);
    check("toasts cap at 3", toasts?.visible === 3, JSON.stringify(toasts));
    const folded = await session.evaluate(`(async () => {
      document.querySelectorAll('.toast [aria-label="Dismiss"]').forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 100));
      window.__kbToast('same refusal', 'error'); window.__kbToast('same refusal', 'error'); window.__kbToast('same refusal', 'error');
      await new Promise((r) => setTimeout(r, 100));
      const nodes = [...document.querySelectorAll('.toast')];
      const out = { visible: nodes.length, count: nodes[0]?.querySelector('.toast-count')?.textContent ?? '' };
      document.querySelectorAll('.toast [aria-label="Dismiss"]').forEach((b) => b.click());
      return out;
    })()`);
    check("identical toasts fold into ×N", folded?.visible === 1 && folded.count === "×3", JSON.stringify(folded));
  }

  // 7i. drag autoscroll: a dragover near the right edge scrolls .board-wrap
  const auto = await session.evaluate(`(async () => {
    const wrap = document.querySelector('.board-wrap');
    const card = document.querySelector('.lane[data-lane="backlog"] .card') ?? document.querySelector('.card');
    if (!card || !wrap) return 'no card/wrap';
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 200));
    const box = wrap.getBoundingClientRect();
    const start = wrap.scrollLeft;
    for (let i = 0; i < 12; i += 1) {
      document.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: box.right - 12, clientY: box.top + 200 }));
      await new Promise((r) => setTimeout(r, 90));
    }
    const end = wrap.scrollLeft;
    const midDragMax = wrap.scrollWidth - wrap.clientWidth;
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const stillScrolling = wrap.scrollLeft !== end;
    return { start, end, stillScrolling, max: wrap.scrollWidth - wrap.clientWidth, midDragMax };
  })()`);
  check(
    "dragging near the right edge autoscrolls the board",
    // Collapsed lanes can fit the viewport — then there is nothing to scroll,
    // which is the intended behaviour; scrolling is only required while the
    // wrap still overflows mid-drag.
    typeof auto === "object" && (auto.end > auto.start || auto.midDragMax <= 0) && !auto.stillScrolling,
    JSON.stringify(auto),
  );

  // 7j. the description editor has an Attach button; dep ids flash the linked card
  const attachBits = await session.evaluate(`(async () => {
    const card = document.querySelector('.lane[data-lane="todo"] .card') ?? document.querySelector('.card');
    card.click();
    await new Promise((r) => setTimeout(r, 600));
    document.querySelector('.panel .body-view')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const attach = document.querySelector('.panel .editor-foot [aria-label="Attach files to description"]');
    const picker = document.querySelector('.panel .editor-foot input[type=file]');
    const editing = !!document.querySelector('.panel .body-editor textarea');
    return { attach: !!attach, picker: !!picker, editing };
  })()`);
  check("the body editor has an Attach button + picker", attachBits?.attach && attachBits.picker && attachBits.editing, JSON.stringify(attachBits));
  await session.shot("k11-attach-light-1440.png");
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  const flashed = await session.evaluate(`(async () => {
    const tag = [...document.querySelectorAll('.card .tag.dep')].find((node) => node.querySelector('.dep-id'));
    if (!tag) return 'no dep tag';
    const id = tag.querySelector('.dep-id').textContent.trim();
    tag.querySelector('.dep-id').click();
    await new Promise((r) => setTimeout(r, 250));
    const target = document.querySelector('.card[data-id="' + id + '"]');
    const panelOpen = !!document.querySelector('.panel');
    const flashing = !!target?.classList.contains('flash');
    const selected = target?.classList.contains('selected');
    document.querySelector('[aria-label="Close details"]')?.click();
    return { id, flashing, selected, panelOpen };
  })()`);
  check(
    "clicking a dep id flashes the linked card without opening it",
    typeof flashed === "object" && flashed.flashing && flashed.selected && !flashed.panelOpen,
    JSON.stringify(flashed),
  );
  await session.shot("k12-flash-light-1440.png");

  // 7k. settings dialog + summarize & archive flow (mutates the board: own home only)
  if (!urlMode) {
    // The Done lane's Summarize button must be visible without hovering.
    const summarizeBtn = await session.evaluate(`(() => {
      const btn = document.querySelector('.lane[data-lane="done"] [aria-label="Summarize & archive"]');
      if (!btn) return null;
      const box = btn.getBoundingClientRect();
      const styles = getComputedStyle(btn);
      return { width: Math.round(box.width), opacity: styles.opacity, text: btn.textContent.trim() };
    })()`);
    check("the Done lane shows a labeled Summarize button", !!summarizeBtn && summarizeBtn.opacity === "1" && /Summarize/.test(summarizeBtn.text), JSON.stringify(summarizeBtn));
    await session.shot("k16-board-summarize-1440.png");

    // needsAgent: no agent configured on a fresh home
    const needs = await session.evaluate(`(async () => {
      const btn = document.querySelector('.lane[data-lane="done"] [aria-label="Summarize & archive"]');
      if (!btn) return 'no summarize button';
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      [...document.querySelectorAll('.dialog .btn.primary')].find((b) => /Generate summary/.test(b.textContent))?.click();
      await new Promise((r) => setTimeout(r, 800));
      const banner = document.querySelector('.dialog .banner');
      const text = banner ? banner.textContent : null;
      const configure = banner ? [...banner.querySelectorAll('button')].find((b) => /agent/i.test(b.textContent)) : null;
      return { text, configure: !!configure };
    })()`);
    check("summarize without pi shows the needsAgent prompt", typeof needs === "object" && /pi|agent/i.test(needs?.text ?? "") && needs.configure, JSON.stringify(needs));
    await session.shot("k13-summarize-needsagent-1440.png");
    // The banner's button opens the Settings dialog (model select + collapsed instruction).
    await session.evaluate(`[...document.querySelectorAll('.dialog .banner button')].find((b) => /pi|agent|settings/i.test(b.textContent))?.click()`);
    await sleep(500);
    const dlg = await session.evaluate(`(() => {
      const dialog = document.querySelector('.dialog');
      if (!dialog) return null;
      const select = dialog.querySelector('[aria-label="Summary model"]');
      const options = select ? [...select.options].map((o) => o.value) : null;
      const collapsed = !dialog.querySelector('[aria-label="Summary instruction"]');
      const customize = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Customize');
      return { options, collapsed, customize: !!customize, hint: dialog.innerText.includes('Default: changelog bullets') };
    })()`);
    check("settings dialog shows the model select + collapsed instruction", dlg && dlg.options?.[0] === "" && dlg.options.includes("test/model-a") && dlg.collapsed && dlg.customize && dlg.hint, JSON.stringify(dlg));
    await session.shot("k14-settings-light-1440.png");
    // "Customize" expands the textarea; pick a model and save.
    const saved = await session.evaluate(`(async () => {
      [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Customize')?.click();
      await new Promise((r) => setTimeout(r, 150));
      const expanded = !!document.querySelector('.dialog [aria-label="Summary instruction"]');
      const select = document.querySelector('.dialog [aria-label="Summary model"]');
      if (select) { select.value = 'test/model-b'; select.dispatchEvent(new Event('change', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 150));
      [...document.querySelectorAll('.dialog .btn.primary')].find((b) => /^Save$/.test(b.textContent.trim()))?.click();
      await new Promise((r) => setTimeout(r, 600));
      const settings = await fetch('/api/settings').then((r) => r.json());
      return { expanded, model: settings.summaryModel, open: !!document.querySelector('.dialog') };
    })()`);
    check("settings saves the summary model", saved?.expanded && saved?.model === "test/model-b" && !saved.open, JSON.stringify(saved));
    // Point piCommand at a stub that echoes the prompt (settings load per request).
    await session.evaluate(`(async () => { await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); })()`);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      piCommand: ["sh", "-c", "cat"],
      models: ["test/model-a", "test/model-b"],
      summaryModel: "test/model-b",
    }));

    // Step 1 with an agent configured: prefilled instruction, done count.
    const opened = await session.evaluate(`(async () => {
      const done = () => document.querySelectorAll('.lane[data-lane="done"] .card').length;
      const before = done();
      document.querySelector('.lane[data-lane="done"] [aria-label="Summarize & archive"]')?.click();
      for (let i = 0; i < 30 && !document.querySelector('.dialog [aria-label="Summary instruction"]')?.value; i += 1) await new Promise((r) => setTimeout(r, 200));
      const instruction = document.querySelector('.dialog [aria-label="Summary instruction"]')?.value ?? '';
      return { before, instruction };
    })()`);
    check("the summarize dialog prefills the instruction", opened?.before === 2 && opened.instruction.length > 10, JSON.stringify({ before: opened?.before, instruction: `${opened?.instruction.length} chars` }));
    await session.shot("k13b-summarize-step1-1440.png");

    // Generate → review → save & archive.
    const gen = await session.evaluate(`(async () => {
      [...document.querySelectorAll('.dialog .btn.primary')].find((b) => /Generate summary/.test(b.textContent))?.click();
      for (let i = 0; i < 40 && !document.querySelector('.dialog .summary-preview'); i += 1) await new Promise((r) => setTimeout(r, 300));
      const preview = !!document.querySelector('.dialog .summary-preview') && !document.querySelector('.dialog [aria-label="Summary (markdown)"]');
      [...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Edit')?.click();
      await new Promise((r) => setTimeout(r, 100));
      const summary = document.querySelector('.dialog [aria-label="Summary (markdown)"]')?.value ?? '';
      const single = !document.querySelector('.dialog .summary-preview');
      return { summary, preview: preview && single };
    })()`);
    check(
      "summarize generates a summary for review",
      gen?.summary.includes("changelog") && gen.summary.includes("Style: plain words only") && !gen.summary.includes("github.com") && gen.preview,
      JSON.stringify(gen),
    );
    await session.shot("k15-summarize-result-1440.png");
    const archived = await session.evaluate(`(async () => {
      const done = () => document.querySelectorAll('.lane[data-lane="done"] .card').length;
      [...document.querySelectorAll('.dialog .btn.primary')].find((b) => /Save & archive/.test(b.textContent))?.click();
      for (let i = 0; i < 30 && document.querySelector('.dialog'); i += 1) await new Promise((r) => setTimeout(r, 300));
      await new Promise((r) => setTimeout(r, 800));
      const toast = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
      return { after: done(), toast };
    })()`);
    check(
      "saving the summary archives the done tasks",
      archived?.after === 0 && /Archived 2 tasks/.test(archived.toast),
      JSON.stringify(archived),
    );
  }

  // 7d. lane ⓘ tooltips — scroll the board back to the left so Todo is visible.
  await session.evaluate(`document.querySelector('.board-wrap').scrollLeft = 0`);
  await sleep(300);
  const scrollBefore = await session.evaluate(`document.querySelector('.board-wrap').scrollLeft`);
  const info = await session.evaluate(`(async () => {
    const btn0 = document.querySelector('.lane[data-lane="todo"] .lane-info');
    if (!btn0) return 'no button';
    btn0.click();
    await new Promise((r) => setTimeout(r, 250));
    const pop = document.querySelector('.popover .lane-info-pop, .lane-info-pop');
    const text = pop?.textContent ?? null;
    // the lane-head may re-render while the popover is open — re-query the button
    const btn = document.querySelector('.lane[data-lane="todo"] .lane-info');
    const br = btn?.getBoundingClientRect();
    const pr = pop?.closest('.popover')?.getBoundingClientRect();
    return { text, scroll: document.querySelector('.board-wrap').scrollLeft,
      btn: br ? [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)] : null,
      pop: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.right), Math.round(pr.bottom)] : null,
      gap: br && pr ? Math.max(0, Math.max(br.left - pr.right, pr.left - br.right)) : null,
      vert: br && pr ? pr.top - br.bottom : null };
  })()`);
  check("lane ⓘ opens the tooltip", typeof info === "object" && /chain-gate|priority/i.test(info?.text ?? ""), JSON.stringify(info));
  check("the tooltip stays anchored to its button", typeof info === "object" && info.gap !== null && info.gap <= 24 && info.vert !== null && info.vert >= 0 && info.vert <= 60, JSON.stringify({ gap: info?.gap, vert: info?.vert }));
  await session.shot("k16-lane-info-1440.png");
  const closed = await session.evaluate(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return !document.querySelector('.lane-info-pop');
  })()`);
  check("Esc closes the lane tooltip", closed === true, String(closed));
  check("opening the tooltip does not scroll the board", typeof info === "object" && info.scroll === scrollBefore, `${scrollBefore} → ${info?.scroll}`);

  // 7e. blocked card shows the reason; the panel shows the banner
  const blockedBits = await session.evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-blocked'));
    return { callout: card?.querySelector('.card-blocked')?.textContent ?? null, id: card?.dataset.id ?? null };
  })()`);
  check("the blocked card shows its reason", /need the API endpoint/.test(blockedBits?.callout ?? ""), JSON.stringify(blockedBits));
  // open the blocked task's panel
  const banner = await session.evaluate(`(async () => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-blocked'));
    card?.click();
    for (let i = 0; i < 30 && !document.querySelector('.blocked-banner'); i += 1) await new Promise((r) => setTimeout(r, 200));
    const banner = document.querySelector('.blocked-banner');
    return { text: banner?.textContent ?? null };
  })()`);
  check("the task panel shows the blocked banner", /Blocked: need the API endpoint/.test(banner?.text ?? "") && /Reply below/.test(banner?.text ?? ""), JSON.stringify(banner));
  await sleep(900); // let the drawer slide-in + transitions settle
  await session.shot("k17-blocked-1440.png");
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  // 7f. the runs-after picker searches ids and titles
  const pickerSearch = await session.evaluate(`(async () => {
    document.querySelector('.sheet-head [aria-label="New task"], .sheet-head [title^="New task"]')?.click();
    for (let i = 0; i < 30 && !document.querySelector('.dialog .prop-chip[aria-label="Runs after"]'); i += 1) await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.dialog [aria-label="Runs after"]')?.click();
    for (let i = 0; i < 30 && !document.querySelector('.dep-picker input'); i += 1) await new Promise((r) => setTimeout(r, 200));
    const input = document.querySelector('.dep-picker input');
    if (!input) return 'no input';
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'chain');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const options = [...document.querySelectorAll('.dep-option')].map((o) => o.textContent.trim());
    return { options, count: document.querySelectorAll('.dep-option').length };
  })()`);
  check("the runs-after picker filters by title/id", typeof pickerSearch === "object" && pickerSearch.count >= 1 && pickerSearch.options.every((o) => /chain/i.test(o)), JSON.stringify(pickerSearch));
  await session.shot("k18-runs-after-1440.png");
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  await session.evaluate(`document.querySelector('.dialog [aria-label="Close"]')?.click()`);
  await sleep(300);

  // 7g. breadcrumb: project crumb returns to the board root
  const crumbBack = await session.evaluate(`(async () => {
    // open a task + a search first so we can see both cleared
    document.querySelector('.card')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const input = document.querySelector('.toolbar .search input');
    if (input) { input.value = 'zzz'; input.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 200));
    const crumb = [...document.querySelectorAll('.crumbs .crumb-link')].at(-1);
    crumb?.click();
    await new Promise((r) => setTimeout(r, 400));
    return { panelClosed: !document.querySelector('.drawer, .task-panel, [class*="drawer"]'), queryCleared: document.querySelector('.toolbar .search input')?.value === '', crumbs: [...document.querySelectorAll('.crumbs .crumb')].map((c) => c.textContent) };
  })()`);
  check("the project crumb returns to the board root", crumbBack?.panelClosed && crumbBack?.queryCleared, JSON.stringify(crumbBack));
  // "Projects" crumb → overview
  const toPicker = await session.evaluate(`(async () => {
    [...document.querySelectorAll('.crumbs .crumb')].find((b) => b.textContent === 'Projects')?.click();
    for (let i = 0; i < 30 && !document.querySelector('.picker'); i += 1) await new Promise((r) => setTimeout(r, 200));
    return !!document.querySelector('.picker');
  })()`);
  check("the Projects crumb opens the overview", toPicker === true, String(toPicker));
  await session.send("Page.navigate", { url: boardUrl(slug) });
  await sleep(1800);

  // 7h. drag collapses unreachable lanes and the source lane stays put
  const collapse = await session.evaluate(`(async () => {
    const card = [...document.querySelectorAll('.lane[data-lane="todo"] .card')].find((c) => !c.dataset.id.includes('locked'));
    if (!card) return 'no card';
    const sourceLane = card.closest('.lane');
    const left0 = sourceLane.getBoundingClientRect().left;
    const dt = new DataTransfer();
    window.__kbDt = dt;
    window.__kbCard = card;
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 400));
    const collapsed = [...document.querySelectorAll('.lane.collapsed')].length;
    const left1 = sourceLane.getBoundingClientRect().left;
    const strips = [...document.querySelectorAll('.lane.collapsed')].map((lane) => {
      const name = lane.querySelector('.lane-name');
      const lr = lane.getBoundingClientRect();
      const nr = name?.getBoundingClientRect();
      const cs = name ? getComputedStyle(name) : null;
      return { lane: lane.dataset.lane, laneW: lr.width, nameW: nr?.width ?? null, nameH: nr?.height ?? null,
        inside: nr ? nr.left >= lr.left - 1 && nr.right <= lr.right + 1 && nr.top >= lr.top - 1 && nr.bottom <= lr.bottom + 1 : null,
        wm: cs?.writingMode, vis: cs?.visibility, op: cs?.opacity, color: cs?.color, text: name?.textContent?.trim().slice(0, 20) };
    });
    return { collapsed, drift: Math.abs(left1 - left0), strips };
  })()`);
  check("dragging collapses unreachable lanes", typeof collapse === "object" && collapse.collapsed >= 2, JSON.stringify(collapse));
  check("the source lane stays put (≤2px)", typeof collapse === "object" && collapse.drift <= 2, `drift ${collapse?.drift}`);
  const stripsOk = Array.isArray(collapse?.strips) && collapse.strips.length > 0 &&
    collapse.strips.every((s) => s.nameW > 4 && s.nameH > 4 && s.inside === true);
  check("each collapsed strip shows its lane name", stripsOk, JSON.stringify(collapse?.strips));
  await session.shot("k19a-mid-drag-1440.png");
  await session.evaluate(`(async () => {
    window.__kbCard?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  })()`);

  // 7i. Done … menu has both archive options; In Review has archive-all
  const menus = await session.evaluate(`(async () => {
    const doneCount = document.querySelectorAll('.lane[data-lane="done"] .card').length;
    const open = async (lane) => {
      document.querySelector('.lane[data-lane="' + lane + '"] [aria-label$="options"]')?.click();
      await new Promise((r) => setTimeout(r, 250));
      const items = [...document.querySelectorAll('.popover [role="menuitem"], .popover [role="option"]')].map((i) => i.textContent.trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      return items;
    };
    return { done: await open('done'), review: await open('in_review'), doneCount };
  })()`);
  check("the Done … menu offers summarize + archive-all", menus?.done.some((i) => /Summarize & archive/.test(i)) && menus?.done.some((i) => /Archive all \(\d+\) without summary/.test(i)), JSON.stringify(menus?.done));
  check("the In Review … menu offers archive-all", menus?.review.some((i) => /Archive all \(\d+\)/.test(i)), JSON.stringify(menus?.review));
  // Screenshot each menu open.
  await session.evaluate(`document.querySelector('.lane[data-lane="done"] [aria-label$="options"]')?.click()`);
  await sleep(300);
  await session.shot("k20a-done-menu-1440.png");
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  await session.evaluate(`document.querySelector('.lane[data-lane="in_review"] [aria-label$="options"]')?.click()`);
  await sleep(300);
  await session.shot("k20b-review-menu-1440.png");
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);

  // 7j. projects overview: archived projects section
  const archivedList = await session.evaluate(`(async () => {
    // archive a project via the API, then open the overview
    const list = await fetch('/api/projects').then((r) => r.json());
    const other = list.find((p) => p.slug !== ${JSON.stringify("${slug}")});
    return { count: list.length, other: other?.slug ?? null };
  })()`);
  if (archivedList?.other) {
    await session.evaluate(`fetch('/api/projects/${archivedList.other}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"archived":true}' })`);
  }
  const overview = await session.evaluate(`(async () => {
    [...document.querySelectorAll('.crumbs .crumb')].find((b) => b.textContent === 'Projects')?.click();
    for (let i = 0; i < 30 && !document.querySelector('.picker'); i += 1) await new Promise((r) => setTimeout(r, 200));
    const head = document.querySelector('.archived-head');
    head?.click();
    await new Promise((r) => setTimeout(r, 300));
    return { head: head?.textContent ?? null, cards: document.querySelectorAll('.archived-section .project-card').length };
  })()`);
  check("the overview has a collapsed Archived section", overview?.head === null || (overview?.head?.includes("Archived") && overview.cards >= 1), JSON.stringify(overview));
  await session.shot("k22-archived-section-1440.png");
  if (archivedList?.other) {
    await session.evaluate(`fetch('/api/projects/${archivedList.other}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"archived":false}' })`);
  }

  // 7k. mobile 390×844: header never wraps, logo menu carries the rail
  await session.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await session.send("Page.navigate", { url: boardUrl(slug) });
  await sleep(1800);
  const mobile = await session.evaluate(`(async () => {
    const head = document.querySelector('.sheet-head');
    const logo = document.querySelector('.mobile-logo');
    logo?.click();
    for (let i = 0; i < 20 && !document.querySelector('.popover'); i += 1) await new Promise((r) => setTimeout(r, 150));
    const pop = [...document.querySelectorAll('.popover [role="menuitem"], .popover [role="option"]')].map((i) => i.textContent.trim());
    const rect = head?.getBoundingClientRect();
    return {
      headHeight: rect?.height ?? null,
      wrapped: [...(head?.children ?? [])].reduce((top, el) => Math.min(top, el.getBoundingClientRect().top), Infinity),
      sidebarHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
      logoVisible: !!logo,
      menu: pop,
    };
  })()`);
  check("mobile hides the rail and shows the logo menu", mobile?.sidebarHidden && mobile?.logoVisible && mobile.menu.length > 3, JSON.stringify(mobile?.menu));
  check("the mobile header does not wrap", mobile?.headHeight !== null && mobile.headHeight <= 52 && mobile.wrapped !== Infinity && Math.abs(mobile.wrapped - 0) < 400, JSON.stringify({ h: mobile?.headHeight }));
  await session.shot("k21-mobile-menu-390.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

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
