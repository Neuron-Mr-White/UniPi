/**
 * Dialogs answerable from the phone. pi hands every extension the SAME
 * `ctx.ui` object (runner.uiContext), so wrapping its select / confirm /
 * input / editor once makes every extension's dialog visible to the phone.
 * The TUI dialog and the phone race; the first answer wins and the other
 * side is closed (TUI: through the dialog's AbortSignal; phone: dialog_end).
 *
 * ask_user (a custom TUI component) registers through `openRemoteDialog`
 * via the process-global hook in @pi-unipi/core (`remoteDialogs()`).
 */
import type { Dialog, DialogKind } from "./wire.js";

export interface DialogSink {
  open(dialog: Dialog): void;
  close(id: number, by: "tui" | "phone" | "cancel"): void;
}

interface Pending {
  dialog: Dialog;
  answer: (value: unknown) => void;
}

export class DialogHub {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly sink: DialogSink) {}

  list(): Dialog[] {
    return [...this.pending.values()].map((p) => p.dialog);
  }

  /** Phone answer. Returns false when the dialog is gone (already answered). */
  answer(id: number, value: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.answer(value);
    return true;
  }

  /** Close every open dialog as cancelled (session switch / shutdown). */
  cancelAll(): void {
    for (const p of [...this.pending.values()]) p.answer(null);
  }

  /**
   * Race `runTui(signal)` against a phone answer. `fromPhone` turns the phone's
   * JSON value into the dialog's result type (null = dismissed → `dismissed`).
   */
  race<T>(
    spec: Omit<Dialog, "id">,
    runTui: (signal: AbortSignal) => Promise<T>,
    fromPhone: (value: unknown) => T,
    outer?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++;
    const dialog: Dialog = { id, ...spec };
    const abort = new AbortController();
    const onOuter = () => abort.abort();
    outer?.addEventListener("abort", onOuter, { once: true });
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (by: "tui" | "phone" | "cancel", result: { ok: true; value: T } | { ok: false; error: unknown }) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        outer?.removeEventListener("abort", onOuter);
        if (by !== "tui") abort.abort();
        this.sink.close(id, by);
        if (result.ok) resolve(result.value);
        else reject(result.error);
      };
      this.pending.set(id, {
        dialog,
        answer: (value) => {
          let mapped: T;
          try {
            mapped = fromPhone(value);
          } catch (error) {
            finish("phone", { ok: false, error });
            return;
          }
          finish(value === null ? "cancel" : "phone", { ok: true, value: mapped });
        },
      });
      this.sink.open(dialog);
      let run: Promise<T>;
      try {
        run = runTui(abort.signal);
      } catch (error) {
        finish("tui", { ok: false, error });
        return;
      }
      run.then(
        (value) => finish("tui", { ok: true, value }),
        (error) => finish("tui", { ok: false, error }),
      );
    });
  }
}

type AnyFn = (...args: any[]) => any;
interface DialogOpts {
  signal?: AbortSignal;
  timeout?: number;
}

const WRAPPED = Symbol.for("unipi.app-bridge.ui-wrapped");

/**
 * Wraps a pi ui context in place (idempotent per object). `onNotify` also
 * gets every `ui.notify` (the phone shows them: a command's "needs an
 * argument" warning would otherwise only reach the terminal).
 */
export function wrapUi(ui: object, hub: DialogHub, onNotify?: (text: string, level: string) => void): void {
  const u = ui as Record<string | symbol, unknown>;
  if (u[WRAPPED]) return;
  u[WRAPPED] = true;
  const notify = u.notify as AnyFn | undefined;
  if (notify && onNotify) {
    u.notify = (message: unknown, type?: unknown) => {
      try {
        onNotify(String(message ?? ""), typeof type === "string" ? type : "info");
      } catch {
        // the phone never breaks the TUI
      }
      return notify.call(ui, message, type);
    };
  }
  const select = u.select as AnyFn | undefined;
  const confirm = u.confirm as AnyFn | undefined;
  const input = u.input as AnyFn | undefined;
  const editor = u.editor as AnyFn | undefined;
  const deadline = (opts?: DialogOpts) => (opts?.timeout ? Date.now() + opts.timeout : undefined);
  const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

  if (select) {
    u.select = (title: string, options: string[], opts?: DialogOpts) =>
      hub.race<string | undefined>(
        { kind: "select" as DialogKind, title, options: [...options], deadline: deadline(opts) },
        (signal) => select.call(ui, title, options, { ...opts, signal }),
        (v) => {
          const s = str(v);
          return s !== undefined && options.includes(s) ? s : undefined;
        },
        opts?.signal,
      );
  }
  if (confirm) {
    u.confirm = (title: string, message: string, opts?: DialogOpts) =>
      hub.race<boolean>(
        { kind: "confirm", title, message, deadline: deadline(opts) },
        (signal) => confirm.call(ui, title, message, { ...opts, signal }),
        (v) => v === true,
        opts?.signal,
      );
  }
  if (input) {
    u.input = (title: string, placeholder?: string, opts?: DialogOpts) =>
      hub.race<string | undefined>(
        { kind: "input", title, placeholder, deadline: deadline(opts) },
        (signal) => input.call(ui, title, placeholder, { ...opts, signal }),
        str,
        opts?.signal,
      );
  }
  if (editor) {
    // editor() takes no signal: a phone answer can't close the TUI editor,
    // so it stays open (the user closes it); the phone's text still wins.
    u.editor = (title: string, prefill?: string) =>
      hub.race<string | undefined>(
        { kind: "editor", title, prefill },
        () => editor.call(ui, title, prefill),
        str,
      );
  }
}
