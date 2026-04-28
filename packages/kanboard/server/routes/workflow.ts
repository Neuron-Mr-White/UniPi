/**
 * @pi-unipi/kanboard — Workflow Routes
 *
 * Routes for the workflow page and API.
 */

import type { KanboardServer } from "../index.js";
import { ParserRegistry, createDefaultRegistry } from "../../parser/index.js";
import { renderWorkflowPage } from "../../ui/workflow/page.js";

/** Register workflow routes on the server */
export function registerWorkflowRoutes(
  server: KanboardServer,
  docsRoot: string,
): void {
  let registry: ParserRegistry | null = null;

  const getRegistry = async (): Promise<ParserRegistry> => {
    if (!registry) {
      registry = await createDefaultRegistry();
    }
    return registry;
  };

  // GET /workflow — Workflow page
  server.route("GET", "/workflow", async (_req, res) => {
    const reg = await getRegistry();
    const docs = reg.parseAll(docsRoot);
    const html = renderWorkflowPage(docs);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  // GET /api/workflow — Workflow JSON data
  server.route("GET", "/api/workflow", async (_req, res) => {
    const reg = await getRegistry();
    const docs = reg.parseAll(docsRoot);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ docs }));
  });
}
