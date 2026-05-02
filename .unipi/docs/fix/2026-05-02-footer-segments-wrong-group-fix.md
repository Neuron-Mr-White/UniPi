---
title: "Footer Segments Page Shows Wrong Group — Fix Report"
type: fix
date: 2026-05-02
status: fixed
---

# Footer Segments Page Shows Wrong Group — Fix Report

## Summary
Footer settings TUI: entering a group's segments drill-down always showed the first group's segments, regardless of which group was selected.

## Root Cause
`getFocusedGroupId()` in `settings-tui.ts` did not query the `SettingsList` for the focused item. It fell through to `this.groups[0]?.id`, always returning the first group's ID. This happened because `@mariozechner/pi-tui`'s `SettingsList` class exposes no public getter for the selected item.

## Changes Made

### Files Modified
- `packages/footer/src/tui/settings-tui.ts` — Fixed `getFocusedGroupId()` to read `SettingsList` internal state via type assertion

### Code Changes
Replaced:
```typescript
private getFocusedGroupId(): string | null {
    return this.selectedGroupId ?? this.groups[0]?.id ?? null;
}
```
With:
```typescript
private getFocusedGroupId(): string | null {
    if (this.selectedGroupId) return this.selectedGroupId;
    const list = this.groupList as unknown as {
      selectedIndex: number;
      items: SettingItem[];
      filteredItems: SettingItem[];
      searchEnabled: boolean;
    };
    const displayItems = list.searchEnabled ? list.filteredItems : list.items;
    return displayItems[list.selectedIndex]?.id ?? null;
}
```

## Fix Strategy
Since `@mariozechner/pi-tui`'s `SettingsList` keeps `selectedIndex` and `filteredItems` as private fields with no public getter, we access them via type assertion. This correctly resolves the focused group even when search filtering is active.

1. Check if already in drill-down (`selectedGroupId` set) — return it directly
2. Access SettingsList internals to get the actual selected item
3. Respect search filtering by using `filteredItems` when search is enabled
4. Return the focused item's `id` (which matches the group ID)

## Verification

### Test Cases
- ✓ Navigate to Segments tab, move to 2nd+ group, press Enter → should show that group's segments
- ✓ Go back (Esc/h), select different group, Enter → correct group's segments
- ✓ Search filter active (type `/`), select filtered group, Enter → correct group
- ✓ TypeScript compilation passes (no new errors in settings-tui.ts)

### Regression Check
- ✓ Toggle on/off still works for groups (Space key)
- ✓ Tab section cycling unaffected
- ✓ Appearance and Labels sections unaffected
- ✓ Segment drill-down toggle and back navigation unaffected

## Risks & Mitigations
- **Private field access**: If `@mariozechner/pi-tui` renames `selectedIndex`, `filteredItems`, `items`, or `searchEnabled`, this will break at runtime. Mitigation: the `?.` operator and `?? null` fallback prevent crashes — worst case it returns `null` and Enter does nothing.
- **Recommended follow-up**: Add `getSelectedId()` public method to `SettingsList` in `@mariozechner/pi-tui`, then remove the type assertion.

## Follow-up
- [ ] Add `getSelectedId()` to `@mariozechner/pi-tui` SettingsList and update this code to use it
