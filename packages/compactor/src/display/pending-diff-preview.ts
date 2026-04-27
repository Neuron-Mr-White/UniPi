/**
 * Pending diff previews during streaming
 */

export interface PendingDiffPreviewData {
  type: "edit" | "write" | "create";
  filePath: string;
  previousContent?: string;
  newContent: string;
  confidence: number;
}

export function buildPendingEditPreviewData(
  filePath: string,
  oldText: string,
  newText: string,
): PendingDiffPreviewData {
  return {
    type: "edit",
    filePath,
    previousContent: oldText,
    newContent: newText,
    confidence: 1.0,
  };
}

export function buildPendingWritePreviewData(
  filePath: string,
  content: string,
  fileExisted: boolean,
): PendingDiffPreviewData {
  return {
    type: fileExisted ? "write" : "create",
    filePath,
    newContent: content,
    confidence: 1.0,
  };
}

export function renderPendingDiffPreview(data: PendingDiffPreviewData, opts?: { maxLines?: number }): string {
  const maxLines = opts?.maxLines ?? 20;
  const lines = data.newContent.split("\n").slice(0, maxLines);
  const header = data.type === "edit" ? `✏️  Edit: ${data.filePath}`
    : data.type === "write" ? `📝 Write: ${data.filePath}`
    : `📄 Create: ${data.filePath}`;

  const omitted = data.newContent.split("\n").length - lines.length;
  const hint = omitted > 0 ? `\n...(${omitted} more lines)...` : "";

  return `${header}\n${"─".repeat(header.length)}\n${lines.join("\n")}${hint}`;
}
