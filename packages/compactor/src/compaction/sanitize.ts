/**
 * Sanitize message text — strip control chars, normalize whitespace
 */

export function sanitize(text: string): string {
  if (!text) return "";
  return text
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}
