/**
 * @pi-unipi/skill-registry — Extension entry
 *
 * Per turn (before_agent_start), on pi's discovered skills:
 *   1. registry (proxy on): drop skills turned off — removed from the session,
 *      /skill:name included; the vault is mounted via resources_discover and
 *      stays off until a scope turns a skill on.
 *   2. exposure: off (bundled stripped) | all | judged (see src/judge.ts).
 * Plus /unipi:skills (the hub opened on Skills), the "Skill settings…" overlay
 * (per-skill Enabled / Must show, src/editor.ts), and the
 * reveal event kanboard uses to surface a skill mid-session.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitEvent, getPackageVersion, harnessMetadata, HUB_OVERLAY_OPTIONS, MODULES, openSettingsHub, registerCommandRunner, setSettings, UNIPI_EVENTS } from "@pi-unipi/core";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRegistry, defaultMustShow, isBundledSkillLocation, isUnderDir, skillCommandName, skillDir, skillSource, type CatalogSkill } from "./src/registry.js";
import { readSkillsSettings, readStateLayers, writeStateLayers } from "./src/settings.js";
import { SkillEditor, type EditorResult } from "./src/editor.js";
import { listVaultSkills, vaultDir } from "./src/vault.js";
import {
  decideTurn,
  emptyState,
  HIDDEN_SECTION,
  restoreState,
  revealMessage,
  SKILLS_JUDGED_ENTRY,
  SKILLS_REVEALED_ENTRY,
  toEntry,
  type SessionSkillsState,
} from "./src/judge.js";

export { SKILLS_JUDGED_ENTRY, SKILLS_REVEALED_ENTRY } from "./src/judge.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Event another module emits to reveal a skill by name (append-only). */
export const SKILL_REVEAL_EVENT = "unipi:skills:reveal";

export default function skillRegistry(pi: ExtensionAPI) {
  let state: SessionSkillsState | null = null;
  let lastCatalog: CatalogSkill[] = [];
  let disabled = new Set<string>();

  const sessionState = (ctx: ExtensionContext): SessionSkillsState => {
    const id = ctx.sessionManager.getSessionId();
    if (!state || state.sessionId !== id) state = emptyState(id);
    return state;
  };

  /** Everything the manager can show: last catalog ∪ pi's skill commands ∪ vault. */
  const allSkills = (): CatalogSkill[] => {
    const byName = new Map<string, CatalogSkill>();
    for (const s of lastCatalog) byName.set(s.name, s);
    try {
      for (const c of pi.getCommands()) {
        if (c.source !== "skill") continue;
        const name = c.name.replace(/^skill:/, "");
        if (!byName.has(name)) byName.set(name, { name, description: c.description ?? "", filePath: c.sourceInfo?.path });
      }
    } catch {
      // getCommands unavailable (tests) — catalog + vault only.
    }
    for (const v of listVaultSkills()) if (!byName.has(v.name)) byName.set(v.name, v);
    return [...byName.values()];
  };

  const invalidateJudgement = () => {
    if (state) state.judged = false;
  };

  /** "Skill settings…" — the per-skill E/M overlay. */
  const openEditor = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const cwd = ctx.cwd ?? process.cwd();
    const vault = vaultDir();
    const skills = allSkills()
      .map((sk) => ({ name: sk.name, description: sk.description, source: skillSource(sk, cwd, vault) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const before = readStateLayers(cwd);
    const settings = readSkillsSettings(cwd);
    const hasProject = Object.keys(before.project).length > 0;
    const result = await ctx.ui.custom<EditorResult>(
      (tui, theme, _kb, done) =>
        new SkillEditor({
          skills,
          layers: before,
          proxy: settings.proxy,
          initialScope: hasProject ? "project" : "global",
          theme: { fg: (c, text) => theme.fg(c as never, text), bold: (text) => theme.bold(text) },
          onDone: done,
          onRenderRequest: () => tui.requestRender(),
        }),
      HUB_OVERLAY_OPTIONS,
    );
    if (result.type !== "saved") return;
    const writes = writeStateLayers(cwd, before, result.layers);
    if (result.proxy !== settings.proxy) setSettings("skills", { proxy: result.proxy }, "global", cwd);
    if (writes > 0 || result.proxy !== settings.proxy) {
      invalidateJudgement();
      ctx.ui.notify(`Skill settings saved (${writes} change${writes === 1 ? "" : "s"}${result.proxy !== settings.proxy ? `, proxy ${result.proxy ? "on" : "off"}` : ""}) — applies from the next prompt`, "info");
    }
  };
  registerCommandRunner("unipi:skills-editor", async (raw: unknown) => openEditor(raw as ExtensionContext));

  pi.registerCommand("unipi:skills", {
    description: "Skill settings — proxy, exposure, and per-skill Enabled / Must show (opens /unipi:settings on Skills)",
    handler: async (_args, ctx) => {
      await openSettingsHub(ctx, {
        filter: "skills",
        onChanged: (ns) => {
          if (ns === "skills") invalidateJudgement();
        },
      });
    },
  });

  // The vault is always mounted so toggles apply without /reload; while the
  // proxy is off, vault skills are filtered out below (and /skill:name blocked).
  pi.on("resources_discover", () => {
    try {
      const vault = vaultDir();
      return existsSync(vault) ? { skillPaths: [vault] } : undefined;
    } catch {
      return undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      state = restoreState(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
      emitEvent(pi, UNIPI_EVENTS.MODULE_READY, { name: MODULES.SKILL_REGISTRY, version: VERSION, commands: ["unipi:skills"], tools: [] });
    } catch {
      // never block startup
    }
  });

  // A skill turned off is gone for the session — /skill:name included.
  pi.on("input", (event, ctx) => {
    try {
      const name = skillCommandName(event.text ?? "");
      if (!name || !disabled.has(name)) return undefined;
      ctx.ui?.notify?.(`Skill "${name}" is turned off here. Turn it on in /unipi:skills.`, "warning");
      return { action: "handled" as const };
    } catch {
      return undefined;
    }
  });

  pi.events?.on?.(SKILL_REVEAL_EVENT, (payload: unknown) => {
    try {
      const data = payload as { names?: unknown } | undefined;
      if (!Array.isArray(data?.names) || !state) return;
      const names = data.names.map(String).filter((n) => !state!.revealed.has(n));
      const entries = state.hidden.filter((h) => names.includes(h.name));
      if (entries.length === 0) return;
      const revealed = entries.map((e) => e.name);
      for (const e of entries) state.revealed.add(e.name);
      pi.appendEntry(SKILLS_REVEALED_ENTRY, { names: revealed });
      pi.sendMessage({ customType: "unipi-skills-revealed", content: revealMessage(entries), display: true, details: { names: revealed, unipiHarness: harnessMetadata({ source: "Skills", title: "Skill reveal", synopsis: revealed.join(", "), lines: entries.map((e) => `${e.name} — ${e.description}`) }, "direct") } }, { triggerTurn: false });
    } catch {
      // ignore
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const cwd = ctx.cwd ?? process.cwd();
      const options = event.systemPromptOptions;
      const catalog = (options.skills ?? []) as unknown as CatalogSkill[];
      lastCatalog = catalog;
      const settings = readSkillsSettings(cwd);

      const vault = vaultDir();
      let pool = catalog;
      let mustShow = new Set<string>();
      disabled = new Set();
      if (settings.proxy) {
        const result = applyRegistry(catalog, settings.states, cwd, vault);
        pool = result.listed;
        disabled = result.disabled;
        mustShow = result.mustShow;
      } else {
        pool = catalog.filter((s) => {
          const inVault = isUnderDir(skillDir(s), vault);
          if (inVault) disabled.add(s.name);
          return !inVault;
        });
        // Proxy off: per-skill states are ignored, defaults still apply.
        for (const s of pool) if (defaultMustShow(s.name, skillSource(s, cwd, vault))) mustShow.add(s.name);
      }

      const setSkills = (list: CatalogSkill[]) => {
        options.skills = list as unknown as typeof options.skills;
      };
      if (settings.exposure.mode !== "judged") {
        setSkills(settings.exposure.mode === "off" ? pool.filter((s) => mustShow.has(s.name) || !isBundledSkillLocation(skillDir(s))) : pool);
        delete options.sections[HIDDEN_SECTION];
        return undefined;
      }

      const out = await decideTurn({
        prompt: event.prompt,
        catalog: pool.map(toEntry),
        settings: settings.exposure,
        cwd,
        state: sessionState(ctx),
        mustShow,
      });
      setSkills(pool.filter((s) => out.listed.has(s.name)));
      if (out.index) options.sections[HIDDEN_SECTION] = out.index;
      else delete options.sections[HIDDEN_SECTION];
      if (out.freeze) pi.appendEntry(SKILLS_JUDGED_ENTRY, out.freeze);
      if (out.status && ctx.hasUI) ctx.ui.setStatus("skills", out.status);
      if (out.reveal.length > 0) {
        const names = out.reveal.map((r) => r.name);
        pi.appendEntry(SKILLS_REVEALED_ENTRY, { names });
        return {
          message: {
            customType: "unipi-skills-revealed",
            content: revealMessage(out.reveal),
            display: true,
            details: { names, unipiHarness: harnessMetadata({ source: "Skills", title: "Skill reveal", synopsis: names.join(", "), lines: out.reveal.map((r) => `${r.name} — ${r.description}`) }, "before_agent_start") },
          },
        };
      }
      return undefined;
    } catch {
      return undefined; // never abort a turn
    }
  });
}
