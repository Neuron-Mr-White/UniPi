/**
 * @unipi/core — Global type augmentations
 *
 * Declares `__unipi_*` properties on `globalThis` so packages
 * can access shared registries without `as any` casts.
 */

declare global {
  // eslint-disable-next-line no-var
  var __unipi_info_registry: import("./global-types.js").InfoRegistryLike | undefined;

  // eslint-disable-next-line no-var
  var __unipi_footer_registry: import("./global-types.js").FooterRegistryLike | undefined;

  // eslint-disable-next-line no-var
  var __unipi_kanboard_registry: unknown;

  /** Kanboard's API for other extensions — set by @pi-unipi/kanboard on load. */
  // eslint-disable-next-line no-var
  var __unipi_kanboard_api:
    | {
        captureToBacklog(opts: { cwd: string; text: string }): Promise<
          { ok: true; id: string; attachments: number } | { ok: false; reason: string }
        >;
      }
    | undefined;

  // eslint-disable-next-line no-var
  var __unipi_mcp_stats: import("./global-types.js").McpStatsLike | undefined;
}

// Force this to be treated as a module
export {};
