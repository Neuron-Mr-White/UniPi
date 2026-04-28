/**
 * @pi-unipi/kanboard — HTTP Server
 *
 * Lightweight HTTP server with port allocation, PID management,
 * static file serving, and route registration.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { KANBOARD_DEFAULTS, KANBOARD_DIRS } from "@pi-unipi/core";
import type { KanboardConfig } from "../types.js";

/** Content-type map for static files */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Route handler type */
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

/** Registered route */
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/** Kanboard server instance */
export class KanboardServer {
  private server: http.Server | null = null;
  private config: KanboardConfig;
  private routes: Route[] = [];
  private staticDir: string;

  constructor(config?: Partial<KanboardConfig>) {
    this.config = {
      port: config?.port ?? KANBOARD_DEFAULTS.PORT,
      maxPort: config?.maxPort ?? KANBOARD_DEFAULTS.MAX_PORT,
      docsRoot: config?.docsRoot ?? ".unipi/docs",
      pidFile: config?.pidFile ?? KANBOARD_DIRS.PID_FILE,
    };
    this.staticDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "ui",
      "static",
    );
  }

  /** Register a route */
  route(method: string, pattern: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    // Convert Express-style params (:name) to regex capture groups
    const regexStr = pattern.replace(/:(\w+)/g, (_match, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  /** Start the server with port allocation */
  async start(): Promise<{ port: number; url: string }> {
    // Check for existing instance
    const existing = this.checkExistingInstance();
    if (existing) {
      console.log(`[kanboard] Existing instance detected at ${existing}`);
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    const port = await this.allocatePort();
    if (port === null) {
      throw new Error(
        `[kanboard] Could not bind to any port ${this.config.port}-${this.config.maxPort}`,
      );
    }

    // Write PID file
    this.writePidFile();

    // Graceful shutdown
    const shutdown = () => {
      console.log("[kanboard] Shutting down...");
      this.server?.close(() => {
        this.removePidFile();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const url = `http://localhost:${port}`;
    console.log(`[kanboard] Server running at ${url}`);
    return { port, url };
  }

  /** Stop the server */
  stop(): void {
    this.server?.close();
    this.removePidFile();
    this.server = null;
  }

  /** Get the docs root directory */
  getDocsRoot(): string {
    return this.config.docsRoot;
  }

  /** Try ports in range, return first available */
  private async allocatePort(): Promise<number | null> {
    for (let port = this.config.port; port <= this.config.maxPort; port++) {
      try {
        await this.listen(port);
        return port;
      } catch (err: any) {
        if (err.code === "EADDRINUSE") {
          console.log(`[kanboard] Port ${port} in use, trying next...`);
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  /** Bind server to a port */
  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, () => resolve());
    });
  }

  /** Handle incoming HTTP request */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Static files
    if (pathname.startsWith("/static/")) {
      return this.serveStatic(pathname, res);
    }

    // Match routes
    for (const route of this.routes) {
      if (req.method !== route.method) continue;
      const match = pathname.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        try {
          await route.handler(req, res, params);
        } catch (err: any) {
          console.error(`[kanboard] Route error: ${err.message}`);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
        return;
      }
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  /** Serve static files from ui/static/ */
  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const filePath = path.join(this.staticDir, pathname.replace("/static/", ""));
    const resolved = path.resolve(filePath);

    // Prevent directory traversal
    if (!resolved.startsWith(path.resolve(this.staticDir))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(resolved);
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const content = fs.readFileSync(resolved);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  }

  /** Check if an existing kanboard instance is running */
  checkExistingInstance(): string | null {
    try {
      if (!fs.existsSync(this.config.pidFile)) return null;
      const pid = parseInt(fs.readFileSync(this.config.pidFile, "utf-8").trim(), 10);
      if (isNaN(pid)) return null;
      // Check if process exists
      process.kill(pid, 0);
      // Process exists — return warning URL
      return `http://localhost:${this.config.port} (PID: ${pid})`;
    } catch {
      // Process doesn't exist or can't access PID file
      return null;
    }
  }

  /** Write current PID to file */
  private writePidFile(): void {
    try {
      const dir = path.dirname(this.config.pidFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.config.pidFile, String(process.pid));
    } catch (err: any) {
      console.warn(`[kanboard] Could not write PID file: ${err.message}`);
    }
  }

  /** Remove PID file */
  private removePidFile(): void {
    try {
      if (fs.existsSync(this.config.pidFile)) {
        fs.unlinkSync(this.config.pidFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/** Create and start a kanboard server with default routes */
export async function startServer(
  config?: Partial<KanboardConfig>,
): Promise<{ server: KanboardServer; port: number; url: string }> {
  const server = new KanboardServer(config);
  const docsRoot = server.getDocsRoot();

  // Register route modules
  const { registerMilestoneRoutes } = await import("./routes/milestone.js");
  const { registerWorkflowRoutes } = await import("./routes/workflow.js");

  registerMilestoneRoutes(server, docsRoot);
  registerWorkflowRoutes(server, docsRoot);

  server.route("POST", "/api/docs/:type/:file/items/:line", async (req, res) => {
    // Placeholder — will be implemented with actual file updating
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  const { port, url } = await server.start();
  return { server, port, url };
}
