/**
 * @pi-unipi/utility — Settings Inspector
 *
 * Reusable settings inspector overlay pattern.
 * Split-pane layout: list left, editor right.
 * Search/filter, keyboard navigation, JSON editing.
 *
 * Note: This is a data model and rendering helper. The actual TUI
 * rendering depends on the host environment (pi's TUI API).
 */

import type {
  SettingSchema,
  SettingsInspectorState,
} from "../types.js";

/** Navigation actions */
export type InspectorAction =
  | { type: "navigate"; direction: "up" | "down" | "first" | "last" }
  | { type: "search"; query: string }
  | { type: "select"; index: number }
  | { type: "edit"; value: unknown }
  | { type: "toggle_edit" }
  | { type: "save" }
  | { type: "cancel" };

/** Result of applying an action */
export interface InspectorUpdate {
  state: SettingsInspectorState;
  changed: boolean;
  saved: boolean;
}

/** Create initial inspector state */
export function createSettingsInspector(
  schemas: SettingSchema[],
  initialValues?: Record<string, unknown>,
): SettingsInspectorState {
  const values: Record<string, unknown> = {};
  for (const schema of schemas) {
    values[schema.key] = initialValues?.[schema.key] ?? schema.default;
  }

  return {
    schemas,
    values,
    selectedIndex: 0,
    searchQuery: "",
    editMode: false,
  };
}

/** Get filtered schemas based on search query */
export function getFilteredSchemas(
  state: SettingsInspectorState,
): SettingSchema[] {
  if (!state.searchQuery.trim()) {
    return state.schemas;
  }

  const query = state.searchQuery.toLowerCase();
  return state.schemas.filter(
    (s) =>
      s.key.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query),
  );
}

/** Get the currently selected schema */
export function getSelectedSchema(
  state: SettingsInspectorState,
): SettingSchema | undefined {
  const filtered = getFilteredSchemas(state);
  return filtered[state.selectedIndex];
}

/** Get current value for a key */
export function getValue(
  state: SettingsInspectorState,
  key: string,
): unknown {
  return state.values[key];
}

/** Apply an action to the inspector state */
export function applyAction(
  state: SettingsInspectorState,
  action: InspectorAction,
): InspectorUpdate {
  const newState: SettingsInspectorState = {
    ...state,
    values: { ...state.values },
  };
  let changed = false;
  let saved = false;

  const filtered = getFilteredSchemas(newState);

  switch (action.type) {
    case "navigate": {
      const maxIndex = Math.max(0, filtered.length - 1);
      switch (action.direction) {
        case "up":
          newState.selectedIndex = Math.max(0, newState.selectedIndex - 1);
          break;
        case "down":
          newState.selectedIndex = Math.min(maxIndex, newState.selectedIndex + 1);
          break;
        case "first":
          newState.selectedIndex = 0;
          break;
        case "last":
          newState.selectedIndex = maxIndex;
          break;
      }
      changed = newState.selectedIndex !== state.selectedIndex;
      break;
    }

    case "search": {
      newState.searchQuery = action.query;
      newState.selectedIndex = 0;
      changed = true;
      break;
    }

    case "select": {
      const maxIndex = Math.max(0, filtered.length - 1);
      newState.selectedIndex = Math.max(0, Math.min(maxIndex, action.index));
      changed = newState.selectedIndex !== state.selectedIndex;
      break;
    }

    case "edit": {
      const selected = getSelectedSchema(newState);
      if (selected) {
        newState.values[selected.key] = action.value;
        changed = true;
      }
      break;
    }

    case "toggle_edit": {
      newState.editMode = !newState.editMode;
      changed = true;
      break;
    }

    case "save": {
      saved = true;
      changed = true;
      break;
    }

    case "cancel": {
      newState.editMode = false;
      changed = true;
      break;
    }
  }

  return { state: newState, changed, saved };
}

/** Validate a value against its schema */
export function validateValue(
  schema: SettingSchema,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) {
    if (schema.required) {
      return `Required field: ${schema.key}`;
    }
    return undefined;
  }

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return `Expected string for ${schema.key}`;
      }
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `Expected number for ${schema.key}`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return `Expected boolean for ${schema.key}`;
      }
      break;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) {
        return `Expected object for ${schema.key}`;
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        return `Expected array for ${schema.key}`;
      }
      break;
  }

  return undefined;
}

/** Validate all values against schemas */
export function validateAll(
  state: SettingsInspectorState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const schema of state.schemas) {
    const error = validateValue(schema, state.values[schema.key]);
    if (error) {
      errors[schema.key] = error;
    }
  }
  return errors;
}

/** Export state values as JSON */
export function exportToJSON(state: SettingsInspectorState): string {
  return JSON.stringify(state.values, null, 2);
}

/** Import values from JSON string */
export function importFromJSON(
  state: SettingsInspectorState,
  json: string,
): { state: SettingsInspectorState; errors: Record<string, string> } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      state,
      errors: { _parse: `Invalid JSON: ${(err as Error).message}` },
    };
  }

  const newState: SettingsInspectorState = {
    ...state,
    values: { ...state.values },
  };

  const errors: Record<string, string> = {};
  for (const schema of state.schemas) {
    if (parsed[schema.key] !== undefined) {
      const error = validateValue(schema, parsed[schema.key]);
      if (error) {
        errors[schema.key] = error;
      } else {
        newState.values[schema.key] = parsed[schema.key];
      }
    }
  }

  return { state: newState, errors };
}

/** Format a setting for display */
export function formatSetting(
  schema: SettingSchema,
  value: unknown,
): string {
  const displayValue = value === undefined ? "(unset)" : JSON.stringify(value);
  const requiredMark = schema.required ? "*" : "";
  return `${schema.key}${requiredMark}: ${displayValue}\n  ${schema.description}`;
}

/** Render the inspector as markdown (for non-TUI environments) */
export function renderAsMarkdown(
  state: SettingsInspectorState,
): string {
  const filtered = getFilteredSchemas(state);
  const lines = [
    "## ⚙️ Settings",
    "",
    state.searchQuery ? `*Filter: "${state.searchQuery}"*` : "",
    "",
  ];

  for (let i = 0; i < filtered.length; i++) {
    const schema = filtered[i];
    const value = state.values[schema.key];
    const selected = i === state.selectedIndex ? "> " : "  ";
    const required = schema.required ? " **(required)**" : "";

    lines.push(
      `${selected}**${schema.key}**${required} \`${schema.type}\``,
      `    ${schema.description}`,
      `    Value: \`${JSON.stringify(value)}\``,
      "",
    );
  }

  if (filtered.length === 0) {
    lines.push("*No settings match your search.*");
  }

  return lines.join("\n");
}
