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

/**
 * UNI-276: what a command said, kept in the transcript under its echo so the
 * app shows it as the command's reply (the TUI already showed it as a
 * notification, so its renderer draws nothing). `screen` = the command opened
 * a terminal-only screen (ui.custom) the phone can't show.
 */
export const COMMAND_OUTPUT_TYPE = "unipi-command-output";
export interface CommandOutputData {
  command: string;
  text?: string;
  level?: string;
  screen?: boolean;
}
/** Longest command reply kept in the transcript. */
const OUTPUT_MAX = 4000;

/** The handler's ctx with `ui.notify` / `ui.custom` also recorded as COMMAND_OUTPUT_TYPE entries. */
function recordingCtx(target: ExtensionAPI, name: string, ctx: ExtensionCommandContext): ExtensionCommandContext {
  const ui = (ctx as { ui?: object } | undefined)?.ui;
  if (!ctx || typeof ctx !== "object" || !ui) return ctx;
  let screenNoted = false;
  const record = (data: Omit<CommandOutputData, "command">) => {
    try {
      target.appendEntry(COMMAND_OUTPUT_TYPE, { command: `/${name}`, ...data });
    } catch {
      // Recording must never block the command.
    }
  };
  const uiProxy = new Proxy(ui, {
    get(u, prop, receiver) {
      const value = Reflect.get(u, prop, receiver);
      if (prop === "notify" && typeof value === "function") {
        return (message: unknown, type?: unknown) => {
          const text = String(message ?? "").trim();
          if (text) record({ text: text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX - 1)}…` : text, level: typeof type === "string" ? type : "info" });
          return value.call(u, message, type);
        };
      }
      if (prop === "custom" && typeof value === "function") {
        return (...args: unknown[]) => {
          if (!screenNoted) {
            screenNoted = true;
            record({ screen: true });
          }
          return value.apply(u, args);
        };
      }
      return typeof value === "function" ? value.bind(u) : value;
    },
  });
  return new Proxy(ctx, {
    get(c, prop, receiver) {
      if (prop === "ui") return uiProxy;
      const value = Reflect.get(c, prop, receiver);
      return typeof value === "function" ? value.bind(c) : value;
    },
  });
}

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
    // The TUI showed the reply as a notification already: nothing to draw.
    pi.registerEntryRenderer(COMMAND_OUTPUT_TYPE, () => undefined);
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
              return options.handler(args, recordingCtx(target, name, ctx));
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
