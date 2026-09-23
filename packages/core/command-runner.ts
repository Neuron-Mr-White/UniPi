/**
 * Named command runners — how hub ACTION rows invoke existing module flows.
 *
 * pi's ExtensionAPI has no executeCommand; modules register an invoker for
 * their command here (closure over the same handler logic), and the settings
 * hub's `action` fields call it with the caller's ctx. Registration is by
 * full command name ("unipi:mcp-sync").
 */

export type CommandRunner = (ctx: unknown, args?: unknown) => unknown | Promise<unknown>;

const runners = new Map<string, CommandRunner>();

export function registerCommandRunner(name: string, run: CommandRunner): void {
  runners.set(name, run);
}

/** Returns false when nobody registered `name` (callers surface that). */
export async function runCommandByName(name: string, ctx: unknown, args?: unknown): Promise<boolean> {
  const run = runners.get(name);
  if (!run) return false;
  await run(ctx, args);
  return true;
}

/**
 * Call a runner and hand back whatever it returned — how one module asks
 * another to do something and reads the outcome (e.g. kanboard starting a
 * long-horizon goal). `found: false` means nobody registered that name.
 */
export async function callCommandRunner<T = unknown>(
  name: string,
  ctx: unknown,
  args?: unknown,
): Promise<{ found: boolean; result?: T }> {
  const run = runners.get(name);
  if (!run) return { found: false };
  return { found: true, result: (await run(ctx, args)) as T };
}

/** Test hook. */
export function resetCommandRunners(): void {
  runners.clear();
}
