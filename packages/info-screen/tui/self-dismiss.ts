/**
 * Stack-safe timed self-dismiss for a non-capturing overlay.
 *
 * pi's `done()` pops the TOPMOST overlay, not the caller's. A timer that
 * fires while something else is stacked on top would close that other
 * overlay and strand this one (see memory
 * info_screen_update_overlay_stuck_starting_screen_fix). So:
 *   - prefer `selfHide` (handle.hide() removes THIS entry by identity),
 *     but only while `isTopmostVisible()` — removing a covered entry
 *     retargets focus and orphans the covering overlay's pending input;
 *   - otherwise fall back to `onClose` (done()) only while focused.
 * Either way, when covered the timer re-arms and retries.
 */

export interface SelfDismissHooks {
  selfHide?: () => void;
  isTopmostVisible?: () => boolean;
  isTopmostOverlay?: () => boolean;
  onClose?: () => void;
  isDestroyed: () => boolean;
  destroy: () => void;
}

/** Arm the timer; returns a cancel function. */
export function armSelfDismiss(ms: number, hooks: SelfDismissHooks): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!Number.isFinite(ms) || ms <= 0) return () => {};
  const arm = (): void => {
    timer = setTimeout(() => {
      timer = null;
      if (hooks.isDestroyed()) return;
      if (hooks.selfHide) {
        if (hooks.isTopmostVisible && !hooks.isTopmostVisible()) {
          arm();
          return;
        }
        hooks.selfHide();
        hooks.destroy();
        return;
      }
      if (hooks.isTopmostOverlay && !hooks.isTopmostOverlay()) {
        arm();
        return;
      }
      hooks.destroy();
      hooks.onClose?.();
    }, ms);
    timer.unref?.();
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
