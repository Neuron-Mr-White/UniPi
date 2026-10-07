/**
 * @unipi/core — remote dialogs (the UniPi phone app).
 *
 * When the app bridge (@pi-unipi/app-bridge) runs, it publishes a racer on
 * globalThis under Symbol.for("unipi.remote-dialogs"). A module with its own
 * TUI dialog (ask_user's panel) passes its TUI run through `raceRemote`: the
 * phone sees the dialog, and the first answer (TUI or phone) wins — the
 * other side is closed. Without the bridge, `raceRemote` just runs the TUI.
 */

export interface RemoteDialogSpec {
  kind: "ask_user" | "select" | "confirm" | "input" | "editor" | "custom";
  title?: string;
  /** ask_user questions, as given to the tool. */
  questions?: unknown[];
}

export interface RemoteDialogRacer {
  race<T>(
    spec: RemoteDialogSpec,
    runTui: (signal: AbortSignal) => Promise<T>,
    fromPhone: (value: unknown) => T,
    outer?: AbortSignal,
  ): Promise<T>;
}

const KEY = Symbol.for("unipi.remote-dialogs");
type Holder = { [KEY]?: RemoteDialogRacer };

export function setRemoteDialogRacer(racer: RemoteDialogRacer | undefined): void {
  (globalThis as Holder)[KEY] = racer;
}

export function remoteDialogRacer(): RemoteDialogRacer | undefined {
  return (globalThis as Holder)[KEY];
}

/**
 * Run a TUI dialog, racing a phone answer when the app bridge is active.
 * `runTui` receives a signal that aborts when the phone answered first — the
 * TUI component must close itself on it.
 */
export function raceRemote<T>(
  spec: RemoteDialogSpec,
  runTui: (signal: AbortSignal) => Promise<T>,
  fromPhone: (value: unknown) => T,
): Promise<T> {
  const racer = remoteDialogRacer();
  if (!racer) return runTui(new AbortController().signal);
  return racer.race(spec, runTui, fromPhone);
}
