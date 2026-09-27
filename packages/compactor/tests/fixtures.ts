/** Session-branch builders shared by the compactor tests. */

let seq = 0;
const id = () => `e${++seq}`;

export const user = (text: string) => ({ id: id(), type: "message", message: { role: "user", content: text } });

export const assistant = (text: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) => ({
  id: id(),
  type: "message",
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((c, i) => ({ type: "toolCall", id: `tc${seq}-${i}`, name: c.name, arguments: c.arguments })),
    ],
  },
});

export const toolResult = (toolName: string, text: string, isError = false) => ({
  id: id(),
  type: "message",
  message: { role: "toolResult", toolName, toolCallId: `r${seq}`, content: [{ type: "text", text }], isError },
});

export const custom = (customType: string, content: string) => ({ id: id(), type: "custom_message", customType, content, display: false });

export const originMark = (key: string) => ({ id: id(), type: "custom", customType: "compactor-origin", data: { key } });

export const compaction = (summary: string, firstKeptEntryId: string) => ({
  id: id(),
  type: "compaction",
  summary,
  firstKeptEntryId,
  tokensBefore: 100_000,
});

/** A plausible working session: requests, edits, a commit, a failing then passing test. */
export function workingSession(): any[] {
  return [
    user("Build a login page. Keep the existing orange theme, don't add new dependencies."),
    assistant("I'll start with the form.", [{ name: "edit", arguments: { path: "/repo/src/Login.tsx", oldText: "a", newText: "b" } }]),
    toolResult("edit", "ok"),
    assistant("", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResult("bash", "1 failing: login rejects empty password", true),
    assistant("", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResult("bash", "all tests pass"),
    assistant("", [{ name: "bash", arguments: { command: 'git commit -am "feat: login page"' } }]),
    toolResult("bash", "[main abc1234] feat: login page\n 1 file changed, 10 insertions(+)"),
    assistant(
      "The login page is done: the form validates input, the tests pass, and the change is committed as abc1234. " +
        "It uses the existing orange theme and adds no dependencies. Next I would add a password reset link, which " +
        "needs a decision on whether reset emails come from the existing mailer or a new service. ".repeat(3),
    ),
    user("Continue"),
    user("Now add a password reset link."),
    assistant("Adding the reset link next.", [{ name: "read", arguments: { path: "/repo/src/Login.tsx" } }]),
    toolResult("read", "export function Login() {}"),
  ];
}
