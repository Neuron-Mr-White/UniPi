import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { TrajectorySnapshot } from "./project.js";
import { TRAJECTORY_APP, TRAJECTORY_CSS, TRAJECTORY_HTML, TRAJECTORY_THEME_CSS } from "./ui.js";

export interface TrajectoryServerOptions {
  snapshot: () => TrajectorySnapshot;
  port?: number;
  maxPort?: number;
}

const HOST = "127.0.0.1";

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

export class TrajectoryServer {
  private server: Server | null = null;
  private readonly options: Required<Pick<TrajectoryServerOptions, "port" | "maxPort">> & TrajectoryServerOptions;
  url: string | null = null;

  constructor(options: TrajectoryServerOptions) {
    this.options = { ...options, port: options.port ?? 8176, maxPort: options.maxPort ?? 8186 };
  }

  async start(): Promise<string> {
    if (this.url) return this.url;
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${HOST}`);
        if (req.method !== "GET") { res.writeHead(405).end("Method Not Allowed"); return; }
        if (url.pathname === "/api/snapshot") { json(res, this.options.snapshot()); return; }
        if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
        if (url.pathname === "/app.js") {
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end(TRAJECTORY_APP); return;
      }
      if (url.pathname === "/style.css") {
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/css; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end(`${TRAJECTORY_CSS}\n${TRAJECTORY_THEME_CSS}`); return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'self'", "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
        res.end(TRAJECTORY_HTML); return;
      }
        res.writeHead(404).end("Not Found");
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    for (let port = this.options.port; port <= this.options.maxPort; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => { this.server?.off("listening", onListening); reject(error); };
          const onListening = () => { this.server?.off("error", onError); resolve(); };
          this.server!.once("error", onError).once("listening", onListening).listen(port, HOST);
        });
        this.url = `http://${HOST}:${port}`;
        return this.url;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    this.server = null;
    throw new Error(`No trajectory port available (${this.options.port}-${this.options.maxPort})`);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.url = null;
  }
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
