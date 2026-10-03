import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_USER_TOOLS } from "@pi-unipi/core";
import { syncAskUserTool, askRows, renderAskResult, type AskDetails } from "../tools.js";

function fakePi(initial: string[] = ["read", "bash", "edit"]) {
  const calls: string[][] = [];
  let active = [...initial];
  return {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
      calls.push([...tools]);
    },
    active: () => active,
    calls,
  };
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("disabled removes ask_user and leaves other tools", () => {
  const pi = fakePi(["read", "bash", ASK_USER_TOOLS.ASK, "edit"]);
  syncAskUserTool(pi as never, false);
  assert.deepEqual(pi.active(), ["read", "bash", "edit"]);
  assert.equal(pi.calls.length, 1);
});

test("enabled adds ask_user", () => {
  const pi = fakePi(["read", "bash"]);
  syncAskUserTool(pi as never, true);
  assert.deepEqual(pi.active(), ["read", "bash", ASK_USER_TOOLS.ASK]);
  assert.equal(pi.calls.length, 1);
});

test("no setActiveTools call when already in desired state", () => {
  const piDisabled = fakePi(["read", "bash"]);
  syncAskUserTool(piDisabled as never, false);
  assert.equal(piDisabled.calls.length, 0);

  const piEnabled = fakePi(["read", ASK_USER_TOOLS.ASK, "bash"]);
  syncAskUserTool(piEnabled as never, true);
  assert.equal(piEnabled.calls.length, 0);
});

test("askRows renders specific reason text", () => {
  const dummyQuestion = { question: "Q1", header: "Q1", options: [] };

  const disabledDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
    reason: "disabled",
  };
  const disabledRows = askRows(disabledDetails, fakeTheme as never);
  assert.equal(disabledRows.length, 1);
  assert.ok(
    disabledRows[0]!.includes("not shown — ask_user is turned off in settings"),
    `expected disabled text, got: ${disabledRows[0]}`,
  );

  const noUiDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
    reason: "no-ui",
  };
  const noUiRows = askRows(noUiDetails, fakeTheme as never);
  assert.equal(noUiRows.length, 1);
  assert.ok(
    noUiRows[0]!.includes("not shown — no interactive UI"),
    `expected no-ui text, got: ${noUiRows[0]}`,
  );

  const fallbackDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
  };
  const fallbackRows = askRows(fallbackDetails, fakeTheme as never);
  assert.equal(fallbackRows.length, 1);
  assert.ok(
    fallbackRows[0]!.includes("not shown (no interactive UI or turned off)"),
    `expected fallback text, got: ${fallbackRows[0]}`,
  );
});

test("renderAskResult renders specific reason text", () => {
  const dummyQuestion = { question: "Q1", header: "Q1", options: [] };

  const disabledDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
    reason: "disabled",
  };
  const disabledRender = renderAskResult(disabledDetails, fakeTheme as never);
  const disabledText = disabledRender.render(80).join("\n");
  assert.ok(
    disabledText.includes("not shown — ask_user is turned off in settings"),
    `expected disabled text, got: ${disabledText}`,
  );

  const noUiDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
    reason: "no-ui",
  };
  const noUiRender = renderAskResult(noUiDetails, fakeTheme as never);
  const noUiText = noUiRender.render(80).join("\n");
  assert.ok(
    noUiText.includes("not shown — no interactive UI"),
    `expected no-ui text, got: ${noUiText}`,
  );

  const fallbackDetails: AskDetails = {
    questions: [dummyQuestion],
    outcome: "unavailable",
  };
  const fallbackRender = renderAskResult(fallbackDetails, fakeTheme as never);
  const fallbackText = fallbackRender.render(80).join("\n");
  assert.ok(
    fallbackText.includes("not shown (no interactive UI or turned off)"),
    `expected fallback text, got: ${fallbackText}`,
  );
});
