/**
 * Shared resource-id construction, used by both resource-graph.ts (building `ResourceNode`s from
 * `ExtractionPageDiagnostic` counters) and page-graph.ts (building `PageNode.chunks[].resourceId`
 * / `resourceIds` / `tokenTableIds`). Keeping this in one place guarantees the two graphs agree on
 * resource identity instead of drifting into two independently-invented id schemes — a chunk's
 * `resourceId` is only useful if it actually matches a `ResourceNode.resourceId`.
 */

export function tokenTableResourceId(path: string, index: number, resourceName: string | null): string {
  return resourceName ? `token-table:${resourceName}` : `token-table:${path}:${index}`;
}

export function tokenTablePlaceholderResourceId(path: string, index: number): string {
  return `token-table:${path}:placeholder:${index}`;
}

export function statusTableResourceId(path: string, index: number, resourceName: string | null): string {
  return resourceName ? `status-table:${resourceName}` : `status-table:${path}:${index}`;
}

export function imageResourceId(path: string, index: number): string {
  return `image:${path}:${index}`;
}

export function videoResourceId(path: string, index: number): string {
  return `video:${path}:${index}`;
}

export function unknownResourceId(path: string, index: number): string {
  return `unknown-resource:${path}:${index}`;
}
