#!/usr/bin/env node
/**
 * Screenshot set for design review (no assertions — see ui.mjs for checks).
 *   node crates/kanboard/tests/shots.mjs --url http://127.0.0.1:PORT --project SLUG --out /tmp/kanboard-evidence --prefix k7
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = flag("--url");
const project = flag("--project");
const out = flag("--out", "/tmp/kanboard-evidence");
const prefix = flag("--prefix", "k7");
const only = flag("--only", null);
const PORT = Number(process.env.CDP_PORT ?? 9444);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
mkdirSync(out, { recursive: true });

const chrome = spawn(
  "chromium",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "kb-shots-"))}`, "about:blank"],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok) => (ws.onopen = ok));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
          }
        };
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("no chromium");
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const size = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
async function shot(name) {
  if (only && !name.includes(only)) return;
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = join(out, `${prefix}-${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(file);
}
const key = (key, extra = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, ...${JSON.stringify(extra)} }))`);
const theme = async (name) => {
  await js(`localStorage.setItem('kanboard.theme', '${name}'); document.documentElement.dataset.theme = '${name}'`);
  await sleep(150);
};
const url = (extra = "") => {
  const [root, query] = base.split("?");
  const params = new URLSearchParams(query ?? "");
  if (project) params.set("project", project);
  return `${root}?${params}${extra}`;
};

try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  for (const [w, h] of [
    [1440, 900],
    [1920, 1080],
  ]) {
    for (const mode of ["light", "dark"]) {
      await size(w, h);
      await send("Page.navigate", { url: url() });
      await sleep(1600);
      await theme(mode);
      await js(`localStorage.setItem('kanboard.sidebar','open')`);
      await sleep(300);
      await shot(`board-${mode}-${w}`);
      if (w !== 1440) continue;

      // detail drawer on the running task (or the first card)
      await js(`(document.querySelector('.card.running') ?? document.querySelector('.lane[data-lane="in_review"] .card') ?? document.querySelector('.card')).click()`);
      await sleep(500);
      await shot(`detail-${mode}-${w}`);
      await js(`document.querySelector('[aria-label="Close details"]')?.click()`);
      await sleep(300);

      // list view
      await js(`[...document.querySelectorAll('.segmented .btn')].find((b) => b.textContent.includes('List'))?.click()`);
      await sleep(400);
      await shot(`list-${mode}-${w}`);
      await js(`[...document.querySelectorAll('.segmented .btn')].find((b) => b.textContent.includes('Board'))?.click()`);
      await sleep(300);

      // new task dialog
      await key("c");
      await sleep(350);
      await js(`(() => { const i = document.querySelector('.dialog-title-input'); if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Retry failed webhooks with exponential backoff'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(200);
      await shot(`newtask-${mode}-${w}`);
      await key("Escape");
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);

      // palette
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
      await sleep(350);
      await js(`(() => { const i = document.querySelector('.palette-input input'); if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'sess'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(250);
      await shot(`palette-${mode}-${w}`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);

      // filter popover open
      await js(`[...document.querySelectorAll('.toolbar .btn')].find((b) => b.textContent.includes('Filter'))?.click()`);
      await sleep(300);
      await shot(`filter-${mode}-${w}`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(200);

      // mid-drag: a todo card over backlog
      await js(`(async () => {
        const card = document.querySelector('.lane[data-lane="todo"] .card');
        const lane = document.querySelector('.lane[data-lane="backlog"]');
        if (!card || !lane) return;
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 120));
        const second = lane.querySelectorAll('.card')[1] ?? lane.querySelector('.card');
        const y = second ? second.getBoundingClientRect().top + 4 : lane.getBoundingClientRect().top + 60;
        lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
      })()`);
      await sleep(300);
      await shot(`drag-${mode}-${w}`);
      await js(`document.querySelector('.card.dragging')?.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`);
      await sleep(200);

      // collapsed sidebar
      await key("[");
      await sleep(350);
      await shot(`collapsed-${mode}-${w}`);
      await key("[");
      await sleep(200);
    }
  }
  // all projects
  await size(1440, 900);
  await send("Page.navigate", { url: url() });
  await sleep(1200);
  await theme("light");
  await js(`[...document.querySelectorAll('.crumbs .crumb')].find((b) => b.textContent === 'Projects')?.click()`);
  await sleep(500);
  await shot(`projects-light-1440`);
  const errors = await js(`window.__kbErrors ?? []`);
  if (errors?.length) console.log("page errors:", errors);
} finally {
  chrome.kill();
  process.exit(0);
}
