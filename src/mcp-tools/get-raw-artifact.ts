import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readArtifactText } from '../raw-artifacts/artifact-store.js';
import { findArtifactById } from '../raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import type { GraphToolContext } from './context.js';

/**
 * Debug/provenance tool only. Never dumps a full raw artifact by default — agents doing normal
 * documentation tasks should use get_page/get_component_tokens/etc., which return decoded,
 * compact data. This tool exists so an agent debugging extraction/coverage issues can inspect the
 * exact bytes a route/resource was derived from.
 *
 * Defaults to metadata + a truncated content preview (`DEFAULT_PREVIEW_CHARS` chars) with
 * `truncated: true` and the total byte size. Full content is only returned when the caller passes
 * `fullContent: true` AND the artifact is at or below `FULL_CONTENT_MAX_BYTES` — chosen to keep a
 * single MCP response well under typical client/context limits even for a "just give me
 * everything" request; large artifacts (page-data dumps, DSDB resources) routinely exceed this and
 * must stay truncated even with fullContent:true.
 */
export const DEFAULT_PREVIEW_CHARS = 2_000;
export const FULL_CONTENT_MAX_BYTES = 200_000;

export type GetRawArtifactInput = {
  artifactId: string;
  fullContent?: boolean;
  previewChars?: number;
};

export type GetRawArtifactResult = {
  found: boolean;
  message: string | null;
  artifact: (ArtifactRecord & { byteSize: number }) | null;
  content: string | null;
  truncated: boolean;
};

export async function getRawArtifact(context: GraphToolContext, input: GetRawArtifactInput): Promise<GetRawArtifactResult> {
  const record = findArtifactById(context.artifactIndex, input.artifactId);
  if (!record) {
    return { found: false, message: `Artifact not found: ${input.artifactId}`, artifact: null, content: null, truncated: false };
  }

  const absolutePath = path.join(context.cacheDir, record.localPath);
  let byteSize: number;
  try {
    byteSize = (await stat(absolutePath)).size;
  } catch {
    return {
      found: true,
      message: `Artifact record exists but its content file is missing on disk: ${record.localPath}`,
      artifact: { ...record, byteSize: 0 },
      content: null,
      truncated: false,
    };
  }

  const previewChars = input.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const wantsFull = input.fullContent === true;
  const canReturnFull = wantsFull && byteSize <= FULL_CONTENT_MAX_BYTES;

  let text: string;
  try {
    text = await readArtifactText(record.localPath, context.cacheDir);
  } catch {
    return {
      found: true,
      message: `Artifact record exists but its content could not be read as text: ${record.localPath}`,
      artifact: { ...record, byteSize },
      content: null,
      truncated: false,
    };
  }

  if (canReturnFull) {
    return { found: true, message: null, artifact: { ...record, byteSize }, content: text, truncated: false };
  }

  const truncatedReason = wantsFull
    ? `fullContent was requested but the artifact (${byteSize} bytes) exceeds the ${FULL_CONTENT_MAX_BYTES}-byte cap; returning a preview instead.`
    : null;
  return {
    found: true,
    message: truncatedReason,
    artifact: { ...record, byteSize },
    content: text.slice(0, previewChars),
    truncated: text.length > previewChars || byteSize > previewChars,
  };
}
