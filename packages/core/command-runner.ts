/**
 * Named command runners — how hub ACTION rows invoke existing module flows.
 *
 * pi's ExtensionAPI has no executeCommand; modules register an invoker for
 * their command here (closure over the same handler logic), and the settings
 * hub's `action` fields call it with the caller's ctx. Registration is by
 * full command name ("unipi:mcp-settings").
 */

export type CommandRunner = (ctx: unknown) => void | Promise<void>;

const runners = new Map<string, CommandRunner>();

export function registerCommandRunner(name: string, run: CommandRunner): void {
  runners.set(name, run);
}

/** Returns false when nobody registered `name` (callers surface that). */
export async function runCommandByName(name: string, ctx: unknown): Promise<boolean> {
  const run = runners.get(name);
  if (!run) return false;
  await run(ctx);
  return true;
}

/** Test hook. */
export function resetCommandRunners(): void {
  runners.clear();
}
