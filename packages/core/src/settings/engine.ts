/**
 * Core settings engine — registration, layered reads, scoped writes.
 *
 * Every unipi module registers its namespace; reads are
 * defaults ⊕ global ⊕ project (workspace wins); writes go to exactly one
 * scope. Modules keep their own types; the engine only layers objects.
 *
 * The /unipi:settings hub (overlay UI) reads the registry to render every
 * module's settings in one place.
 */

import { readFileSync } from "node:fs";
import { globalSettingsPath, projectSettingsPath } from "./paths.js";
import { migrateToV3Layout } from "./migrations.js";
import { ensureDir, tryRead, writeJson } from "../../utils.js";

export interface SettingsDefinition {
  /** Directory name under ~/.unipi/config (kebab-case module id). */
  readonly namespace: string;
  /** Human label for the hub UI. */
  readonly label: string;
  /** Full defaults object (also the hub's baseline documentation). */
  readonly defaults: Record<string, unknown>;
  /** False when a module has no project-level override layer. Default true. */
  readonly projectOverrides?: boolean;
}

const registry = new Map<string, SettingsDefinition>();
let migrated = false;

export function registerSettings(definition: SettingsDefinition): void {
  registry.set(definition.namespace, definition);
}

export function listSettingsDefinitions(): SettingsDefinition[] {
  return [...registry.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
}

export function getSettingsDefinition(namespace: string): SettingsDefinition | undefined {
  return registry.get(namespace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | null {
  const raw = tryRead(file);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isRecord(value) && isRecord(existing) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Run the v2→v3 migration once per process before any settings read. */
export function ensureMigrated(cwd: string): void {
  if (migrated) return;
  migrated = true;
  try {
    migrateToV3Layout(cwd);
  } catch {
    // Migration failures never block startup; legacy sources remain.
  }
}

export type SettingsScope = "global" | "project";

export function getSettings(
  namespace: string,
  cwd: string,
): Record<string, unknown> {
  const definition = registry.get(namespace);
  if (!definition) return {};
  let effective = { ...definition.defaults };
  const global = readJson(globalSettingsPath(namespace));
  if (global) effective = deepMerge(effective, global);
  if (definition.projectOverrides !== false) {
    const project = readJson(projectSettingsPath(cwd, namespace));
    if (project) effective = deepMerge(effective, project);
  }
  return effective;
}

export function setSettings(
  namespace: string,
  patch: Record<string, unknown>,
  scope: SettingsScope,
  cwd: string,
): void {
  const definition = registry.get(namespace);
  if (!definition) throw new Error(`unknown settings namespace: ${namespace}`);
  if (scope === "project" && definition.projectOverrides === false) {
    throw new Error(`${namespace} does not support project overrides`);
  }
  const target =
    scope === "global" ? globalSettingsPath(namespace) : projectSettingsPath(cwd, namespace);
  const current = readJson(target) ?? {};
  writeJson(target, deepMerge(current, patch));
}

/** Which layers currently exist for a namespace (hub status display). */
export function settingsLayers(namespace: string, cwd: string): { global: boolean; project: boolean } {
  return {
    global: tryRead(globalSettingsPath(namespace)) !== null,
    project: tryRead(projectSettingsPath(cwd, namespace)) !== null,
  };
}
