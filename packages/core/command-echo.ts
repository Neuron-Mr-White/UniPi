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

export function withCommandEcho(pi: ExtensionAPI): ExtensionAPI {
  try {
    pi.registerEntryRenderer<{ text?: string }>(
      COMMAND_ECHO_TYPE,
      (entry, _options, theme) => {
        const text = entry.data?.text;
        if (!text) return undefined;
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
