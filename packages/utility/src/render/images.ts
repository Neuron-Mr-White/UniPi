/**
 * @pi-unipi/utility — image collapse for simple render mode.
 *
 * pi's ToolExecutionComponent appends Image and Spacer children for every
 * "image" content block in updateDisplay(), and its render() for renderShell
 * "self" emits them after the self-rendered rows. In simple mode, tool calls are
 * collapsed to a single line; images should not be shown unless expanded
 * (Ctrl+O).
 */

const INSTALLED = Symbol.for("unipi.simpleImageCollapseInstalled");

interface ImageHostingComponent {
  expanded?: boolean;
  imageComponents?: unknown[];
  imageSpacers?: unknown[];
  removeChild?(child: unknown): void;
  updateDisplay(...args: unknown[]): unknown;
}

export function installSimpleImageCollapse(proto: object, enabled: () => boolean): void {
  const target = proto as ImageHostingComponent & { [INSTALLED]?: boolean };
  if (target[INSTALLED]) return;
  const original = target.updateDisplay;
  if (typeof original !== "function") return;

  target.updateDisplay = function (this: ImageHostingComponent, ...args: unknown[]) {
    const res = original.apply(this, args);
    if (enabled() && !this.expanded) {
      if (Array.isArray(this.imageComponents)) {
        for (const img of this.imageComponents) {
          if (typeof this.removeChild === "function") {
            this.removeChild(img);
          }
        }
        this.imageComponents = [];
      }
      if (Array.isArray(this.imageSpacers)) {
        for (const spacer of this.imageSpacers) {
          if (typeof this.removeChild === "function") {
            this.removeChild(spacer);
          }
        }
        this.imageSpacers = [];
      }
    }
    return res;
  };

  target[INSTALLED] = true;
}
