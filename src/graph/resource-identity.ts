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

/**
 * Derives the stable on-disk basename for a DSDB resource artifact (`raw/dsdb/<carbonVersion>/
 * <basename>.json`) from its full `resourceName` (e.g. `designSystems/<designSystemId>/
 * components/<componentId>`). Resource ids are only unique *within* a design system — two
 * different design systems can mint the same trailing component id — so collapsing to the bare
 * trailing segment (as earlier code did) can let one design system's artifact silently overwrite
 * another's on disk, or let resource-graph/raw-graph-build matching pick the wrong artifact.
 * Folding the design system id into the basename (matching the
 * `designSystems_<id>_components_<id>.json` filename convention the live DSDB fetch URL builder
 * already uses — see fetch-json-page.ts's `toGenericDsdbFilenameCandidate`) keeps the basename
 * unique across design systems while staying a flat, single-segment filename. Resource names that
 * don't match the `designSystems/.../components/...` shape fall back to the bare trailing segment,
 * same as before.
 */
export function dsdbArtifactBaseName(resourceName: string): string {
  const match = resourceName.match(/^designSystems\/([^/]+)\/components\/([^/]+)$/);
  if (match) return `designSystems_${match[1]}_components_${match[2]}`;
  return resourceName.split('/').filter(Boolean).at(-1) ?? resourceName;
}
