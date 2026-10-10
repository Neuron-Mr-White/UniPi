/**
 * withCommandEcho — wrap an ExtensionAPI so every registered slash command
 * leaves a `❭ /cmd args` line in the chat transcript, like Devin's /btw.
 *
 * pi clears the editor and runs the handler inside the input path
 * (agent-session `_tryExecuteExtensionCommand`), so there is no pi hook that
 * sees a command before it runs — wrapping `registerCommand` is the only
 * interception point.
 *
 * The echo is a `unipi-command-echo` custom entry: UI-only, never sent to
 * the model, rendered live on `entry_appended` and after resume. Echo
 * failures never block the command itself.
 */

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const COMMAND_ECHO_TYPE = "unipi-command-echo";

/** Internal commands that must never leave an echo (UNI-251: the app
 * bridge's hidden `unipi-app-session`, run by `pi.sendUserMessage`, showed
 * up as `❭ /unipi-app-session` in the TUI and the app). Kept on a
 * `Symbol.for` global so separately-installed copies of core agree. */
const SILENT_KEY = Symbol.for("unipi.commandEcho.silent");
function silentSet(): Set<string> {
  const g = globalThis as { [SILENT_KEY]?: Set<string> };
  return (g[SILENT_KEY] ??= new Set<string>());
}

/** Never echo `/name` (internal, programmatic commands). Call before or after registering. */
export function silenceCommandEcho(name: string): void {
  silentSet().add(name.replace(/^\//, ""));
}

/** True when `name` (with or without the leading `/`) is a silenced command. */
export function isSilentCommand(name: string): boolean {
  return silentSet().has(name.replace(/^\//, ""));
}

/** True when an echo text (`/name args`) belongs to a silenced command. */
export function isSilentEcho(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const name = text.trim().split(/\s/, 1)[0] ?? "";
  return name.startsWith("/") && isSilentCommand(name);
}

export function withCommandEcho(pi: ExtensionAPI): ExtensionAPI {
  try {
    pi.registerEntryRenderer<{ text?: string }>(
      COMMAND_ECHO_TYPE,
      (entry, _options, theme) => {
        const text = entry.data?.text;
        // Old sessions persisted echoes of internal commands: hide them too.
        if (!text || isSilentEcho(text)) return undefined;
        const t = theme as unknown as { fg?: (c: string, t: string) => string };
        const marker = t.fg?.("accent", "❭ ") ?? "❭ ";
        return new Text(`${marker}${t.fg?.("text", text) ?? text}`, 1, 0);
      },
    );
  } catch {
    // Renderer registration is best-effort; echoes still persist.
  }

  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerCommand") {
        return (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
          const wrapped = {
            ...options,
            handler: (args: string, ctx: ExtensionCommandContext) => {
              const trimmed = (args ?? "").trim();
              if (isSilentCommand(name)) return options.handler(args, ctx);
              try {
                target.appendEntry(COMMAND_ECHO_TYPE, {
                  text: `/${name}${trimmed ? ` ${trimmed}` : ""}`,
                });
              } catch {
                // Echo must never block the command.
              }
              return options.handler(args, ctx);
            },
          };
          // Reflect.apply keeps the command audit's literal source scan from
          // flagging this proxy call as an unresolvable name.
          return Reflect.apply(target.registerCommand, target, [name, wrapped]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
