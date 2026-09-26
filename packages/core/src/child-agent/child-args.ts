/**
 * Extension-selection flags the sidekick child must inherit from the lead's
 * argv — otherwise `pi --no-extensions -e <repo>` still lets the child pick
 * up the globally installed suite. Pure: reads a plain argv array.
 */

export function leadExtensionArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--extension" || arg === "-e") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.push("--extension", value);
        i++;
      }
    } else if (arg === "--no-extensions" || arg === "-ne") {
      out.push("--no-extensions");
    } else if (arg === "--skill") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.push("--skill", value);
        i++;
      }
    }
    // --no-skills is unconditional below: the child never needs skill
    // discovery; the parent's --no-skills is preserved anyway.
  }
  out.push("--no-skills");
  return out;
}
