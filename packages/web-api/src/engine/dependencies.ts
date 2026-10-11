/**
 * @unipi/web-api — Runtime Dependencies
 *
 * wreq-js ships a native (Rust) binding. On Windows it needs the Visual C++
 * 2015-2022 runtime (vcruntime140.dll); without it the binding throws at
 * import time ("Failed to load native module for win32-x64-msvc"). A static
 * import here once took the WHOLE UniPi bundle down with it (UNI-261), so
 * wreq-js is loaded lazily on first fetch and, when it cannot load, the engine
 * falls back to Node's built-in fetch (no TLS fingerprinting, no proxy).
 *
 * defuddle is pure JS and stays a static import.
 */

import * as defuddle from "defuddle";

/** The subset of a fetch Response the extraction engine uses. */
export interface EngineResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The subset of wreq-js the engine uses. */
export interface WreqLike {
  fetch(
    url: string,
    init: {
      browser?: string;
      os?: string;
      timeout?: number;
      proxy?: string;
      headers?: Record<string, string>;
    },
  ): Promise<EngineResponse>;
}

/** How the smart-fetch engine is currently fetching. */
export interface WreqStatus {
  /** "wreq" = native TLS-fingerprinting client; "fallback" = plain fetch. */
  mode: "wreq" | "fallback" | "unloaded";
  /** Why wreq-js failed to load (fallback mode only). */
  error?: string;
}

/** Fix hint shown when the native binding is missing its runtime. */
export function wreqFixHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "Install the Microsoft Visual C++ 2015-2022 runtime: `winget install Microsoft.VCRedist.2015+.x64` (or https://aka.ms/vs/17/release/vc_redist.x64.exe), then restart pi."
    : "Reinstall UniPi (`pi update`) so wreq-js' native binding for this platform is present.";
}

type Loader = () => Promise<unknown>;

const defaultLoader: Loader = () => {
  // Non-literal specifier keeps bundlers from hoisting it into a static import.
  const specifier = "wreq-js";
  return import(/* @vite-ignore */ specifier);
};

let loader: Loader = defaultLoader;
let loading: Promise<WreqLike> | null = null;
let status: WreqStatus = { mode: "unloaded" };

/** Test seam: replace how wreq-js is imported. Pass null to restore. */
export function setWreqLoaderForTests(next: Loader | null): void {
  loader = next ?? defaultLoader;
  loading = null;
  status = { mode: "unloaded" };
}

/** Plain-fetch stand-in with wreq's call shape. Browser/OS profiles and proxy are ignored. */
export const fallbackFetcher: WreqLike = {
  async fetch(url, init) {
    const signal = init.timeout && init.timeout > 0 ? AbortSignal.timeout(init.timeout) : undefined;
    try {
      return await fetch(url, { headers: init.headers, signal, redirect: "follow" });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`timeout after ${init.timeout}ms`);
      }
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      throw new Error(`network error: ${cause?.code ?? cause?.message ?? e?.message ?? String(err)}`);
    }
  },
};

/**
 * Get the wreq-js module, loading it on first use. Never throws: if the native
 * binding cannot load, returns the plain-fetch fallback and records why.
 */
export function getWreq(): Promise<WreqLike> {
  if (!loading) {
    loading = loader().then(
      (mod) => {
        const m = mod as { fetch?: unknown; default?: { fetch?: unknown } };
        const impl = (typeof m.fetch === "function" ? m : m.default) as WreqLike | undefined;
        if (!impl || typeof impl.fetch !== "function") throw new Error("wreq-js has no fetch export");
        status = { mode: "wreq" };
        return impl;
      },
    ).catch((err: unknown) => {
      status = { mode: "fallback", error: (err as Error)?.message ?? String(err) };
      return fallbackFetcher;
    });
  }
  return loading;
}

/** Current engine status (does not trigger a load). */
export function wreqStatus(): WreqStatus {
  return status;
}

/** Get the defuddle module. */
export function getDefuddle(): any {
  return defuddle;
}

/** Check whether the smart-fetch engine is at full strength (loads wreq-js if needed). */
export async function checkDependencies(): Promise<{ available: boolean; missing: string[]; note?: string }> {
  await getWreq();
  if (status.mode === "wreq") return { available: true, missing: [] };
  return {
    available: false,
    missing: ["wreq-js (native)"],
    note: `plain-fetch fallback active (${status.error ?? "load failed"}). ${wreqFixHint()}`,
  };
}
