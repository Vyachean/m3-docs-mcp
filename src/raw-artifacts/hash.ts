import { createHash } from 'node:crypto';

/**
 * Computes a lowercase hex-encoded SHA-256 digest of the given content.
 * Accepts either raw bytes (Buffer) or text (string, encoded as UTF-8).
 */
export function sha256Hex(content: Buffer | string): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}
