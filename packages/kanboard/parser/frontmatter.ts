/** Shared frontmatter parser for kanboard document parsers. */

/** Parse frontmatter from markdown content.
 * Returns metadata key-value pairs and the line number where the body starts. */
export function parseFrontmatter(content: string): {
  metadata: Record<string, string>;
  bodyStart: number;
} {
  const metadata: Record<string, string> = {};
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") return { metadata, bodyStart: 0 };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      return { metadata, bodyStart: i + 1 };
    }
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    }
  }

  return { metadata, bodyStart: 0 };
}
