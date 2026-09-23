/**
 * @pi-unipi/footer — top-frame PLAN / permission badges.
 *
 * The cluster sits right-aligned before the top-right corner. Narrow terminals
 * drop the permission label first, then the line is truncated, so the frame
 * never overflows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  planTopFrameWidths,
  renderTopRightBadges,
  renderTopRightBadgesNoPermission,
} from "../src/glance-editor.js";

/** Visible width of the composed top line (corners + rule + title + cluster). */
function topLineWidth(safe: number, plainLead: number, cluster: string, filler: number): number {
  return 2 + plainLead + filler + visibleWidth(cluster);
}

describe("top-right badges", () => {
  it("renders nothing when plan mode is off and no permission mode is known", () => {
    assert.equal(renderTopRightBadges(false, null), "");
  });

  it("renders just the permission mode", () => {
    const cluster = renderTopRightBadges(false, "auto");
    assert.match(cluster, /auto/);
    assert.equal(cluster.includes("PLAN"), false);
  });

  it("renders PLAN with the permission mode", () => {
    const cluster = renderTopRightBadges(true, "full");
    assert.match(cluster, /PLAN/);
    assert.match(cluster, /full/);
    assert.ok(cluster.startsWith("\x1b[1m"), "PLAN badge is bold");
  });

  it("the no-permission fallback keeps only PLAN", () => {
    const cluster = renderTopRightBadgesNoPermission(true);
    assert.match(cluster, /PLAN/);
    assert.equal(cluster.includes("auto"), false);
  });
});

describe("top frame width fit", () => {
  const plainLead = visibleWidth("─  UNIPI │ feature/x │");

  for (const safe of [60, 100, 200]) {
    it(`fits exactly at ${safe} columns with PLAN + permission`, () => {
      const { cluster, filler, permissionDropped } = planTopFrameWidths(safe, plainLead, true, "auto");
      assert.equal(permissionDropped, false, "wide enough for both badges");
      assert.equal(topLineWidth(safe, plainLead, cluster, filler), safe);
      assert.ok(filler >= 2);
    });
  }

  it("drops the permission label before overflowing at 60 columns with a long mode name", () => {
    const { cluster, filler, permissionDropped } = planTopFrameWidths(
      60,
      visibleWidth("─  UNIPI │ a-very-long-branch-name-here │"),
      true,
      "full",
    );
    if (permissionDropped) {
      assert.equal(cluster.includes("full"), false);
      assert.match(cluster, /PLAN/);
    }
    assert.equal(topLineWidth(60, visibleWidth("─  UNIPI │ a-very-long-branch-name-here │"), cluster, filler), 60);
  });

  it("keeps the ledger non-negative at absurdly narrow widths", () => {
    for (const safe of [20, 24, 30]) {
      const { cluster, filler } = planTopFrameWidths(safe, plainLead, true, "auto");
      assert.ok(filler >= 2, `filler at ${safe}`);
      assert.ok(topLineWidth(safe, plainLead, cluster, filler) >= safe - 2);
    }
  });

  it("reserves two rule cells even for a bare frame", () => {
    const { cluster, filler } = planTopFrameWidths(40, plainLead, false, null);
    assert.equal(cluster, "");
    assert.equal(filler, 40 - 2 - plainLead);
  });
});
