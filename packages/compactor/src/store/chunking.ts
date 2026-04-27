/**
 * Content chunking — markdown by headings, JSON recursive, plain text
 */

export interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

export function chunkMarkdown(text: string, maxChunkSize: number = 4096): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");
  let currentTitle = "";
  let currentLines: string[] = [];
  let inCodeBlock = false;

  const flush = () => {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n");
    chunks.push({
      title: currentTitle || "Untitled",
      content,
      hasCode: content.includes("```"),
    });
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) inCodeBlock = !inCodeBlock;

    if (!inCodeBlock && /^#{1,6}\s/.test(line)) {
      flush();
      currentTitle = line.replace(/^#{1,6}\s*/, "").trim();
      continue;
    }

    currentLines.push(line);

    if (currentLines.join("\n").length > maxChunkSize && !inCodeBlock) {
      flush();
      currentTitle = currentTitle ? `${currentTitle} (continued)` : "Continued";
    }
  }

  flush();
  return chunks;
}

export function chunkJSON(text: string, maxChunkSize: number = 4096): Chunk[] {
  try {
    const obj = JSON.parse(text);
    return chunkObject(obj, "root", maxChunkSize);
  } catch {
    return chunkPlainText(text, maxChunkSize);
  }
}

function chunkObject(obj: any, path: string, maxChunkSize: number): Chunk[] {
  const chunks: Chunk[] = [];

  if (typeof obj !== "object" || obj === null) {
    const content = String(obj);
    if (content.length > maxChunkSize) {
      for (let i = 0; i < content.length; i += maxChunkSize) {
        chunks.push({
          title: `${path} [${i}-${i + maxChunkSize}]`,
          content: content.slice(i, i + maxChunkSize),
          hasCode: false,
        });
      }
    } else {
      chunks.push({ title: path, content, hasCode: false });
    }
    return chunks;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const sub = chunkObject(obj[i], `${path}[${i}]`, maxChunkSize);
      chunks.push(...sub);
    }
    return chunks;
  }

  for (const [key, val] of Object.entries(obj)) {
    const sub = chunkObject(val, `${path}.${key}`, maxChunkSize);
    chunks.push(...sub);
  }

  return chunks;
}

export function chunkPlainText(text: string, maxChunkSize: number = 4096): Chunk[] {
  const chunks: Chunk[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      title: "Text",
      content: current.join("\n\n"),
      hasCode: false,
    });
    current = [];
  };

  for (const para of paragraphs) {
    if ((current.join("\n\n").length + para.length) > maxChunkSize) {
      flush();
    }
    current.push(para);
  }

  flush();
  return chunks;
}

export function autoChunk(text: string, contentType: "markdown" | "json" | "plain", maxChunkSize?: number): Chunk[] {
  switch (contentType) {
    case "markdown": return chunkMarkdown(text, maxChunkSize);
    case "json": return chunkJSON(text, maxChunkSize);
    default: return chunkPlainText(text, maxChunkSize);
  }
}
