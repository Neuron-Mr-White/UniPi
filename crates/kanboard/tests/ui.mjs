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

  // 1. the picker page (a single project auto-opens, so use the switcher)
  await session.evaluate(`document.querySelector('.brand') && document.querySelectorAll('button').length`);
  await session.evaluate(`(() => {
    const switcher = [...document.querySelectorAll('.topbar button')].find((b) => b.getAttribute('aria-haspopup') === 'listbox');
    return switcher ? 'has switcher' : 'no switcher';
  })()`);
  await session.evaluate(`(() => {
    const all = [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.includes('All projects'));
    if (all) { all.click(); return; }
    const switcher = [...document.querySelectorAll('.topbar button')].find((b) => b.getAttribute('aria-haspopup') === 'listbox');
    switcher?.click();
  })()`);
  await sleep(600);
  await session.evaluate(`(() => {
    const all = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('All projects'));
    all?.click();
  })()`);
  await sleep(900);
  const picker = await session.until(`document.querySelectorAll('.project-card').length`, (n) => n >= 1, 20000);
  check("project picker lists projects", picker >= 1, `${picker} cards`);
  await session.shot("k6-picker-light-1440.png");

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
    const title = [...document.querySelectorAll('.card .title')].find((node) => node.textContent.length > 100);
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
  check("lane width is ~300px", Math.abs(geometry.laneWidth - 300) <= 2, `${Math.round(geometry.laneWidth)}px`);

  // 3. scrollbar is themed (not the browser default white)
  const scroll = await session.evaluate(`(() => {
    document.querySelector('.board-wrap').style.scrollbarColor = '';
    return getComputedStyle(document.querySelector('.board-wrap')).scrollbarColor;
  })()`);
  check("board scrollbar is themed", /rgb|#/.test(String(scroll)), String(scroll));

  // 4. detail panel opens and closes
  const openedLong = await session.evaluate(`(() => {
    const title = [...document.querySelectorAll('.card .title')].find((node) => node.textContent.length > 100);
    const card = title?.closest('.card') ?? document.querySelector('.card');
    card.click();
    return title ? 'long' : 'first';
  })()`);
  await sleep(700);
  const panel = await session.evaluate(`(() => {
    const node = document.querySelector('.panel');
    if (!node) return null;
    return { title: node.querySelector('.title-input')?.value ?? '', tabs: node.querySelectorAll('.tabs button').length, timeline: node.querySelectorAll('.timeline li').length };
  })()`);
  check("detail panel opens with the task", !!panel && panel.title.length > 0, panel ? `${panel.title.length}-char title` : "missing");
  check("panel has edit/preview + a timeline", !!panel && panel.tabs === 2 && panel.timeline >= 1);
  const panelBits = await session.evaluate(`(() => {
    const button = (label) => [...document.querySelectorAll('.panel button')].find((node) => node.textContent.trim() === label);
    const describe = (label) => {
      const node = button(label);
      if (!node) return { label, missing: true };
      const style = getComputedStyle(node);
      return { label, background: style.backgroundColor, border: style.borderTopColor, radius: style.borderRadius, color: style.color };
    };
    const select = document.querySelector('.panel #status');
    const wrap = select?.closest('.select-wrap');
    return {
      buttons: [describe("Duplicate"), describe("Cancel task")],
      statusOptions: [...(select?.options ?? [])].map((option) => option.value),
      statusValue: select?.value ?? null,
      appearance: select ? getComputedStyle(select).appearance : null,
      chevron: !!wrap?.querySelector('svg'),
      title: document.querySelector('.panel .title-input')?.value ?? '',
      titleLength: (document.querySelector('.panel .title-input')?.value ?? '').length,
    };
  })()`);
  const chrome = (entry) => !entry.missing && !/rgba\(0, 0, 0, 0\)|transparent/.test(entry.background);
  check(
    "Duplicate / Cancel task are real buttons",
    panelBits.buttons.every(chrome),
    panelBits.buttons.map((entry) => `${entry.label}:${entry.background}`).join(" · "),
  );
  const themed = panelBits.appearance === "none" && panelBits.chevron;
  check("Status/Priority use the themed select", themed, `appearance=${panelBits.appearance} chevron=${panelBits.chevron}`);
  // Read the rules through the page: it already holds the daemon token and a
  // working route to the host (Node's fetch can be blocked by proxies/env).
  const token = new URLSearchParams(base.split("?")[1] ?? "").get("t");
  const rulesDoc = await session.evaluate(
    `fetch('/api/rules${token ? `?t=${token}` : ""}').then((response) => response.json())`,
  );
  const allowed = new Set([panelBits.statusValue, ...(rulesDoc.allowedMoves?.[panelBits.statusValue] ?? [])]);
  check(
    "the status select offers allowed moves only",
    panelBits.statusOptions.every((option) => allowed.has(option)) && panelBits.statusOptions.includes(panelBits.statusValue),
    panelBits.statusOptions.join(","),
  );
  if (openedLong === "long") {
    check("the clamped title is intact in the panel", panelBits.titleLength === 140, `${panelBits.titleLength} chars`);
  } else {
    check("the panel shows the task title", panelBits.titleLength > 0, `opened ${openedLong} card`);
  }
  await session.shot("k6-detail-light-1440.png");
  await session.evaluate(`document.querySelector('.panel-head button').click()`);
  await sleep(400);

  // 5. drag a todo card into backlog (HTML5 drag events, real handlers)
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
    const modalOpen = !!document.querySelector('.modal');
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
    const node = document.querySelector('.modal');
    return node ? node.querySelector('.prompt')?.textContent ?? 'no prompt' : 'no modal';
  })()`);
  check("comment-required move shows the modal", typeof modal === "string" && !modal.startsWith("no "), String(modal));
  await session.shot("k6-comment-light-1440.png");
  await session.evaluate(`document.querySelector('.dialog-head button').click()`);
  await sleep(300);

  // 7. new-task dialog
  await session.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('New task')).click()`);
  await sleep(600);
  const dialog = await session.evaluate(`(() => {
    const node = document.querySelector('.dialog');
    return node ? node.querySelectorAll('input, textarea, select').length : 0;
  })()`);
  check("new-task dialog opens", dialog >= 5, `${dialog} fields`);
  await session.shot("k6-newtask-light-1440.png");
  await session.evaluate(`document.querySelector('.dialog-head button').click()`);
  await sleep(300);

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
  await session.shot("k6-board-light-1440.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await session.shot("k6-board-light-1920.png");
  await session.evaluate(`document.querySelector('[aria-label="Toggle theme"]').click()`);
  await sleep(400);
  await session.shot("k6-board-dark-1920.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await session.shot("k6-board-dark-800.png");

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
