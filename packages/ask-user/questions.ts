/**
 * @pi-unipi/ask-user — questions: schema shape, legacy conversion, answers (pure)
 *
 * One ask_user call carries 1–4 questions (Devin's ask shape):
 *   { questions: [{ question, header, options: [{ label, description }], multi_select }] }
 * An "Other" free-text choice is always added unless a question sets
 * other: false. Older single-question calls ({ question, context, options,
 * allowMultiple, allowFreeform, timeout }) are converted by `prepareArgs`.
 */

export const MAX_QUESTIONS = 4;
export const HEADER_MAX = 16;

export interface AskOption {
  label: string;
  description?: string;
  /** Returned instead of the label when set. */
  value?: string;
  /** end_turn: stop the agent · new_session: hand off to `prefill`. */
  action?: "end_turn" | "new_session";
  prefill?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multi_select?: boolean;
  /** Offer "Other (type your own)" (default true). */
  other?: boolean;
}

export interface AskParams {
  questions: AskQuestion[];
}

/** What the user did with one question. */
export interface QuestionAnswer {
  /** Chosen option values (single: at most one). */
  selected: string[];
  /** "Other" text (may contain [Image #N] tokens). */
  custom_text?: string;
  skipped: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** A short chip label for a question that came without one. */
export function deriveHeader(question: string, index: number): string {
  const words = question.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(what|which|who|how|should|would|could|does|do|you|your|the|and|for|want|like|prefer)$/i.test(w));
  const pick = words.slice(0, 2).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  return (pick || `Question ${index + 1}`).slice(0, HEADER_MAX);
}

function normalizeOption(raw: unknown): AskOption | null {
  if (typeof raw === "string") return raw.trim() ? { label: raw.trim() } : null;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = str(o.label ?? o.value).trim();
  if (!label) return null;
  const out: AskOption = { label };
  if (str(o.description).trim()) out.description = str(o.description).trim();
  if (str(o.value).trim() && str(o.value).trim() !== label) out.value = str(o.value).trim();
  if (o.action === "end_turn" || o.action === "new_session") out.action = o.action;
  if (str(o.prefill).trim()) out.prefill = str(o.prefill).trim();
  return out;
}

function normalizeQuestion(raw: Record<string, unknown>, index: number): AskQuestion | null {
  const question = str(raw.question).trim();
  if (!question) return null;
  const options = (Array.isArray(raw.options) ? raw.options : []).map(normalizeOption).filter((o): o is AskOption => o !== null);
  const header = (str(raw.header).trim() || deriveHeader(question, index)).slice(0, HEADER_MAX);
  const multi = raw.multi_select ?? raw.multiSelect ?? raw.allowMultiple;
  const other = raw.other ?? raw.allowFreeform;
  return {
    question,
    header,
    options,
    ...(multi === true ? { multi_select: true } : {}),
    ...(other === false && options.length > 0 ? { other: false } : {}),
  };
}

/**
 * Tool-call arguments → { questions }. Accepts the current shape and the
 * legacy single-question one (context is folded into the question text;
 * timeout is dropped — the user answers in their own time).
 */
export function prepareArgs(args: unknown): AskParams {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  let raw: Record<string, unknown>[];
  if (Array.isArray(a.questions)) raw = a.questions.filter((q): q is Record<string, unknown> => !!q && typeof q === "object");
  else if (typeof a.question === "string") {
    const context = str(a.context).trim();
    raw = [{ ...a, header: str(a.header).trim() || deriveHeader(a.question, 0), question: context ? `${context}\n\n${a.question}` : a.question }];
  } else raw = [];
  const questions = raw.map(normalizeQuestion).filter((q): q is AskQuestion => q !== null).slice(0, MAX_QUESTIONS);
  return { questions };
}

export function optionValue(o: AskOption): string {
  return o.value ?? o.label;
}

export function isAnswered(a: QuestionAnswer | undefined): boolean {
  return !!a && (a.selected.length > 0 || !!a.custom_text?.trim());
}

/** "Planet: Jupiter moon" — the one-line summary of an answer. */
export function answerSummary(q: AskQuestion, a: QuestionAnswer | undefined): string {
  if (!isAnswered(a)) return "(skipped)";
  const labels = a!.selected.map((v) => q.options.find((o) => optionValue(o) === v)?.label ?? v);
  const parts = [...labels];
  if (a!.custom_text?.trim()) parts.push(a!.custom_text.trim());
  return parts.join(", ");
}

/**
 * The tool result the agent reads. Mirrors Devin's:
 *   User answered your questions:
 *   { "<question>": { "selected": [...], "custom_text": "...", "skipped": false } }
 */
export function answersText(questions: readonly AskQuestion[], answers: readonly (QuestionAnswer | undefined)[], images: readonly string[] = []): string {
  const body: Record<string, QuestionAnswer> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    const answered = isAnswered(a);
    body[q.question] = {
      selected: answered ? a!.selected : [],
      ...(answered && a!.custom_text?.trim() ? { custom_text: a!.custom_text.trim() } : {}),
      skipped: !answered,
    };
  });
  const lines = [`User answered your questions:`, JSON.stringify(body, null, 2)];
  if (images.length) lines.push(`Attached: ${images.join(", ")} (shown below).`);
  if (questions.some((_, i) => !isAnswered(answers[i]))) lines.push("Skipped questions were left unanswered on purpose — don't ask them again unless you must.");
  return lines.join("\n");
}

/** The "? help me out" result: nothing is decided, the user wants to talk first. */
export function clarifyText(questions: readonly AskQuestion[], answers: readonly (QuestionAnswer | undefined)[]): string {
  return [
    "The user is not ready to answer and wants to clarify these questions first.",
    "They may have more information, context or questions for you. Start by asking what they would like to clarify, then reformulate the questions if needed.",
    "Questions asked:",
    ...questions.flatMap((q, i) => [`- "${q.question}"`, `  ${isAnswered(answers[i]) ? `Answer so far: ${answerSummary(q, answers[i])}` : "(No answer provided)"}`]),
  ].join("\n");
}
