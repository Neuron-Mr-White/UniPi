/**
 * @pi-unipi/kanboard — Milestone Routes
 *
 * Routes for the milestone page and API.
 */

import * as path from "node:path";
import type { KanboardServer } from "../index.js";
import { ParserRegistry } from "../../parser/index.js";
import { MilestoneParser } from "../../parser/milestones.js";
import { renderMilestonePage } from "../../ui/milestone/page.js";

/** Register milestone routes on the server */
export function registerMilestoneRoutes(
  server: KanboardServer,
  docsRoot: string,
): void {
  const registry = new ParserRegistry();
  registry.register(new MilestoneParser());

  const milestonesPath = path.join(docsRoot, "MILESTONES.md");

  // GET / — Milestone page
  server.route("GET", "/", (_req, res) => {
    const doc = registry.parse(milestonesPath);
    const docs = doc ? [doc] : [];
    const html = renderMilestonePage(docs);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  // GET /api/milestones — Milestone JSON data
  server.route("GET", "/api/milestones", (_req, res) => {
    const doc = registry.parse(milestonesPath);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(doc ?? { items: [] }));
  });
}
