/**
 * @pi-unipi/utility — /unipi:answer: questions in, answers out (pure)
 *
 * Pulls the questions out of the agent's last reply (any line with a "?"
 * outside code blocks, list/heading markers stripped), builds a Q/A template,
 * parses it back, and composes one user message that quotes each question.
 */

export const MAX_QUESTIONS = 20;

/** Plain text of an assistant message's content. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}

function clean(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractQuestions(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.includes("?")) continue;
    if (/https?:\/\/\S*\?/.test(raw) && !/\?\s*$/.test(raw.replace(/https?:\/\/\S+/g, ""))) continue;
    const q = clean(raw);
    if (q.length < 4 || out.includes(q)) continue;
    out.push(q.length > 400 ? `${q.slice(0, 399)}…` : q);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

/** Q/A pairs, nothing else in the buffer; no questions → an empty buffer. */
export function buildTemplate(questions: readonly string[]): string {
  if (questions.length === 0) return "";
  return questions.flatMap((q, i) => [`Q${i + 1}. ${q}`, `A${i + 1}: `, ""]).join("\n").trimEnd() + " ";
}

/** Answers by question index (0-based); missing/empty → "". */
export function parseTemplate(text: string, count: number): string[] {
  if (count === 0) return [text.trim()];
  const answers: string[] = Array.from({ length: count }, () => "");
  let current = -1;
  const buf: string[][] = answers.map(() => []);
  for (const line of text.split("\n")) {
    if (/^Q\d+\.\s/.test(line)) {
      current = -1;
      continue;
    }
    const a = line.match(/^A(\d+):\s?(.*)$/);
    if (a) {
      const idx = Number(a[1]) - 1;
      current = idx >= 0 && idx < buf.length ? idx : -1;
      if (current >= 0) buf[current]!.push(a[2]!);
      continue;
    }
    if (current >= 0) buf[current]!.push(line);
  }
  return buf.map((lines) => lines.join("\n").trim());
}

/** One user message; undefined when nothing was answered. */
export function composeAnswers(questions: readonly string[], answers: readonly string[], note = ""): string | undefined {
  const parts: string[] = [];
  const skipped: number[] = [];
  if (questions.length === 0) {
    const text = [answers[0] ?? "", note].map((s) => s.trim()).filter(Boolean).join("\n\n");
    return text || undefined;
  }
  questions.forEach((q, i) => {
    const a = (answers[i] ?? "").trim();
    if (!a) {
      skipped.push(i + 1);
      return;
    }
    parts.push(`${i + 1}. > ${q}\n\n${a}`);
  });
  if (parts.length === 0 && !note.trim()) return undefined;
  const lines = [parts.join("\n\n")];
  if (note.trim()) lines.push(note.trim());
  if (skipped.length) lines.push(`(Not answered: ${skipped.map((n) => `#${n}`).join(", ")})`);
  return lines.filter(Boolean).join("\n\n");
}
