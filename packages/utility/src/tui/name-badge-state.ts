/**
 * @pi-unipi/utility — Name Badge State Manager
 *
 * Manages the name badge overlay lifecycle:
 * - Toggle visibility (persisted via pi.appendEntry)
 * - Poll for session name changes every 1s
 * - Restore visibility on session start
 * - Generate session name via hidden LLM prompt
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { NameBadgeComponent } from "./name-badge.js";

/** Overlay handle from ctx.ui.custom() */
interface OverlayHandle {
  requestRender?: () => void;
  hide?: () => void;
  setHidden?: (hidden: boolean) => void;
  isHidden?: () => boolean;
  focus?: () => void;
  unfocus?: () => void;
  isFocused?: () => boolean;
}

/** Persisted badge state */
interface BadgePersistedState {
  visible: boolean;
}

/** Entry type for persistence */
const BADGE_ENTRY_TYPE = "name-badge";

/** Polling interval in ms */
const POLL_INTERVAL_MS = 1000;

/** Name generation timeout in ms */
const GEN_TIMEOUT_MS = 30_000;

/**
 * NameBadgeState — manages the name badge overlay.
 *
 * Usage:
 *   const state = new NameBadgeState();
 *   // In session_start: state.restore(pi, ctx);
 *   // In session_shutdown: state.hide();
 *   // Commands: state.toggle(pi, ctx), state.generate(pi, ctx);
 */
export class NameBadgeState {
  private visible = false;
  private currentName: string | null = null;
  private overlayHandle: OverlayHandle | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private component: NameBadgeComponent | null = null;
  private genTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Whether the badge is currently visible */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Toggle badge visibility.
   * If hidden → show + start polling.
   * If visible → hide + stop polling.
   */
  async toggle(
    pi: ExtensionAPI,
    ctx: { hasUI: boolean; ui: any; cwd?: string },
  ): Promise<boolean> {
    if (this.visible) {
      this.hide();
      this.persist(pi, false);
      return false;
    } else {
      await this.show(pi, ctx);
      this.persist(pi, true);
      return true;
    }
  }

  /**
   * Show the badge overlay and start polling.
   */
  async show(
    pi: ExtensionAPI,
    ctx: { hasUI: boolean; ui: any; cwd?: string },
  ): Promise<void> {
    if (this.overlayHandle) return; // Already showing

    const name = this.safeGetName(pi);
    this.currentName = name;
    this.visible = true;

    // Store tui reference for requestRender wiring
    let tuiRef: any = null;

    ctx.ui.custom(
      (tui: any, theme: any, _keybindings: any, _done: any) => {
        tuiRef = tui;
        const component = new NameBadgeComponent(name);
        component.setTheme(theme);
        this.component = component;

        return {
          render: (w: number) => component.render(w),
          invalidate: () => component.invalidate(),
          // No handleInput — display-only overlay
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          offsetX: -1,
          offsetY: 1,
          minWidth: 20,
          nonCapturing: true,
          visible: (termWidth: number) => termWidth >= 40,
        },
        onHandle: (handle: OverlayHandle) => {
          this.overlayHandle = handle;
          // Wire requestRender now that handle exists
          if (tuiRef) {
            (this.overlayHandle as any).requestRender = () => tuiRef.requestRender();
          }
        },
      },
    );

    this.startPolling(pi);
  }

  /**
   * Hide the badge overlay and stop polling.
   */
  hide(): void {
    this.stopPolling();
    this.clearGenTimeout();

    if (this.overlayHandle) {
      try {
        // Use hide() to permanently remove the overlay
        if (typeof this.overlayHandle.hide === "function") {
          this.overlayHandle.hide();
        } else if (typeof this.overlayHandle.setHidden === "function") {
          this.overlayHandle.setHidden(true);
        }
      } catch {
        // Handle may already be invalid
      }
      this.overlayHandle = null;
    }

    this.component = null;
    this.visible = false;
    this.currentName = null;
  }

  /**
   * Restore badge visibility from persisted state.
   * Call on session_start.
   */
  async restore(
    pi: ExtensionAPI,
    ctx: { hasUI: boolean; ui: any; cwd?: string },
  ): Promise<void> {
    try {
      const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];
      const badgeEntry = entries.findLast(
        (e: any) => e.type === "custom" && e.customType === BADGE_ENTRY_TYPE,
      );

      if (badgeEntry?.data?.visible) {
        await this.show(pi, ctx);
      }
    } catch {
      // If we can't read entries, just don't restore
    }
  }

  /**
   * Generate a session name via LLM and enable the badge.
   * Sends a hidden message instructing the LLM to call set_session_name.
   */
  async generate(
    pi: ExtensionAPI,
    ctx: { hasUI: boolean; ui: any; cwd?: string },
  ): Promise<void> {
    // Enable badge if not visible
    if (!this.visible) {
      await this.show(pi, ctx);
      this.persist(pi, true);
    }

    // Clear any previous generation timeout
    this.clearGenTimeout();

    // Send hidden message to LLM
    pi.sendMessage(
      {
        customType: "badge-gen",
        content: [
          "[System Instruction: Analyze this conversation and generate a concise session title.",
          "Call the set_session_name tool with a name that is MAXIMUM 5 WORDS.",
          "The name should capture the main topic or task being worked on.",
          "Do not explain your reasoning. Just call set_session_name.]",
        ].join(" "),
        display: false,
      },
      { triggerTurn: true },
    );

    // Set timeout — if name not set within 30s, give up
    this.genTimeout = setTimeout(() => {
      this.genTimeout = null;
      // If name is still null after timeout, the LLM didn't respond
      if (this.currentName === null) {
        // Badge stays with placeholder — no error needed
      }
    }, GEN_TIMEOUT_MS);
  }

  // ─── Private ────────────────────────────────────────────────────────

  /**
   * Start polling for name changes.
   */
  private startPolling(pi: ExtensionAPI): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      const name = this.safeGetName(pi);

      // Check if generation timeout should be cleared
      if (name !== null && this.genTimeout) {
        this.clearGenTimeout();
      }

      if (name !== this.currentName) {
        this.currentName = name;
        this.component?.setName(name);
        this.overlayHandle?.requestRender?.();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stop polling.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Clear generation timeout.
   */
  private clearGenTimeout(): void {
    if (this.genTimeout) {
      clearTimeout(this.genTimeout);
      this.genTimeout = null;
    }
  }

  /**
   * Safely get session name, returning null on error.
   */
  private safeGetName(pi: ExtensionAPI): string | null {
    try {
      return pi.getSessionName() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist badge visibility state.
   */
  private persist(pi: ExtensionAPI, visible: boolean): void {
    try {
      pi.appendEntry(BADGE_ENTRY_TYPE, { visible } satisfies BadgePersistedState);
    } catch {
      // Persistence is best-effort
    }
  }
}
