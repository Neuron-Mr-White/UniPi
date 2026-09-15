import type { PickerModel } from "./picker.js";
import type { SidekickUsage } from "./sidekick-runtime.js";

export function estimateSavings(
  usage: SidekickUsage,
  lead: PickerModel["cost"],
  side: PickerModel["cost"],
): { sidekickUsd: number; atLeadUsd: number; savedUsd: number } {
  const sidekickUsd = priceUsage(usage, side);
  const atLeadUsd = priceUsage(usage, lead);
  return { sidekickUsd, atLeadUsd, savedUsd: atLeadUsd - sidekickUsd };
}

function priceUsage(usage: SidekickUsage, cost: PickerModel["cost"]): number {
  if (!cost) return usage.cost;
  return (
    usage.input * cost.input +
    usage.cacheRead * cost.cachedInput +
    usage.cacheWrite * cost.input +
    usage.output * cost.output
  ) / 1_000_000;
}
