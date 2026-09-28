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

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Questions in a reply. Lines are first joined into paragraphs (a question
 * that wraps over several source lines stays whole), list items and headings
 * each start their own paragraph, code blocks are skipped, and every sentence
 * ending in "?" becomes one question — in full, never truncated.
 */
export function extractQuestions(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!raw.trim()) {
      flush();
      continue;
    }
    // A new list item / heading / quote starts a new paragraph.
    if (/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/.test(raw)) flush();
    current.push(raw);
  }
  flush();

  const out: string[] = [];
  for (const para of paragraphs) {
    const clean = cleanLine(para);
    if (!clean.includes("?")) continue;
    // A "?" inside a URL (query string) is not a question: park URLs as tokens.
    const urls: string[] = [];
    const masked = clean.replace(/https?:\/\/\S+/g, (u) => `\u0000${urls.push(u) - 1}\u0000`);
    if (!masked.includes("?")) continue;
    for (const sentence of masked.match(/[^.!?]*(?:[.!](?!\s|$)[^.!?]*)*\?+/g) ?? []) {
      const q = sentence.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "").trim();
      if (q.length < 4 || out.includes(q)) continue;
      out.push(q);
      if (out.length >= MAX_QUESTIONS) return out;
    }
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
