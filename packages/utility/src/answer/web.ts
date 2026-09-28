/**
 * @pi-unipi/utility — /unipi:answer web form
 *
 * A one-shot local page: the agent's full reply on the left, one answer box
 * per question on the right (plus a free-text note), submit → resolves. Bound
 * to 127.0.0.1 with a random token in the URL; over SSH the caller shows a
 * port-forward command instead of opening a browser.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface WebAnswer {
  answers: string[];
  note: string;
}

export interface WebForm {
  url: string;
  port: number;
  result: Promise<WebAnswer | null>;
  close: () => void;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tiny markdown → HTML for the reply pane: fences, headings, lists, bold, code. */
export function renderReply(md: string): string {
  const out: string[] = [];
  let code: string[] | null = null;
  let list = false;
  let table: string[][] | null = null;
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(`<table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = null;
  };
  for (const line of md.split("\n")) {
    if (!code && /^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      (table ??= []).push(line.trim().slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (/^\s*```/.test(line)) {
      if (code) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (list) {
      out.push("</ul>");
      list = false;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push(`<h${Math.min(4, h[1]!.length + 1)}>${inline(h[2]!)}</h${Math.min(4, h[1]!.length + 1)}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flushTable();
  if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  if (list) out.push("</ul>");
  return out.join("\n");
}

export function formPage(reply: string, questions: readonly string[], token: string): string {
  const qs = questions.length ? questions : ["Your reply"];
  const fields = qs.map((q, i) => `
      <label><span class="n">${i + 1}</span><span class="q">${esc(q)}</span></label>
      <textarea name="a${i}" rows="3" placeholder="Answer (empty = skip)"></textarea>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Answer — pi</title>
<style>
  :root{color-scheme:dark;--bg:#16181d;--panel:#1e2128;--line:#2c313a;--fg:#d7dae0;--dim:#8a919e;--accent:#53a0d7}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,sans-serif}
  main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);height:100vh}
  section{overflow:auto;padding:24px 28px} .reply{border-right:1px solid var(--line)}
  h1{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 16px}
  table{border-collapse:collapse;margin:10px 0} th,td{border:1px solid var(--line);padding:5px 10px;text-align:left} th{color:var(--dim);font-weight:600}
  pre{background:var(--panel);padding:10px 12px;border-radius:6px;overflow:auto} code{font:12.5px ui-monospace,monospace}
  label{display:flex;gap:10px;margin:18px 0 6px} .n{color:var(--accent);font-weight:600} .q{flex:1}
  textarea{width:100%;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:inherit;resize:vertical}
  textarea:focus{outline:none;border-color:var(--accent)}
  .bar{position:sticky;bottom:0;background:var(--bg);padding:14px 0;display:flex;gap:12px;align-items:center}
  button{background:var(--accent);color:#0b0d10;border:0;border-radius:6px;padding:9px 18px;font-weight:600;cursor:pointer}
  .hint{color:var(--dim);font-size:12px} .done{padding:40px;font-size:16px}
  @media (max-width:900px){main{grid-template-columns:1fr;height:auto}.reply{border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><main>
  <section class="reply"><h1>Agent's reply</h1>${renderReply(reply)}</section>
  <section><h1>Your answers</h1>
    <form id="f">${fields}
      <label><span class="q">Anything else</span></label>
      <textarea name="note" rows="3" placeholder="Optional note"></textarea>
      <div class="bar"><button type="submit">Send to pi</button><span class="hint">Ctrl+Enter sends</span></div>
    </form>
  </section>
</main>
<script>
const f=document.getElementById("f");
const send=async()=>{const d=new FormData(f);const answers=${JSON.stringify(qs.map((_, i) => `a${i}`))}.map(k=>d.get(k)||"");
  const r=await fetch("/a/${token}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({answers,note:d.get("note")||""})});
  document.body.innerHTML='<div class="done">'+(r.ok?"Sent to pi. You can close this tab.":"Could not send — is pi still waiting?")+'</div>';};
f.addEventListener("submit",e=>{e.preventDefault();send();});
f.addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}});
document.querySelector("textarea")?.focus();
</script></body></html>`;
}

/** Start the form server. `port` 0 = any free port. */
export function startWebForm(reply: string, questions: readonly string[], port = 0): Promise<WebForm> {
  const token = randomBytes(12).toString("hex");
  let settle: (v: WebAnswer | null) => void = () => {};
  const result = new Promise<WebAnswer | null>((resolve) => { settle = resolve; });
  const page = formPage(reply, questions, token);
  const server: Server = createServer((req, res) => {
    if (req.url !== `/a/${token}`) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on("end", () => {
        try {
          const data = JSON.parse(body) as { answers?: unknown; note?: unknown };
          const answers = Array.isArray(data.answers) ? data.answers.map((a) => String(a ?? "")) : [];
          res.writeHead(200).end("ok");
          settle({ answers, note: typeof data.note === "string" ? data.note : "" });
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(405).end();
  });
  const close = () => {
    settle(null);
    server.close();
    server.closeAllConnections?.();
  };
  void result.then(() => setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 500).unref());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${actual}/a/${token}`, port: actual, result, close });
    });
  });
}
