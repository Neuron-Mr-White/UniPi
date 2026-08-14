import type { InfoRegistryLike } from "@pi-unipi/core/global-types";

declare global {
  var __unipi_info_registry: InfoRegistryLike | undefined;
}

export {};
