/**
 * @unipi/memory — Embedding generation
 *
 * Placeholder for future embedding support.
 * Currently uses fuzzy text search only.
 */

/**
 * Generate an embedding for the given text.
 * Returns null (fuzzy-only mode).
 *
 * Future: Use LLM or local model for embeddings.
 */
export async function generateEmbedding(
  _text: string,
  _ai?: any
): Promise<Float32Array | null> {
  // Fuzzy-only mode for now
  return null;
}

/**
 * Convert Float32Array to Buffer for SQLite storage.
 */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

/**
 * Convert Buffer from SQLite to Float32Array.
 */
export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Check if embeddings are available (sqlite-vec loaded).
 */
export function hasEmbeddings(db: any): boolean {
  try {
    db.prepare("SELECT * FROM memories_vec LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}
