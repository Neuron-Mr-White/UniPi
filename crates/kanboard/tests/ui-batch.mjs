#!/usr/bin/env node
/**
 * Focused UI flows for the UNI-51/57/58/59/60/61/62/63 batch, driven over CDP
 * (same approach as ui.mjs, own temp daemon; no Playwright dependency).
 *
 *   node crates/kanboard/tests/ui-batch.mjs --shots /tmp/uni57-shots
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const binary = process.env.UNIPI_KANBOARD_BIN ?? join(repo, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const CDP_PORT = Number(process.env.CDP_PORT ?? 9341);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const shotDir = flag("--shots", null);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// ── temp daemon + seed (never touches a real board) ─────────────────────────
const home = mkdtempSync(join(tmpdir(), "kb-batch-home-"));
const workspace = mkdtempSync(join(tmpdir(), "kb-batch-ws-"));
const env = { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_NO_WATCH: "1" };
const kb = (...call) => JSON.parse(execFileSync(binary, [...call, "--json"], { env, cwd: workspace, encoding: "utf-8" }));
const slug = kb("project", "add", "--name", "Batch Project").slug;
const seeded = {};
for (const [name, status] of [["cancel me", "todo"], ["undo done", "todo"], ["quoted \"title\"", "todo"], ["blocked close", "todo"]]) {
  seeded[name] = kb("add", name, "--status", "todo").id;
}
// blocked → done fixture: claim + release to blocked.
{
  const id = seeded["blocked close"];
  kb("start", id, "--actor", "agent", "--session", "batch", "--pid", String(process.pid));
  kb("move", id, "blocked", "--comment", "need input", "--actor", "agent", "--session", "batch");
}
// a claimed (running) task for the global agents list.
{
  seeded["running elsewhere"] = kb("add", "running elsewhere", "--status", "todo").id;
  kb("start", seeded["running elsewhere"], "--actor", "agent", "--session", "batch-run", "--pid", String(process.pid));
}
// a second, archived project + a second active project (navigate-before-undo).
{
  const otherRoot = mkdtempSync(join(tmpdir(), "kb-batch-other-"));
  const otherSlug = kb("project", "add", "--root", otherRoot, "--name", "Old Project").slug;
  kb("project", "archive", otherSlug);
  const secondRoot = mkdtempSync(join(tmpdir(), "kb-batch-second-"));
  const second = kb("project", "add", "--root", secondRoot, "--name", "Second Project");
  globalThis.secondSlug = second.slug;
  execFileSync(binary, ["--project", second.slug, "add", "second project task", "--status", "todo", "--json"], { env, cwd: secondRoot, encoding: "utf-8" });
}
const port = 4680 + (process.pid % 100);
const server = spawn(binary, ["serve", "--port", String(port), "--idle-secs", "900"], { env, cwd: workspace, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    if ((await (await fetch(`${base}/api/health`)).json()).ok) break;
  } catch { /* not up yet */ }
  await sleep(250);
}

const cleanup = () => {
  server?.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
};

// ── CDP plumbing (trimmed from ui.mjs) ──────────────────────────────────────
async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* chromium still starting */ }
    await sleep(250);
  }
  throw new Error("no CDP page target");
}
class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    const session = new Session(ws);
    ws.onclose = () => { for (const [, entry] of session.pending) entry.reject(new Error("CDP socket closed")); session.pending.clear(); };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const entry = message.id && session.pending.get(message.id);
      if (!entry) return;
      session.pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    };
    return session;
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600) + " | expr[" + expression.length + "]: " + expression);
    return result.result?.value;
  }
  async until(expression, accept, timeoutMs = 15000, step = 300) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try { last = await this.evaluate(expression); if (accept(last)) return last; } catch (error) { last = `error: ${error.message}`; }
      if (Date.now() > deadline) return last;
      await sleep(step);
    }
  }
  async shot(file) {
    if (!shotDir) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(join(shotDir, file), Buffer.from(data, "base64"));
    console.log(`  saved ${join(shotDir, file)}`);
  }
}

const chromium = spawn("chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "kb-batch-chrome-"))}`,
  "about:blank",
], { stdio: "ignore" });

const type = (selector, value) => {
  const el = document.querySelector(selector);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  el.focus();
  set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

try {
  const page = await pageTarget();
  const session = await Session.open(page.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__kbErrors = []; window.addEventListener('error', (e) => window.__kbErrors.push(String(e.message)));`,
  });
  const boardUrl = (project) => `${base}${project !== undefined ? `?project=${project}` : ""}`;
  const post = (path, body) => `fetch('${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then((r) => r.json())`;

  await session.send("Page.navigate", { url: boardUrl(slug) });
  await session.until(`document.querySelectorAll('.lane').length`, (n) => n >= 7, 25000);

  // ═══ UNI-60: labels in the Add form + chips right of the id ══════════════
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
  await sleep(400);
  await session.evaluate(`(${type.toString()})('.dialog-title-input', 'labeled task')`);
  await session.evaluate(`document.querySelector('.dialog [aria-label="Labels"]').click()`);
  await sleep(250);
  const created1 = await session.evaluate(`(async () => {
    const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
    const input = document.querySelector('.label-picker input');
    (${type.toString()})('.label-picker input', 'web');
    await tick();
    const create = [...document.querySelectorAll('.label-picker .menu-item')].find((b) => /Create/.test(b.textContent));
    create.click();
    await tick();
    (${type.toString()})('.label-picker input', 'ui');
    await tick();
    [...document.querySelectorAll('.label-picker .menu-item')].find((b) => /Create/.test(b.textContent)).click();
    await tick();
    return [...document.querySelectorAll('.dialog [aria-label="Labels"]')].map((n) => n.textContent.trim()).join('|');
  })()`);
  check("UNI-60 Add form creates labels via searchable picker", created1 === "web, ui", created1);
  await session.evaluate(`[...document.querySelectorAll('.dialog .btn.primary')].find((b) => /Create task/.test(b.textContent)).click()`);
  await sleep(800);
  const labeled = await session.evaluate(`fetch('/api/projects/${slug}/tasks').then((r) => r.json()).then((d) => d.tasks.find((t) => t.title === 'labeled task'))`);
  check("UNI-60 created task carries both labels", JSON.stringify(labeled?.labels) === JSON.stringify(["web", "ui"]), JSON.stringify(labeled?.labels));
  await session.evaluate(`fetch('/api/projects/${slug}/tasks').then(() => location.reload())`);
  await sleep(1200);
  const chip = await session.evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'labeled task');
    if (!card) return null;
    const id = card.querySelector('.card-id');
    const chips = [...card.querySelectorAll('.card-top .tag.label')];
    const next = id.nextElementSibling;
    const color = chips[0] ? getComputedStyle(chips[0]).borderLeftColor : null;
    const width = chips[0] ? getComputedStyle(chips[0]).borderLeftWidth : null;
    return { rightOfId: next === chips[0], count: chips.length, labels: chips.map((c) => c.textContent.trim()), color, width, metaLabels: card.querySelectorAll('.card-meta .tag.label').length };
  })()`);
  check("UNI-60 chips render immediately right of the card id", chip?.rightOfId && chip.count === 2, JSON.stringify(chip));
  check("UNI-60 chip has a hash-coloured left border", chip && chip.width === "3px" && /^(rgb|oklch|hsl)\(/.test(chip.color ?? ""), `${chip?.width} ${chip?.color}`);
  await session.shot("batch-labels-card.png");

  // ═══ UNI-61: create dialog — backdrop/Esc keep drafts; explicit close confirms ═
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
  await sleep(300);
  await session.evaluate(`(${type.toString()})('.dialog-title-input', 'precious draft')`);
  await session.evaluate(`document.querySelector('.overlay').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, target: document.querySelector('.overlay') }))`);
  await sleep(200);
  const stillOpen1 = await session.evaluate(`!!document.querySelector('.dialog') && document.querySelector('.dialog-title-input').value`);
  check("UNI-61 backdrop click keeps the dirty create dialog", stillOpen1 === "precious draft", String(stillOpen1));
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  const stillOpen2 = await session.evaluate(`!!document.querySelector('.dialog')`);
  check("UNI-61 Esc keeps the dirty create dialog", stillOpen2 === true);
  await session.evaluate(`[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Cancel').click()`);
  await sleep(200);
  const confirmShown = await session.evaluate(`!!document.querySelector('.discard-strip')`);
  check("UNI-61 Cancel on a dirty form asks before discarding", confirmShown === true);
  await session.shot("batch-discard-confirm.png");
  await session.evaluate(`[...document.querySelectorAll('.discard-strip .btn')].find((b) => /Discard/.test(b.textContent)).click()`);
  await sleep(200);
  check("UNI-61 explicit Discard closes the create dialog", (await session.evaluate(`!!document.querySelector('.dialog')`)) === false);
  // clean dialog: Esc closes right away
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
  await sleep(300);
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check("UNI-61 Esc closes a clean create dialog", (await session.evaluate(`!!document.querySelector('.dialog')`)) === false);

  // ═══ UNI-61: drawer — scrim/Esc guard drafts; explicit close confirms ════
  await session.evaluate(`document.querySelector('.lane[data-lane="todo"] .card').click()`);
  await sleep(600);
  await session.evaluate(`(() => {
    const area = document.querySelector('.panel .title-edit');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    area.focus(); set.call(area, 'typed but unsaved'); area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await session.evaluate(`document.querySelector('.drawer-scrim').click()`);
  await sleep(200);
  check("UNI-61 drawer scrim keeps dirty drafts", (await session.evaluate(`!!document.querySelector('.panel')`)) === true);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check("UNI-61 drawer Esc keeps dirty drafts", (await session.evaluate(`!!document.querySelector('.panel')`)) === true);
  await session.evaluate(`document.querySelector('[aria-label="Close details"]').click()`);
  await sleep(200);
  check("UNI-61 drawer explicit close asks on dirty", (await session.evaluate(`!!document.querySelector('.panel .discard-strip')`)) === true);
  await session.evaluate(`[...document.querySelectorAll('.panel .discard-strip .btn')].find((b) => /Discard/.test(b.textContent)).click()`);
  await sleep(200);
  check("UNI-61 drawer explicit Discard closes", (await session.evaluate(`!!document.querySelector('.panel')`)) === false);

  // ═══ UNI-58: quotes survive save + reload untouched ═════════════════════
  const quotedId = seeded['quoted "title"'];
  const quoteResult = await session.evaluate(`(async () => {
    const show = await fetch('/api/tasks/${slug}/${quotedId}').then((r) => r.json());
    return show.title;
  })()`);
  check("UNI-58 quoted title parses back clean", quoteResult === 'quoted "title"', quoteResult);
  await session.evaluate(`fetch('/api/tasks/${slug}/${quotedId}/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'quoted "title" v2' }) })`);
  await session.evaluate(`location.reload()`);
  await sleep(1200);
  const quoteAgain = await session.evaluate(`fetch('/api/tasks/${slug}/${quotedId}').then((r) => r.json()).then((d) => d.title)`);
  check("UNI-58 re-save does not grow backslashes", quoteAgain === 'quoted "title" v2', quoteAgain);

  // ═══ UNI-57: cancel via drag → undo toast → undo restores ═══════════════
  const cancelFlow = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = [...document.querySelectorAll('.lane[data-lane="todo"] .card')].find((c) => c.querySelector('.card-title').textContent === 'cancel me');
    if (!card) return 'no card';
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const lane = document.querySelector('.lane[data-lane="cancelled"]');
    lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    for (let i = 0; i < 10; i += 1) { await tick(300); const t = [...document.querySelectorAll('.toast')].find((n) => /Undo/.test(n.textContent)); if (t) return 'toast: ' + t.textContent.trim(); }
    return 'no toast';
  })()`);
  check("UNI-57 cancelling shows an Undo toast", String(cancelFlow).startsWith("toast:"), String(cancelFlow));
  await session.shot("batch-undo-toast.png");
  await session.evaluate(`[...document.querySelectorAll('.toast .btn')].find((b) => b.textContent.trim() === 'Undo').click()`);
  await session.until(`!!document.querySelector('.lane[data-lane="todo"] .card')`, (v) => v, 8000);
  const restored = await session.evaluate(`fetch('/api/tasks/${slug}/${seeded["cancel me"]}').then((r) => r.json()).then((d) => d.status + '|' + d.activity.at(-1).text)`);
  check("UNI-57 undo restores the cancelled task to todo with an undo entry", restored === "todo|undo: cancelled → todo (state restored)", restored);

  // ═══ UNI-57: stale intervening change refuses the undo ══════════════════
  await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = [...document.querySelectorAll('.lane[data-lane="todo"] .card')].find((c) => c.querySelector('.card-title').textContent === 'undo done');
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const lane = document.querySelector('.lane[data-lane="cancelled"]');
    lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    for (let i = 0; i < 10; i += 1) { await tick(300); if ([...document.querySelectorAll('.toast')].some((n) => /Undo/.test(n.textContent))) break; }
  })()`);
  await session.evaluate(post(`/api/tasks/${slug}/${seeded["undo done"]}/note`, { text: "intervening!" }));
  await sleep(200);
  const staleResult = await session.evaluate(`(async () => {
    [...document.querySelectorAll('.toast .btn')].find((b) => b.textContent.trim() === 'Undo').click();
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 10; i += 1) { await tick(300); const t = [...document.querySelectorAll('.toast.error')].at(-1); if (t && /changed since|no longer available/.test(t.textContent)) return t.textContent.trim(); }
    return 'no error toast: ' + [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
  })()`);
  check("UNI-57 stale undo refuses with an error toast", /changed since|no longer available/.test(String(staleResult)), String(staleResult));
  const stillCancelled = await session.evaluate(`fetch('/api/tasks/${slug}/${seeded["undo done"]}').then((r) => r.json()).then((d) => d.status)`);
  check("UNI-57 refused undo leaves the task cancelled", stillCancelled === "cancelled", stillCancelled);

  // ═══ UNI-63 + UNI-57: blocked → done from the panel, undo restores blocked ═
  await session.evaluate(`document.querySelectorAll('.lane[data-lane="blocked"] .card')[0].click()`);
  await sleep(600);
  await session.evaluate(`document.querySelector('.panel #status').click()`);
  await sleep(300);
  const statusOptions = await session.evaluate(`[...document.querySelectorAll('.popover [role=option] .menu-label')].map((n) => n.textContent.trim())`);
  check("UNI-63 blocked task offers Done in the status menu", statusOptions.includes("Done"), statusOptions.join(", "));
  await session.evaluate(`[...document.querySelectorAll('.popover [role=option]')].find((n) => n.textContent.includes('Done')).click()`);
  await sleep(800);
  const blockedDone = await session.evaluate(`fetch('/api/tasks/${slug}/${seeded["blocked close"]}').then((r) => r.json()).then((d) => d.status)`);
  check("UNI-63 blocked → done moves", blockedDone === "done", blockedDone);
  const blockedUndoToast = await session.evaluate(`!![...document.querySelectorAll('.toast')].find((n) => /Undo/.test(n.textContent))`);
  check("UNI-57 blocked → done offers Undo", blockedUndoToast === true);
  await session.evaluate(`[...document.querySelectorAll('.toast .btn')].filter((b) => b.textContent.trim() === 'Undo').at(-1).click()`);
  await sleep(900);
  const blockedRestored = await session.evaluate(`fetch('/api/tasks/${slug}/${seeded["blocked close"]}').then((r) => r.json()).then((d) => d.status)`);
  check("UNI-57 blocked → done undo restores blocked", blockedRestored === "blocked", blockedRestored);
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  // ═══ UNI-57: cancelled cards are not draggable; context menu Recreates ════
  await session.evaluate(post(`/api/tasks/${slug}/${seeded["cancel me"]}/move`, { status: "cancelled" }));
  await sleep(900);
  const dragState = await session.evaluate(`(() => {
    const card = [...document.querySelectorAll('.lane[data-lane="cancelled"] .card')][0];
    return { draggable: card.getAttribute('draggable'), final: card.classList.contains('final') };
  })()`);
  check("UNI-57 cancelled card is final and not draggable", dragState.draggable === "false" && dragState.final === true, JSON.stringify(dragState));
  const clickedTitle = await session.evaluate(`(() => {
    const card = [...document.querySelectorAll('.lane[data-lane="cancelled"] .card')][0];
    const box = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 10, clientY: box.top + 10 }));
    return card.querySelector('.card-title').textContent;
  })()`);
  await sleep(300);
  const menuItems = await session.evaluate(`[...document.querySelectorAll('.card-menu .menu-item')].map((n) => n.textContent.trim())`);
  check("UNI-57 cancelled card context menu offers Recreate", menuItems.includes("Recreate task…"), menuItems.join(", "));
  await session.shot("batch-recreate-menu.png");
  await session.evaluate(`[...document.querySelectorAll('.card-menu .menu-item')].find((n) => /Recreate/.test(n.textContent)).click()`);
  await sleep(500);
  const recreateDialog = await session.evaluate(`(() => ({
    open: !!document.querySelector('.dialog'),
    heading: document.querySelector('.dialog-head span:last-of-type')?.textContent ?? document.querySelector('.dialog-head')?.textContent ?? '',
    banner: !!document.querySelector('.recreate-banner'),
    title: document.querySelector('.dialog-title-input')?.value,
    lane: document.querySelector('.dialog [aria-label="Status"]')?.textContent.trim(),
  }))()`);
  check("UNI-57 Recreate opens the Add modal prefilled", recreateDialog.open && recreateDialog.banner && recreateDialog.title === clickedTitle, JSON.stringify({ ...recreateDialog, clickedTitle }));
  await session.shot("batch-recreate-modal.png");
  await session.evaluate(`[...document.querySelectorAll('.dialog .btn.primary')].find((b) => /Create task/.test(b.textContent)).click()`);
  await sleep(900);
  const recreated = await session.evaluate(`(async (title) => {
    await new Promise((r) => setTimeout(r, 1200));
    const d = await fetch('/api/projects/${slug}/tasks?status=todo').then((r) => r.json());
    const t = d.tasks.find((t) => t.title === title);
    return { found: t ? { id: t.id, activity: t.activity.length, comments: t.activity.filter((a) => !a.text.startsWith('created')).length, creator: t.creator } : null,
      todoTitles: d.tasks.map((t) => t.title), dialogStillOpen: !!document.querySelector('.dialog'), toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent) };
  })(${JSON.stringify(clickedTitle)})`);
  const recreatedTask = recreated?.found ?? null;
  check("UNI-57 Recreate made a NEW todo task with no history", !!recreatedTask && recreatedTask.id !== seeded[clickedTitle] && recreatedTask.activity === 1 && recreatedTask.creator === "user", JSON.stringify(recreated));

  // ═══ UNI-59: creator display + agent creator ════════════════════════════
  await session.evaluate(`document.querySelector('.lane[data-lane="todo"] .card').click()`);
  await sleep(600);
  const creatorShown = await session.evaluate(`(() => {
    const labels = [...document.querySelectorAll('.panel .meta-lines dt')].map((n) => n.textContent);
    const at = labels.indexOf('Created by');
    return at === -1 ? null : document.querySelectorAll('.panel .meta-lines dd')[at].textContent;
  })()`);
  check("UNI-59 drawer shows Created by", creatorShown === "user", String(creatorShown));
  await session.evaluate(`document.querySelector('[aria-label="Close details"]').click()`);
  await sleep(300);

  // ═══ UNI-51: global running agents + navigation from the dashboard ═══════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(800);
  const dashboard = await session.evaluate(`(() => ({
    picker: !!document.querySelector('.picker'),
    stats: document.querySelector('.picker-stats')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    agents: [...document.querySelectorAll('.sidebar .agent-row')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    ringOnDashboard: !!document.querySelector('.project-card .running-tile.is-running'),
  }))()`);
  check("UNI-51 dashboard shows the global agent (sidebar, any view)", !!dashboard.ringOnDashboard && dashboard.agents.some((a) => /Batch Project/.test(a) && /running elsewhere/.test(a)), JSON.stringify(dashboard));
  await session.shot("batch-dashboard.png");
  const ring = await session.evaluate(`(() => {
    const node = document.querySelector('.sidebar .running-tile.is-running');
    if (!node) return null;
    const before = getComputedStyle(node, '::before').animationName;
    return { before, present: true };
  })()`);
  check("UNI-51 running project tile carries the animated ring", !!ring && ring.before === "ring-spin", JSON.stringify(ring));
  await session.evaluate(`document.querySelector('.sidebar .agent-row').click()`);
  await sleep(1200);
  const navigated = await session.evaluate(`(() => ({
    project: new URLSearchParams(location.search).get('project'),
    panelTask: document.querySelector('.panel .crumb-pill')?.textContent.trim() ?? null,
    title: document.querySelector('.panel .title-edit')?.value ?? null,
  }))()`);
  check("UNI-51 clicking a global agent opens its project and task", !!navigated.project && navigated.panelTask === seeded["running elsewhere"] && navigated.title === "running elsewhere", JSON.stringify({ ...navigated, expected: seeded["running elsewhere"] }));
  // reduced motion: the ring must not animate
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedRing = await session.evaluate(`(() => {
    const node = document.querySelector('.running-tile.is-running');
    if (!node) return null;
    return getComputedStyle(node, '::before').animationName;
  })()`);
  check("UNI-51 ring is static under prefers-reduced-motion", reducedRing === "none", String(reducedRing));
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });

  // ═══ UNI-51: sidebar archive menu + collapsed Archived section ═══════════
  // Rework: the sidebar rows are right-click ONLY (no ellipsis buttons).
  check("UNI-51 sidebar rows have no ellipsis buttons", (await session.evaluate(`document.querySelectorAll('.sidebar .nav-row .nav-more').length`)) === 0);
  await session.evaluate(`(async () => {
    const row = document.querySelector('.sidebar .nav-row:not(.archived)');
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }));
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.card-menu .menu-item')].find((n) => n.textContent.trim() === 'Archive').click();
  })()`);
  await sleep(1000);
  const archived = await session.evaluate(`(() => ({
    activeRows: document.querySelectorAll('.sidebar .nav-row:not(.archived)').length,
    section: [...document.querySelectorAll('.sb-archived > .sb-section')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).at(0) ?? null,
  }))()`);
  check("UNI-51 sidebar Archive moves the project out of Projects", archived.activeRows === 1 && /Archived/.test(archived.section ?? ""), JSON.stringify(archived));
  await session.evaluate(`document.querySelector('.sb-archived > .sb-section').click()`);
  await sleep(300);
  await session.evaluate(`(async () => {
    const row = document.querySelector('.sb-archived .nav-row.archived');
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }));
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.card-menu .menu-item')].find((n) => n.textContent.trim() === 'Unarchive').click();
  })()`);
  await sleep(1000);
  const unarchived = await session.evaluate(`document.querySelectorAll('.sidebar .nav-row:not(.archived)').length`);
  check("UNI-51 sidebar Unarchive brings the project back", unarchived === 2, String(unarchived));
  await session.shot("batch-sidebar-projects.png");

  // ═══ UNI-51 rework: right-click sidebar rows (active + archived) ═══════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(700);
  const activeRowMenu = await session.evaluate(`(async () => {
    const row = document.querySelector('.sidebar .nav-row:not(.archived)');
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }));
    await new Promise((r) => setTimeout(r, 300));
    const menu = document.querySelector('.card-menu');
    return menu ? { items: [...menu.querySelectorAll('.menu-item .menu-label')].map((n) => n.textContent.trim()) } : null;
  })()`);
  check("UNI-51 right-click on an active sidebar row opens the project menu", activeRowMenu?.items?.includes("Archive") && activeRowMenu.items.includes("Open"), JSON.stringify(activeRowMenu));
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  // Expand the section only when collapsed (a previous flow may have left it open).
  await session.evaluate(`(() => {
    const head = document.querySelector('.sb-archived > .sb-section');
    if (head && head.getAttribute('aria-expanded') === 'false') head.click();
  })()`);
  await sleep(300);
  const archivedRowMenu = await session.evaluate(`(async () => {
    const row = document.querySelector('.sb-archived .nav-row.archived');
    if (!row) return null;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }));
    await new Promise((r) => setTimeout(r, 300));
    const menu = document.querySelector('.card-menu');
    return menu ? { items: [...menu.querySelectorAll('.menu-item .menu-label')].map((n) => n.textContent.trim()) } : null;
  })()`);
  check("UNI-51 right-click on an archived sidebar row offers Unarchive", archivedRowMenu?.items?.includes("Unarchive"), JSON.stringify(archivedRowMenu));
  // Archive via right-click actually archives.
  await session.evaluate(`[...document.querySelectorAll('.card-menu .menu-item')].find((n) => n.textContent.trim() === 'Unarchive').click()`);
  await sleep(900);
  const stillArchived = await session.evaluate(`fetch('/api/projects').then((r) => r.json()).then((projects) => {
    const old = projects.find((p) => p.name === 'Old Project');
    return { archived: old?.archived, count: projects.filter((p) => p.archived).length };
  })`);
  check("UNI-51 right-click Unarchive persists", stillArchived.archived === false, JSON.stringify(stillArchived));
  await session.shot("batch-sidebar-rightclick.png");

  // ═══ UNI-57 rework: move → navigate to another project → Undo ══════════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(600);
  await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('.sidebar .nav-row')].find((r) => r.textContent.includes('Batch Project'));
    row?.querySelector('.nav-item').click();
  })()`);
  await sleep(900);
  const moveNavigate = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = document.querySelector('.lane[data-lane="todo"] .card');
    if (!card) return 'no card';
    globalThis.__batchMoveId = card.dataset.id;
    card.click();
    await tick(600);
    document.querySelector('.panel #status').click();
    await tick(300);
    [...document.querySelectorAll('.popover [role=option]')].find((n) => n.textContent.includes('Cancelled')).click();
    for (let i = 0; i < 12; i += 1) { await tick(300); if ([...document.querySelectorAll('.toast')].some((n) => /Undo/.test(n.textContent))) break; }
    const toastButton = [...document.querySelectorAll('.toast .btn')].find((b) => b.textContent.trim() === 'Undo');
    if (!toastButton) return 'no undo toast';
    // Navigate to the OTHER project with the undo still pending.
    [...document.querySelectorAll('.sidebar .nav-row')].find((r) => r.textContent.includes('Second Project')).querySelector('.nav-item').click();
    await tick(1000);
    toastButton.click();
    await tick(1200);
    return { movedId: globalThis.__batchMoveId, otherBoardIds: [...document.querySelectorAll('.card')].map((c) => c.dataset.id) };
  })()`);  const undoIsolation = await session.evaluate(`(async () => {
    const movedId = globalThis.__batchMoveId;
    const batchBoard = await fetch('/api/projects/${slug}/tasks').then((r) => r.json());
    const moved = batchBoard.tasks.find((t) => t.id === movedId);
    const project = new URLSearchParams(location.search).get('project');
    const here = await fetch('/api/projects/' + project + '/tasks').then((r) => r.json());
    return {
      movedId,
      movedStatus: moved?.status,
      undoActivity: moved?.activity.filter((a) => a.text.startsWith('undo')).length,
      movedLeakedToOtherBoard: here.tasks.some((t) => t.id === movedId),
      hereIds: here.tasks.map((t) => t.id),
    };
  })()`);  check(
    "UNI-57 undo after navigating away restores the original task without polluting the other board",
    typeof moveNavigate === "object" && undoIsolation.movedStatus === "todo" && undoIsolation.undoActivity === 1 && undoIsolation.movedLeakedToOtherBoard === false,
    JSON.stringify({ moveNavigate, ...undoIsolation }),
  );
  await session.shot("batch-undo-other-project.png");

  // ═══ UNI-57 rework: card context menu clamps to the viewport + Esc closes ═
  const clamp = await session.evaluate(`(async () => {
    const card = document.querySelector('.lane[data-lane="todo"] .card');
    if (!card) return null;
    const box = card.getBoundingClientRect();
    // Right-click near the very bottom-right corner of the viewport.
    const x = window.innerWidth - 12;
    const y = window.innerHeight - 12;
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 350));
    const menu = document.querySelector('.card-menu');
    if (!menu) return { menu: false };
    const rect = menu.getBoundingClientRect();
    const inViewport = rect.right <= window.innerWidth && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.top >= 0;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return { menu: true, rect: { right: Math.round(rect.right), bottom: Math.round(rect.bottom), innerWidth, innerHeight }, inViewport, closedByEsc: !document.querySelector('.card-menu') };
  })()`);
  check("UNI-57 card context menu clamps to the viewport near the lower-right corner", clamp?.menu && clamp.inViewport, JSON.stringify(clamp));
  check("UNI-57 card context menu closes on Escape", clamp?.closedByEsc === true, JSON.stringify(clamp?.closedByEsc));
  await session.shot("batch-context-clamped.png");

  // ═══ UNI-61 rework: whitespace drafts + changed lane count as dirty ══════
  const dirtyChecks = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await tick(400);
    (${type.toString()})('.dialog-title-input', ' ');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(250);
    const whitespaceDirty = !!document.querySelector('.discard-strip');
    [...document.querySelectorAll('.discard-strip .btn')].find((b) => /Discard/.test(b.textContent))?.click();
    await tick(250);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await tick(400);
    document.querySelector('.dialog [aria-label="Status"]').click();
    await tick(250);
    [...document.querySelectorAll('.popover [role=option]')].find((n) => n.textContent.includes('Todo')).click();
    await tick(250);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(250);
    const laneChangeDirty = !!document.querySelector('.discard-strip');
    [...document.querySelectorAll('.discard-strip .btn')].find((b) => /Discard/.test(b.textContent))?.click();
    await tick(250);
    return { whitespaceDirty, laneChangeDirty };
  })()`);
  check("UNI-61 whitespace-only drafts are protected", dirtyChecks?.whitespaceDirty === true, JSON.stringify(dirtyChecks));
  check("UNI-61 changing the lane is a draft", dirtyChecks?.laneChangeDirty === true, JSON.stringify(dirtyChecks));

  // ═══ UNI-51 rework: ring animates the angle, never a transform ═════════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(800);
  const ringRework = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const tile = document.querySelector('.running-tile.is-running');
    if (!tile) return { tile: false };
    const before = getComputedStyle(tile, '::before');
    const t0 = before.transform;
    const angle0 = before.getPropertyValue('--ring-angle');
    const tileBox0 = tile.getBoundingClientRect();
    const avatar0 = tile.querySelector('.project-tile').getBoundingClientRect();
    await tick(600);
    const after = getComputedStyle(tile, '::before');
    const angle1 = after.getPropertyValue('--ring-angle');
    const tileBox1 = tile.getBoundingClientRect();
    const avatar1 = tile.querySelector('.project-tile').getBoundingClientRect();
    return {
      tile: true,
      transform: t0,
      transformAfter: after.transform,
      angle0, angle1,
      angleAnimates: angle0 !== angle1,
      squareAndStable: Math.abs(tileBox0.width - tileBox0.height) < 0.5 &&
        Math.abs(tileBox0.width - tileBox1.width) < 0.5 &&
        Math.abs(tileBox0.top - tileBox1.top) < 0.5 &&
        Math.abs(tileBox0.left - tileBox1.left) < 0.5,
      avatarStable: Math.abs(avatar0.width - avatar1.width) < 0.5 && Math.abs(avatar0.left - avatar1.left) < 0.5 && Math.abs(avatar0.top - avatar1.top) < 0.5,
      radius: after.borderRadius,
    };
  })()`);
  check("UNI-51 ring ::before never transforms", ringRework.transform === "none" && ringRework.transformAfter === "none", JSON.stringify(ringRework));
  check("UNI-51 ring animates the custom --ring-angle property", ringRework.angleAnimates, `${ringRework.angle0} → ${ringRework.angle1}`);
  check("UNI-51 ring keeps avatar and outline fixed while rotating the gradient", ringRework.squareAndStable && ringRework.avatarStable, JSON.stringify(ringRework));
  check("UNI-51 ring keeps its rounded fixed shape", /2?[2-9]%|\d+px/.test(ringRework.radius ?? ""), ringRework.radius);
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const ringReduced = await session.evaluate(`(() => {
    const before = getComputedStyle(document.querySelector('.running-tile.is-running'), '::before');
    return { animation: before.animationName, color: before.backgroundColor, image: before.backgroundImage };
  })()`);
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });
  check("UNI-51 reduced motion falls back to a static ring", ringReduced.animation === "none" && ringReduced.image === "none" && /(oklch|rgb)/.test(ringReduced.color), JSON.stringify(ringReduced));
  await session.shot("batch-ring-angle.png");

  // ═══ UNI-51 rework: dashboard nav gap + archived header typography ══════
  // Re-archive the fixture's Old Project so the sidebar section renders.
  await session.evaluate(`(async () => {
    const projects = await fetch('/api/projects').then((r) => r.json());
    const old = projects.find((p) => p.name === 'Old Project');
    if (old && !old.archived) await fetch('/api/projects/' + old.slug, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
  })()`);
  await session.evaluate(`location.reload()`);
  await sleep(1800);
  const headerMatch = await session.evaluate(`(() => {
    const projects = document.querySelector('.sidebar .sb-section');
    const archived = document.querySelector('.sb-archived > .sb-section');
    const a = getComputedStyle(projects);
    const b = getComputedStyle(archived);
    return {
      gap: getComputedStyle(document.querySelector('.nav-item.dashboard-nav')).marginBottom,
      fontSize: [a.fontSize, b.fontSize],
      fontWeight: [a.fontWeight, b.fontWeight],
      color: [a.color, b.color],
      padding: [a.padding, b.padding],
      height: [a.height, b.height],
      countInHeader: !!archived.querySelector('.count'),
      defaultCollapsed: document.querySelector('.sb-archived .nav-row.archived') === null,
    };
  })()`);
  check("UNI-51 Dashboard nav has a clear ~10px margin below", Math.abs(parseFloat(headerMatch.gap) - 10) < 0.6, headerMatch.gap);
  check(
    "UNI-51 Archived header matches the Projects section typography/color/padding",
    headerMatch.fontSize[0] === headerMatch.fontSize[1] && headerMatch.fontWeight[0] === headerMatch.fontWeight[1] &&
      headerMatch.color[0] === headerMatch.color[1] && headerMatch.padding[0] === headerMatch.padding[1] && headerMatch.height[0] === headerMatch.height[1],
    JSON.stringify(headerMatch),
  );
  check("UNI-51 Archived header count sits in the header, section default collapsed", headerMatch.countInHeader && headerMatch.defaultCollapsed, JSON.stringify(headerMatch));

  // ═══ UNI-60 rework: the label rail uses the shared picker ═══════════════
  await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('.sidebar .nav-row')].find((r) => r.textContent.includes('Batch Project'));
    row?.querySelector('.nav-item').click();
  })()`);
  await sleep(900);
  const labelRail = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'labeled task');
    if (!card) return 'no card';
    card.click();
    await tick(700);
    const trigger = document.querySelector('.panel [aria-label="Edit labels"]');
    if (!trigger) return { rail: 'no trigger', freeTextInput: !!document.querySelector('.panel .label-input') };
    trigger.click();
    await tick(300);
    return {
      rail: 'ok',
      options: [...document.querySelectorAll('.label-picker [role=menuitemcheckbox]')].map((n) => ({ label: n.querySelector('.menu-label').textContent.trim(), checked: n.classList.contains('checked') })),
      freeTextInput: !!document.querySelector('.panel .label-input'),
    };
  })()`);
  check(
    "UNI-60 label rail opens the shared picker with existing labels checked",
    labelRail.rail === "ok" && labelRail.options.some((o) => o.label === "web" && o.checked) && labelRail.options.some((o) => o.label === "ui" && o.checked) && !labelRail.freeTextInput,
    JSON.stringify(labelRail),
  );
  const labelPersist = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const taskId = ${JSON.stringify("PENDING")};
    // deselect web, create rail-new
    [...document.querySelectorAll('.label-picker [role=menuitemcheckbox]')].find((n) => n.querySelector('.menu-label').textContent.trim() === 'web').click();
    await tick(900);
    const input = document.querySelector('.label-picker input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus(); set.call(input, 'rail-new'); input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(200);
    [...document.querySelectorAll('.label-picker .menu-item')].find((n) => /Create/.test(n.textContent)).click();
    await tick(900);
    return taskId;
  })()`.replace(JSON.stringify("PENDING"), JSON.stringify((await session.evaluate(`fetch('/api/projects/${slug}/tasks').then((r) => r.json()).then((d) => d.tasks.find((t) => t.title === 'labeled task').id)`)))));
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  const labelsAfter = await session.evaluate(`fetch('/api/projects/${slug}/tasks').then((r) => r.json()).then((d) => {
    const t = d.tasks.find((t) => t.title === 'labeled task');
    return { labels: t.labels, chipRightOfId: (() => { const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'labeled task'); const id = card.querySelector('.card-id'); return id.nextElementSibling?.classList.contains('tag') && [...card.querySelectorAll('.card-top .tag.label')].some((c) => c.textContent.trim() === 'rail-new'); })() };
  })`);
  check(
    "UNI-60 rail picker deselect/create persists immediately and updates the card chips",
    JSON.stringify(labelsAfter.labels) === JSON.stringify(["ui", "rail-new"]) && labelsAfter.chipRightOfId,
    JSON.stringify(labelsAfter),
  );
  await session.shot("batch-label-rail.png");

  // ═══ UNI-60 rework 2: rapid multiselect cannot overwrite a pending save ══
  const rapidIds = await session.evaluate(`fetch('/api/projects/${slug}/tasks').then((r) => r.json()).then((d) => d.tasks.find((t) => t.title === 'labeled task').id)`);
  await session.evaluate(`fetch('/api/tasks/${slug}/${rapidIds}/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels: ['seed-a', 'seed-b'] }) })`);
  // Keep both seed labels board-wide even when the target deselects one —
  // allLabels() drives the picker options and would otherwise drop the row.
  await session.evaluate(`fetch('/api/projects/${slug}/tasks').then((r) => r.json()).then(async (d) => {
    const neighbor = d.tasks.find((t) => t.title.startsWith('quoted "title"'));
    await fetch('/api/tasks/${slug}/' + neighbor.id + '/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels: ['seed-a', 'seed-b'] }) });
  })`);
  // The fixture daemon has no watcher: raw API writes need an explicit reload.
  await session.evaluate(`location.reload()`);
  await sleep(1800);
  const rapid = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'labeled task');
    card.click();
    await tick(700);
    document.querySelector('.panel [aria-label="Edit labels"]').click();
    await tick(300);
    const item = (label) => [...document.querySelectorAll('.label-picker [role=menuitemcheckbox]')].find((n) => n.querySelector('.menu-label').textContent.trim() === label);
    // First action: deselect seed-b (save in flight).
    const it = item('seed-b');
    if (!it) return { fail: 'item missing', items: [...document.querySelectorAll('.label-picker .menu-label')].map((n) => n.textContent.trim()), chips: [...document.querySelectorAll('.panel .tag.label')].map((n) => n.textContent.trim()), picker: !!document.querySelector('.label-picker') };
    it.click();
    const disabledWhilePending = !item('seed-b').disabled ? 'menu-not-disabled' : 'menu-disabled';
    // Second action in the same instant — must be a no-op while pending.
    item('seed-a').click();
    const settled = async (label) => { for (let i = 0; i < 20; i += 1) { const el = item(label); if (!el || !el.disabled) return el; await tick(300); } return item(label); };
    await settled('seed-a');
    const afterSettle = await fetch('/api/tasks/${slug}/${rapidIds}').then((r) => r.json()).then((d) => d.labels);
    const reEnabled = (() => { const el = item('seed-a'); return !!el && !el.disabled; })();
    // Next selection after settle persists.
    item('seed-b').click();
    await settled('seed-b');
    await tick(600);
    const finalLabels = await fetch('/api/tasks/${slug}/${rapidIds}').then((r) => r.json()).then((d) => d.labels);
    // Chip remove buttons also disable while pending.
    const chip = document.querySelector('.panel .tag.label.removable button');
    chip.click();
    const chipDisabledWhilePending = chip.disabled;
    for (let i = 0; i < 20; i += 1) { if (!chip.disabled) break; await tick(300); }
    const afterChipRemove = await fetch('/api/tasks/${slug}/${rapidIds}').then((r) => r.json()).then((d) => d.labels);
    return { disabledWhilePending, afterSettle, reEnabled, finalLabels, chipDisabledWhilePending, afterChipRemove };
  })()`);
  check(
    "UNI-60 rapid second selection while pending is blocked and cannot overwrite the first save",
    rapid.disabledWhilePending === "menu-disabled" && JSON.stringify(rapid.afterSettle) === JSON.stringify(["seed-a"]),
    JSON.stringify(rapid),
  );
  check("UNI-60 picker re-enables after settle and the next selection persists", rapid.reEnabled && JSON.stringify(rapid.finalLabels) === JSON.stringify(["seed-a", "seed-b"]), JSON.stringify(rapid));
  check("UNI-60 chip remove button disables while pending and removes after", rapid.chipDisabledWhilePending === true && JSON.stringify(rapid.afterChipRemove) === JSON.stringify(["seed-b"]), JSON.stringify(rapid));
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);

  // ═══ UNI-67: Dashboard command center ════════════════════════════════
  // Seed: an aged in_review (backdated activity in the fixture file), a fresh
  // in_review, and a done cycle — through the same CLI path agents use.
  const kbSeed = (call) => JSON.parse(execFileSync(binary, [...call, "--json"], { env, cwd: workspace, encoding: "utf-8" }));
  const oldId = kbSeed(["add", "dash old review", "--status", "todo"]).id;
  kbSeed(["start", oldId, "--actor", "agent", "--session", "batch", "--pid", String(process.pid)]);
  kbSeed(["finish", oldId, "--comment", "old finish summary\n\nmore detail ![img](att:x)", "--actor", "agent", "--session", "batch"]);
  {
    // Backdate the finish entry so waitingSince sorts it first.
    const file = join(home, "projects", slug, "tasks", `${oldId}.md`);
    let text = readFileSync(file, "utf-8");
    text = text.replaceAll("- 2026-", "- 2025-").replace("(∂)", "");
    const stamp = new Date(Date.now() - 3 * 24 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
    text = text.replace(/^- 20\d\d-\d\d-\d\dT[^ ]+ \[agent:batch\] finished: (.*)$/m, `- ${stamp} [agent:batch] finished: $1`);
    text = text.replace(/^updated: .*/m, `updated: ${stamp}`);
    writeFileSync(file, text);
  }
  const freshId = kbSeed(["add", "dash fresh review", "--status", "todo"]).id;
  kbSeed(["start", freshId, "--actor", "agent", "--session", "batch", "--pid", String(process.pid)]);
  kbSeed(["finish", freshId, "--comment", "fresh finish summary", "--actor", "agent", "--session", "batch"]);
  for (const [title, priority] of [["dash urgent", "urgent"], ["dash high", "high"], ["dash low", "low"]]) {
    kbSeed(["add", title, "--status", "todo", "--priority", priority]);
  }
  // A blocked task with a long agent question (excerpt second line).
  const longBlocked = kbSeed(["add", "dash blocked long", "--status", "todo"]).id;
  kbSeed(["start", longBlocked, "--actor", "agent", "--session", "batch", "--pid", String(process.pid)]);
  kbSeed(["move", longBlocked, "blocked", "--comment", "the retry fixture keeps flaking on CI — could you pin the browser version and share the full log tail so I can tell whether it is the fixture or my selector strategy", "--actor", "agent", "--session", "batch"]);
  // Two more active projects with a few tasks each.
  for (const name of ["Aurora Labs", "Nebula Ops"]) {
    const root = mkdtempSync(join(tmpdir(), `kb-batch-${name.replace(/\s/g, "-")}-`));
    const proj = kbSeed(["project", "add", "--root", root, "--name", name]);
    execFileSync(binary, ["--project", proj.slug, "add", `${name} scaffold`, "--status", "todo", "--json"], { env, cwd: root, encoding: "utf-8" });
  }
  // Ten done events spread across 14 days (backdated in the fixture files).
  const doneOffsets = [0, 1, 2, 3, 5, 7, 9, 10, 12, 13];
  for (const offset of doneOffsets) {
    const id = kbSeed(["add", `dash done d${offset}`, "--status", "todo"]).id;
    kbSeed(["start", id, "--actor", "agent", "--session", "batch", "--pid", String(process.pid)]);
    kbSeed(["finish", id, "--comment", `done on offset ${offset}`, "--actor", "agent", "--session", "batch"]);
    kbSeed(["move", id, "done"]);
    const stamp = new Date(Date.now() - offset * 24 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
    const file = join(home, "projects", slug, "tasks", `${id}.md`);
    const lines = readFileSync(file, "utf-8").split("\n").map((line) => {
      if (line.startsWith("- ")) return `- ${stamp} ${line.replace(/^- \S+ /, "")}`;
      if (line.startsWith("updated: ")) return `updated: ${stamp}`;
      return line;
    });
    writeFileSync(file, lines.join("\n"));
  }
  // A second running agent with a dead pid → staleness "stale". Started
  // LAST: any later `start` run would reap this dead-pid claim.
  const doneCycle = kbSeed(["add", "dash done cycle", "--status", "todo"]).id;
  kbSeed(["start", doneCycle, "--actor", "agent", "--session", "batch", "--pid", String(process.pid)]);
  kbSeed(["finish", doneCycle, "--comment", "cycle summary", "--actor", "agent", "--session", "batch"]);
  kbSeed(["move", doneCycle, "done"]);
  {
    const staleId = kbSeed(["add", "stale agent work", "--status", "todo"]).id;
    kbSeed(["start", staleId, "--actor", "agent", "--session", "batch-run", "--pid", "4194303"]);
  }
  await session.evaluate(`location.reload()`);
  await sleep(1500);

  // ── navigate to the Dashboard ──
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(900);
  const sections = await session.evaluate(`(() => ({
    greeting: document.querySelector('.dash-head h1')?.textContent ?? '',
    summary: document.querySelector('.dash-summary')?.textContent.trim() ?? '',
    inboxRows: document.querySelectorAll('.dash-row').length,
    agents: document.querySelectorAll('.dash-agent').length,
    upNext: document.querySelectorAll('.dash-next-row').length,
    bars: document.querySelectorAll('.dash-bar').length,
    tiles: document.querySelectorAll('.dash-tile').length,
    activityRows: document.querySelectorAll('.dash-activity-row').length,
    projectCards: document.querySelectorAll('.project-card').length,
    noGradient: !document.querySelector('.dash-aurora') && getComputedStyle(document.querySelector('.dash-head')).backgroundImage === 'none' && getComputedStyle(document.querySelector('.dash-head'), '::after').content === 'none',
  }))()`);
  check("UNI-67 dashboard renders all sections", sections.greeting.startsWith("Good ") && sections.inboxRows >= 3 && sections.agents >= 2 && sections.upNext >= 3 && sections.bars === 14 && sections.tiles === 4 && sections.activityRows >= 1 && sections.projectCards >= 3 && sections.noGradient, JSON.stringify(sections));
  const dashScroll = await session.evaluate(`(async () => {
    const el = document.querySelector('.dashboard');
    const overflowing = el.scrollHeight > el.clientHeight + 10;
    el.scrollTop = 400;
    await new Promise((r) => setTimeout(r, 100));
    const moved = el.scrollTop > 0;
    el.scrollTop = 0;
    return { overflowing, moved, overflowY: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight };
  })()`);
  check("UNI-67 dashboard scrolls when content overflows", dashScroll.overflowing && dashScroll.moved, JSON.stringify(dashScroll));
  await session.shot("dashboard-dark-wide.png");

  // Inbox rows: entrance plays once per row; everything sits at opacity 1.
  await sleep(1100);
  const opacityCheck = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const allOne = () => [...document.querySelectorAll('.dash-row')].every((r) => getComputedStyle(r).opacity === '1');
    const first = allOne();
    await tick(650);
    const afterSettle = allOne();
    window.__kbDashReload?.();
    await tick(1200);
    const afterRefetch = allOne();
    return { first, afterSettle, afterRefetch };
  })()`);
  check("UNI-67 inbox rows rest at opacity 1 across refetch and tick", opacityCheck.first && opacityCheck.afterSettle && opacityCheck.afterRefetch, JSON.stringify(opacityCheck));

  // KPI tiles match the API; count-up has settled.
  await sleep(1100);
  const kpis = await session.evaluate(`(async () => {
    const dash = await fetch('/api/dashboard').then((r) => r.json());
    const run = await fetch('/api/running').then((r) => r.json());
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    const values = [...document.querySelectorAll('.dash-kpi-value')].map((n) => Number(n.textContent.replace(/[^0-9]/g, '')));
    const date = document.querySelector('.dash-date')?.textContent ?? '';
    const live = !!document.querySelector('.dash-live');
    return {
      values,
      expected: [dash.inbox.length, run.running.length, dash.readyTotal, dash.doneAt.filter((v) => Date.parse(v) >= weekAgo).length],
      readyTotalVsCap: dash.readyTotal >= dash.upNext.length,
      date, live,
    };
  })()`);
  check("UNI-67 KPI tiles match the API (inbox/agents/readyTotal/done7d)", JSON.stringify(kpis.values) === JSON.stringify(kpis.expected) && kpis.readyTotalVsCap && kpis.date.length > 3 && kpis.live, JSON.stringify(kpis));
  // KPI clicks scroll/focus.
  const kpiClick = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    [...document.querySelectorAll('.dash-kpi')][0].click();
    await tick(700);
    const inboxFocused = !!document.querySelector('.dash-row.focused');
    const inboxVisible = (() => { const b = document.querySelector('.dash-inbox')?.getBoundingClientRect(); return b && b.top >= -2 && b.top < window.innerHeight; })();
    [...document.querySelectorAll('.dash-kpi')][1].click();
    await tick(700);
    const agentsVisible = (() => { const b = document.querySelector('.dash-agents')?.getBoundingClientRect(); return b && b.top >= -2 && b.top < window.innerHeight; })();
    return { inboxFocused, inboxVisible, agentsVisible };
  })()`);
  check("UNI-67 KPI clicks scroll to and focus their panel", kpiClick.inboxFocused && kpiClick.inboxVisible && kpiClick.agentsVisible, JSON.stringify(kpiClick));

  // Inbox: oldest first + amber chip; blocked excerpt present.
  const inboxOrder = await session.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.dash-row')];
    const info = rows.map((row) => ({
      id: row.querySelector('.mono')?.textContent,
      title: row.querySelector('.dash-row-title')?.textContent ?? '',
      amber: !!row.querySelector('.dash-age.amber'),
      excerpt: row.querySelector('.dash-row-excerpt')?.textContent ?? '',
    }));
    return { order: info.map((i) => i.id), amberFirst: info[0]?.amber, blockedExcerpt: info.find((i) => i.title === 'blocked close')?.excerpt };
  })()`);
  check("UNI-67 inbox oldest-first with amber age chip", inboxOrder.order[0] === oldId && inboxOrder.amberFirst, JSON.stringify(inboxOrder));
  check("UNI-67 blocked row shows the blocking question as excerpt", /need input/.test(inboxOrder.blockedExcerpt ?? ""), inboxOrder.blockedExcerpt);

  // Approve through the shared path: undo toast appears, undo restores.
  const approve = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.dash-row');
    if (!row) return { fail: 'no rows' };
    globalThis.__batchApproveId = row.dataset.inboxIndex !== undefined ? row.querySelector('.mono')?.textContent : null;
    row.querySelector('[aria-label^="Approve"]').click();
    for (let i = 0; i < 12; i += 1) { await tick(300); if ([...document.querySelectorAll('.toast')].some((n) => /Undo/.test(n.textContent))) break; }
    const toastWithUndo = [...document.querySelectorAll('.toast')].some((n) => /Undo/.test(n.textContent));
    const approveId = globalThis.__batchApproveId;
    const doneStatus = await fetch('/api/tasks/${slug}/' + approveId).then((r) => r.json()).then((d) => d.status);
    [...document.querySelectorAll('.toast .btn')].find((b) => b.textContent.trim() === 'Undo').click();
    await tick(1200);
    const restored = await fetch('/api/tasks/${slug}/' + approveId).then((r) => r.json()).then((d) => d.status);
    return { approveId, toastWithUndo, doneStatus, restored };
  })()`);  check("UNI-67 Approve moves to done via the shared path with undo", approve.toastWithUndo && approve.doneStatus === "done" && approve.restored === "in_review", JSON.stringify(approve));

  const doneBefore = await session.evaluate(`fetch('/api/dashboard').then((r) => r.json()).then((d) => d.doneAt.length)`);
  check("UNI-67 undone Approve does not count in doneAt", doneBefore === 11, String(doneBefore));

  // Rework opens the comment-required dialog (same CommentDialog path).
  const rework = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('.dash-row');
    if (!row) return { fail: 'no rows' };
    const reworkId = row.querySelector('.mono')?.textContent;
    const send = row.querySelector('button[aria-label^="Send"]');
    if (!send) return { fail: 'no send button', html: row.outerHTML.slice(0, 240) };
    send.click();
    await tick(600);
    const dialog = document.querySelector('.dialog.modal');
    const primary = [...(dialog?.querySelectorAll('.btn.primary') ?? [])][0];
    const disabledEmpty = primary ? primary.disabled : null;
    const area = dialog?.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    area.focus(); set.call(area, 'tighten the flow'); area.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(200);
    const enabledAfter = !primary.disabled;
    primary.click();
    await tick(1500);
    const response = await fetch('/api/tasks/${slug}/' + reworkId);
    const status = response.ok ? await response.json().then((d) => d.status) : 'http ' + response.status;
    return { reworkId, dialogOpen: !!dialog, disabledEmpty, enabledAfter, status };
  })()`);  // Row click navigates to the task in its project.
  await session.evaluate(`window.__kbDashReload?.()`);
  await sleep(900);
  const rowNav = await session.evaluate(`(async () => {
    const row = [...document.querySelectorAll('.dash-row')].find((r) => r.textContent.includes('blocked close'));
    row.click();
    await new Promise((r) => setTimeout(r, 1400));
    return { project: new URLSearchParams(location.search).get('project'), panel: document.querySelector('.panel .crumb-pill')?.textContent.trim() ?? null };
  })()`);
  check("UNI-67 inbox row click opens the task in its project", rowNav.project === slug && rowNav.panel === seeded["blocked close"], JSON.stringify(rowNav));
  await session.evaluate(`document.querySelector('[aria-label="Close details"]')?.click()`);
  await sleep(300);
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(800);

  // Up next: priority order (urgent, high, low, then the rest).
  const upNextOrder = await session.evaluate(`[...document.querySelectorAll('.dash-next-row .dash-next-title')].map((n) => n.textContent.trim()).slice(0, 3).join('|')`);
  check("UNI-67 up-next orders by priority", upNextOrder === "dash urgent|dash high|dash low", upNextOrder);

  // Throughput: today's bar count equals the dashboard's doneAt events.
  const throughput = await session.evaluate(`(async () => {
    const dash = await fetch('/api/dashboard').then((r) => r.json());
    const bars = [...document.querySelectorAll('.dash-bar')];
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    return {
      bars: bars.length,
      filled: bars.filter((b) => b.classList.contains('filled')).length,
      sum: bars.reduce((sum, b) => sum + Number(b.title.split("·")[1]?.trim().split(" ")[0] ?? 0), 0),
      doneAt: dash.doneAt.length,
      done7dUi: Number(document.querySelectorAll('.dash-kpi-value')[3]?.textContent.replace(/[^0-9]/g, '') ?? -1),
      done7dApi: dash.doneAt.filter((v) => Date.parse(v) >= weekAgo).length,
      distinctDays: new Set(dash.doneAt.map((v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d.getTime(); })).size,
      todayClass: bars.at(-1)?.classList.contains('today'),
      heights: bars.map((b) => b.getBoundingClientRect().height),
    };
  })()`);
  check(
    "UNI-67 throughput bars: 14 bars, filled == distinct days, sum == doneAt, Done7d == API",
    throughput.bars === 14 && throughput.filled === throughput.distinctDays && throughput.sum === throughput.doneAt && throughput.done7dUi === throughput.done7dApi && throughput.done7dUi >= 1 && throughput.todayClass && Math.max(...throughput.heights) > 8,
    JSON.stringify(throughput),
  );
  const medianTile = await session.evaluate(`fetch('/api/dashboard').then((r) => r.json()).then((d) => ({
    waits: d.reviewWaits.length,
    text: [...document.querySelectorAll('.dash-tile')].find((t) => /review/.test(t.textContent))?.querySelector('b')?.textContent.trim() ?? null,
  }))`);
  check(
    "UNI-67 median review wait is a formatted duration",
    medianTile.waits === 0 ? medianTile.text === "—" : /^\d+[smhd]/.test(medianTile.text ?? "") && !/^\d+$/.test(medianTile.text ?? ""),
    JSON.stringify(medianTile),
  );

  // Sort control persists.
  await session.evaluate(`[...document.querySelectorAll('.dash-chip')].find((b) => b.textContent.trim() === 'Name').click()`);
  await sleep(200);
  const sortStored = await session.evaluate(`localStorage.getItem('kb.dashboard.sort')`);
  await session.evaluate(`location.reload()`);
  await sleep(1800);
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(800);
  const sortAfterReload = await session.evaluate(`[...document.querySelectorAll('.dash-chip')].find((b) => b.textContent.trim() === 'Name')?.classList.contains('on')`);
  check("UNI-67 project sort persists across reload", sortStored === "name" && sortAfterReload === true, `${sortStored}/${sortAfterReload}`);
  await session.evaluate(`[...document.querySelectorAll('.dash-chip')].find((b) => b.textContent.trim() === 'Needs attention')?.click()`);
  await sleep(200);

  // Live refresh after an API write (explicit reload hook — NO_WATCH fixture).
  const readyBefore = await session.evaluate(`fetch('/api/dashboard').then((r) => r.json()).then((d) => d.readyTotal)`);
  await session.evaluate(post(`/api/tasks/${slug}/create`, { title: "dash live probe", status: "todo" }));
  await session.evaluate(`window.__kbDashReload?.()`);
  await sleep(900);
  const readyAfter = await session.evaluate(`fetch('/api/dashboard').then((r) => r.json()).then((d) => d.readyTotal)`);
  check("UNI-67 dashboard refreshes after an API write", readyAfter === readyBefore + 1, `${readyBefore} → ${readyAfter}`);

  // j/k focus + Enter opens.
  await session.evaluate(`document.activeElement?.blur()`);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))`);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))`);
  await sleep(150);
  const jkFocused = await session.evaluate(`[...document.querySelectorAll('.dash-row')].findIndex((r) => r.classList.contains('focused'))`);
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(1200);
  const opened = await session.evaluate(`!!document.querySelector('.panel')`);
  check("UNI-67 j/k focus the inbox and Enter opens the task", jkFocused === 1 && opened, `focus=${jkFocused} opened=${opened}`);
  await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(900);

  // Reduced motion: bars stop.
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const dashReduced = await session.evaluate(`(() => ({
    animations: document.querySelector('.dashboard')?.getAnimations().length ?? -1,
    bar: getComputedStyle(document.querySelector('.dash-bar')).animationName,
  }))()`);
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });
  check("UNI-67 reduced motion leaves zero running animations on the dashboard", dashReduced.animations === 0 && dashReduced.bar === "none", JSON.stringify(dashReduced));

  // Narrow viewport (≤900px single column): section order + screenshots.
  await session.send("Emulation.setDeviceMetricsOverride", { width: 880, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const narrowOrder = await session.evaluate(`(() => {
    const tops = [
      ['.dash-inbox', 'inbox'], ['.dash-agents', 'agents'], ['.dash-next', 'upnext'],
      ['.sec-projects', 'projects'], ['.dash-throughput', 'throughput'], ['.dash-activity', 'activity'],
    ].map(([selector, name]) => ({ name, top: document.querySelector(selector)?.getBoundingClientRect().top ?? 1e9 }));
    tops.sort((a, b) => a.top - b.top);
    return tops.map((entry) => entry.name).join(',');
  })()`);
  check("UNI-67 narrow order inbox→agents→upnext→projects→throughput→activity", narrowOrder === "inbox,agents,upnext,projects,throughput,activity", narrowOrder);
  const setTheme = (name) => `(() => { document.documentElement.dataset.theme = ${'${name}'}; localStorage.setItem('kanboard.theme', ${'${name}'}); })()`;
  // Theme-verified screenshots: the computed body background must match the name.
  const themeProbe = async (name) => {
    await session.evaluate(`document.documentElement.dataset.theme = '${name}'; localStorage.setItem('kanboard.theme', '${name}');`);
    await sleep(350);
    const bg = await session.evaluate(`getComputedStyle(document.body).backgroundColor`);
    const lightness = Number(bg.match(/oklch\(([\d.]+)/)?.[1] ?? (/rgb/.test(bg) ? (bg.match(/\d+/g) ?? [255,255,255]).reduce((a, b) => a + Number(b), 0) / 3 / 255 : -1));
    return { name, bg, dark: lightness >= 0 && lightness < 0.5, light: lightness >= 0.5 };
  };
  let probe = await themeProbe("dark");
  check("UNI-67 dark theme really dark before the dark screenshot", probe.dark, JSON.stringify(probe));
  await session.shot("dashboard-dark-narrow.png");
  probe = await themeProbe("light");
  check("UNI-67 light theme really light before the light screenshot", probe.light, JSON.stringify(probe));
  await session.shot("dashboard-light-narrow.png");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  probe = await themeProbe("light");
  check("UNI-67 light wide stays light", probe.light, JSON.stringify(probe));
  await session.shot("dashboard-light-wide.png");
  probe = await themeProbe("dark");
  await session.shot("dashboard-dark-wide.png");
  await session.shot("dashboard-dark-full.png", true);
  // back to the board for the remaining checks
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Board'))?.click()`);
  await sleep(600);



  // ═══ UNI-67 final: step-trail chronological order + rail clearance ═════
  await session.evaluate(`window.__kbDashReload?.()`);
  await sleep(1000);
  const trailRow = await session.evaluate(`(async () => {
    const dash = await fetch('/api/dashboard').then((r) => r.json());
    const cycle = dash.activity.find((a) => a.title === 'dash done cycle');
    if (!cycle) return { fail: 'no cycle activity' };
    [...document.querySelectorAll('.dash-activity .btn')].find((b) => /Show more/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 250));
    const row = [...document.querySelectorAll('.dash-activity-row')].find((n) => n.textContent.includes('dash done cycle'));
    if (!row) return { fail: 'no row' };
    const steps = [...row.querySelectorAll('.dash-step')].map((n) => n.textContent.trim());
    const rowBox = row.getBoundingClientRect();
    const avatar = row.querySelector('.avatar')?.getBoundingClientRect();
    // The dot is the row's ::before at left -28px (7px wide).
    const dotRight = rowBox.left - 28 + 7;
    return {
      cycleId: cycle.taskId,
      steps,
      chronological: JSON.stringify(steps) === JSON.stringify(['created', 'started', 'finished', 'done']),
      railClear: avatar ? dotRight <= avatar.left + 1 : null,
      dotRight, avatarLeft: avatar?.left,
    };
  })()`);
  check("UNI-67 step trail renders chronologically", trailRow.chronological === true && !trailRow.fail, JSON.stringify(trailRow));
  check("UNI-67 rail dot does not overlap the avatar", trailRow.railClear === true, JSON.stringify(trailRow));
  await session.shot("dashboard-dark-wide.png");


  // ═══ UNI-67 rework 2: grouped inbox, caps, persistence ═════════════════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(900);
  // Give Aurora Labs a blocked task (agent-blocked, as on a real board) so a
  // second project group exists; Batch Project's 3d-old review stays oldest.
  {
    const auroraSlug = await session.evaluate(`fetch('/api/projects').then((r) => r.json()).then((ps) => ps.find((p) => p.name === 'Aurora Labs').slug)`);
    const id = kbSeed(["add", "aurora blocked item", "--status", "todo", "--project", auroraSlug]).id;
    kbSeed(["start", id, "--actor", "agent", "--session", "batch", "--pid", String(process.pid), "--project", auroraSlug]);
    kbSeed(["move", id, "blocked", "--comment", "waiting on credentials", "--actor", "agent", "--session", "batch", "--project", auroraSlug]);
    await session.evaluate(`window.__kbDashReload?.()`);
  }
  await sleep(1200);
  await session.evaluate(`localStorage.removeItem('kb.dashboard.inbox'); window.__kbDashReload?.();`);
  await sleep(900);
  const grouping = await session.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('.dash-inbox-group')].map((group) => ({
      name: group.querySelector('.dash-group-name')?.textContent.trim() ?? null,
      rows: group.querySelectorAll('.dash-row').length,
      more: group.querySelector('.dash-more')?.textContent.trim() ?? null,
      collapsed: group.querySelector('.dash-group-head')?.getAttribute('aria-expanded') === 'false',
    }));
    return {
      groups,
      rows: document.querySelectorAll('.dash-row').length,
      footer: document.querySelector('.dash-show-all')?.textContent.trim() ?? null,
      debug: { dashboards: document.querySelectorAll('.dashboard').length, groupsRaw: document.querySelectorAll('.dash-inbox-group').length, projectNames: await fetch('/api/projects').then((r) => r.json()).then((ps) => ps.map((p) => p.name + ':' + (p.archived ? 'A' : '-'))) },
    };
  })()`);
  check(
    "UNI-67 inbox groups by project, oldest-wait first, 3-row default with +N and global cap",
    grouping.groups.length >= 2 &&
      grouping.groups[0].name === "Batch Project" &&
      grouping.groups[0].rows === 3 &&
      grouping.groups[0].more !== null &&
      grouping.rows <= 10 &&
      /^Show \d+ more$/.test(grouping.footer ?? ""),
    JSON.stringify(grouping),
  );
  await session.shot("dashboard-grouped.png");

  // The footer counts only cap-hidden rows (sum of the per-group +N).
  const footerCount = await session.evaluate(`(() => ({
    footer: document.querySelector('.dash-show-all')?.textContent.trim() ?? null,
    plus: [...document.querySelectorAll('.dash-more')].reduce((sum, n) => sum + Number((n.textContent.match(/\\+(\\d+)/) ?? [0, 0])[1]), 0),
  }))()`);
  check("UNI-67 'Show N more' counts only cap-hidden rows", footerCount.footer === "Show " + footerCount.plus + " more", JSON.stringify(footerCount));

  // Per-group +N expands that group.
  const expanded = await session.evaluate(`(async () => {
    document.querySelector('.dash-more').click();
    await new Promise((r) => setTimeout(r, 400));
    const group = document.querySelector('.dash-inbox-group');
    return {
      rows: group.querySelectorAll('.dash-row').length,
      moreGone: ![...group.querySelectorAll('.dash-more')].some((n) => /^\\+\\d+ more/.test(n.textContent.trim())),
    };
  })()`);
  check("UNI-67 per-group +N expands beyond the 3-row default", expanded.rows > 3 && expanded.moreGone, JSON.stringify(expanded));

  // Collapse + persistence survive a reload.
  await session.evaluate(`(() => {
    const group = [...document.querySelectorAll('.dash-inbox-group')].find((n) => n.textContent.includes('Batch Project'));
    group.querySelector('.dash-group-head').click();
  })()`);
  await sleep(400);
  const collapsedState = await session.evaluate(`(() => ({
    stored: localStorage.getItem('kb.dashboard.inbox'),
    collapsedRows: document.querySelectorAll('.dash-inbox-group')[0].querySelectorAll('.dash-row').length,
  }))()`);
  await session.evaluate(`location.reload()`);
  await sleep(1800);
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(900);
  const afterReload = await session.evaluate(`(() => {
    const group = document.querySelector('.dash-inbox-group');
    if (!group) return { stored: localStorage.getItem('kb.dashboard.inbox'), stillCollapsed: false, missing: true };
    return {
      stored: localStorage.getItem('kb.dashboard.inbox'),
      stillCollapsed: group.querySelector('.dash-group-head')?.getAttribute('aria-expanded') === 'false' && group.querySelectorAll('.dash-row').length === 0,
    };
  })()`);
  check(
    "UNI-67 inbox collapse state persists across reload",
    /Batch Project/.test(collapsedState.stored ?? "") && collapsedState.collapsedRows === 0 && afterReload.stillCollapsed && /Batch Project/.test(afterReload.stored ?? ""),
    JSON.stringify({ collapsedState, afterReload }),
  );
  // Collapse all: no misleading footer; Expand all brings rows back.
  const collapseAll = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = () => document.querySelector('.dash-collapse-all');
    if (btn()?.textContent.trim() === 'Expand all') { btn().click(); await tick(300); }
    btn().click();
    await tick(300);
    const collapsed = {
      label: btn().textContent.trim(),
      rows: document.querySelectorAll('.dash-row').length,
      footer: document.querySelector('.dash-show-all')?.textContent.trim() ?? null,
      oldest: [...document.querySelectorAll('.dash-group-oldest')].map((n) => n.textContent.trim()),
    };
    btn().click();
    await tick(300);
    return { collapsed, expandedRows: document.querySelectorAll('.dash-row').length, labelAfter: btn().textContent.trim() };
  })()`);
  check(
    "UNI-67 Collapse all hides rows without a Show-more footer; Expand all restores",
    collapseAll.collapsed.label === "Expand all" && collapseAll.collapsed.rows === 0 && collapseAll.collapsed.footer === null &&
      collapseAll.collapsed.oldest.length >= 2 && collapseAll.collapsed.oldest.every((t) => /^oldest \d+[mhd]/.test(t)) &&
      collapseAll.expandedRows > 0 && collapseAll.labelAfter === "Collapse all",
    JSON.stringify(collapseAll),
  );

  // An expanded group reveals ALL its rows even when the global 10-row cap
  // is already spent by earlier groups (the "+8 more does nothing" bug).
  {
    const nebulaSlug = await session.evaluate(`fetch('/api/projects').then((r) => r.json()).then((ps) => ps.find((p) => p.name === 'Nebula Ops').slug)`);
    for (let i = 0; i < 12; i += 1) {
      const id = kbSeed(["add", `nebula blocked ${i}`, "--status", "todo", "--project", nebulaSlug]).id;
      kbSeed(["start", id, "--actor", "agent", "--session", `neb-${i}`, "--pid", String(process.pid), "--project", nebulaSlug]);
      kbSeed(["move", id, "blocked", "--comment", `nebula question ${i}`, "--actor", "agent", "--session", `neb-${i}`, "--project", nebulaSlug]);
    }
  }
  await session.evaluate(`localStorage.setItem('kb.dashboard.inbox', JSON.stringify({ collapsed: [], expanded: ['Batch Project'], all: false })); location.reload()`);
  await sleep(1800);
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(1200);
  const budgetExpand = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const group = () => [...document.querySelectorAll('.dash-inbox-group')].find((g) => g.querySelector('.dash-group-name')?.textContent.trim() === 'Nebula Ops');
    const before = group()?.querySelectorAll('.dash-row').length ?? -1;
    group()?.querySelector('.dash-more')?.click();
    await tick(400);
    const after = group()?.querySelectorAll('.dash-row').length ?? -1;
    const fewer = group()?.querySelector('.dash-more')?.textContent.trim() ?? null;
    group()?.querySelector('.dash-more')?.click();
    await tick(400);
    return { before, after, fewer, afterFewer: group()?.querySelectorAll('.dash-row').length ?? -1 };
  })()`);
  check(
    "UNI-67 +N reveals every row of a group even after the global cap is spent; Show fewer collapses back",
    budgetExpand.after === 12 && budgetExpand.before < 12 && /^Show fewer/.test(budgetExpand.fewer ?? "") && budgetExpand.afterFewer < 12,
    JSON.stringify(budgetExpand),
  );
  // Expand / collapse animate: the group's height transitions (explicit px
  // height + overflow hidden mid-flight, cleared after), revealed rows fade
  // in, and the chevron rotates instead of swapping instantly.
  const anim = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const group = () => document.querySelector('.dash-inbox-group[data-project="Nebula Ops"]');
    const more = () => [...(group()?.querySelectorAll('.dash-more') ?? [])].find((n) => /^\\+\\d+ more/.test(n.textContent.trim()));
    more()?.click();
    await tick(40);
    const mid = { height: group()?.style.height ?? '', overflow: group() ? getComputedStyle(group()).overflow : '', reveal: group()?.querySelectorAll('.dash-row-reveal').length ?? 0 };
    await tick(450);
    const end = { height: group()?.style.height ?? 'x', rows: group()?.querySelectorAll('.dash-row').length ?? -1 };
    group()?.querySelector('.dash-group-head')?.click();
    await tick(40);
    const midCollapse = { height: group()?.style.height ?? '', overflow: group() ? getComputedStyle(group()).overflow : '' };
    await tick(450);
    const chev = group()?.querySelector('.dash-group-chev');
    const collapsedEnd = { height: group()?.style.height ?? 'x', rows: group()?.querySelectorAll('.dash-row').length ?? -1, chev: chev ? getComputedStyle(chev).transform : 'none' };
    group()?.querySelector('.dash-group-head')?.click();
    await tick(450);
    return { mid, end, midCollapse, collapsedEnd };
  })()`);
  check(
    "UNI-67 inbox expand/collapse animates (height transition, revealed rows fade in, chevron rotates)",
    /^\d+(\.\d+)?px$/.test(anim.mid.height) && anim.mid.overflow === "hidden" && anim.mid.reveal > 0
      && anim.end.height === "" && anim.end.rows === 12
      && /^\d+(\.\d+)?px$/.test(anim.midCollapse.height) && anim.midCollapse.overflow === "hidden"
      && anim.collapsedEnd.height === "" && anim.collapsedEnd.rows === 0 && anim.collapsedEnd.chev !== "none",
    JSON.stringify(anim),
  );
  // "Needs you" and "Collapse all" share one text baseline: a zero-height
  // inline-block appended to each sits exactly on its baseline.
  const baselines = await session.evaluate(`(() => {
    const at = (el) => { const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0'; el.appendChild(probe); const y = probe.getBoundingClientRect().bottom; probe.remove(); return y; };
    const head = document.querySelector('.sec-inbox .dash-panel-head');
    const h2 = head?.querySelector('h2'); const btn = head?.querySelector('.dash-collapse-all');
    return h2 && btn ? { h2: at(h2), btn: at(btn) } : null;
  })()`);
  check("UNI-67 'Needs you' and 'Collapse all' share a text baseline", baselines && Math.abs(baselines.h2 - baselines.btn) <= 1, JSON.stringify(baselines));

  // Activity Show more / Show less animate like the inbox.
  const actAnim = await session.evaluate(`(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const panel = () => document.querySelector('.dash-activity[data-panel]');
    const btn = (re) => [...(panel()?.querySelectorAll('.btn') ?? [])].find((b) => re.test(b.textContent));
    if (btn(/Show less/)) { btn(/Show less/).click(); await tick(450); }
    const rowsBefore = panel()?.querySelectorAll('.dash-activity-row').length ?? -1;
    btn(/Show more/)?.click();
    await tick(40);
    const mid = { height: panel()?.style.height ?? '', overflow: panel() ? getComputedStyle(panel()).overflow : '', reveal: panel()?.querySelectorAll('.dash-row-reveal').length ?? 0 };
    await tick(450);
    const end = { height: panel()?.style.height ?? 'x', rows: panel()?.querySelectorAll('.dash-activity-row').length ?? -1 };
    btn(/Show less/)?.click();
    await tick(40);
    const midLess = { height: panel()?.style.height ?? '' };
    await tick(450);
    return { rowsBefore, mid, end, midLess, endLess: panel()?.style.height ?? 'x' };
  })()`);
  check(
    "UNI-67 activity Show more / Show less animates like the inbox",
    /px$/.test(actAnim.mid.height) && actAnim.mid.overflow === "hidden" && actAnim.mid.reveal > 0
      && actAnim.end.height === "" && actAnim.end.rows > actAnim.rowsBefore
      && /px$/.test(actAnim.midLess.height) && actAnim.endLess === "",
    JSON.stringify(actAnim),
  );

  await session.evaluate(`localStorage.removeItem('kb.dashboard.inbox'); window.__kbDashReload?.()`);
  await sleep(900);

  // Layout polish: card spacing balance, card width, activity titles, inset.
  const polish = await session.evaluate(`(() => {
    const card = document.querySelector('.dashboard .project-card');
    const bar = card.querySelector('.stack-bar').getBoundingClientRect();
    const above = (card.querySelector('.pc-badges') ?? card.querySelector('.pc-head')).getBoundingClientRect();
    const below = card.querySelector('.pc-stats').getBoundingClientRect();
    const titles = [...document.querySelectorAll('.dash-activity-title')];
    const truncated = titles.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent);
    return {
      gapAbove: Math.round(bar.top - above.bottom),
      gapBelow: Math.round(below.top - bar.bottom),
      cardWidth: Math.round(card.getBoundingClientRect().width),
      truncated,
      padLeft: getComputedStyle(document.querySelector('.dashboard')).paddingLeft,
    };
  })()`);
  check("UNI-67 project card progress bar has balanced spacing", Math.abs(polish.gapAbove - polish.gapBelow) <= 3 && polish.gapBelow >= 8, JSON.stringify(polish));
  check("UNI-67 dashboard project cards are at least 300px wide", polish.cardWidth >= 300, JSON.stringify(polish));
  check("UNI-67 activity titles are not truncated when they fit", polish.truncated.length === 0, JSON.stringify(polish));
  check("UNI-67 dashboard side inset matches the board (18px)", polish.padLeft === "18px", JSON.stringify(polish));

  // Restore: uncollapse + clear prefs for later checks.
  await session.evaluate(`(() => {
    document.querySelector('.dash-inbox-group .dash-group-head').click();
    localStorage.removeItem('kb.dashboard.inbox');
    window.__kbDashReload?.();
  })()`);
  await sleep(900);


  // ═══ UNI-67: empty / all-clear state ═════════════════════════════════
  await session.evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find((b) => b.textContent.includes('Dashboard'))?.click()`);
  await sleep(900);
  await session.evaluate(`(async () => {
    const projects = await fetch('/api/projects').then((r) => r.json());
    for (const project of projects.filter((p) => !p.archived)) {
      await fetch('/api/projects/' + project.slug, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    }
    window.__kbDashReload?.();
  })()`);
  await sleep(1200);
  const emptyState = await session.evaluate(`(() => ({
    zero: document.querySelector('.dash-inbox-zero')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    summary: document.querySelector('.dash-summary')?.textContent.trim() ?? '',
  }))()`);
  check("UNI-67 empty state celebrates Inbox zero", /Inbox zero/.test(emptyState.zero ?? "") && /nothing waiting/.test(emptyState.summary), JSON.stringify(emptyState));
  await session.evaluate(`document.documentElement.dataset.theme = 'dark'; localStorage.setItem('kanboard.theme', 'dark');`);
  await sleep(300);
  await session.shot("dashboard-empty-dark.png");

  // ═══ page errors ════════════════════════════════════════════════════════
  const errors = await session.evaluate(`window.__kbErrors ?? []`);
  check("no uncaught page errors", errors.length === 0, errors.join(" · ") || "none");
} catch (error) {
  check("ui batch completed", false, error instanceof Error ? error.message : String(error));
} finally {
  chromium.kill();
  cleanup();
}

console.log(failures === 0 ? "\n✓ all batch UI checks passed" : `\n✗ ${failures} batch UI check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
