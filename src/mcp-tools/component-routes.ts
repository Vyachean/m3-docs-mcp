/**
 * Minimal component-name -> route-prefix matching, intentionally duplicated (not imported) from
 * MaterialDocsStore's private `componentRouteAliases`/`normalizeComponentLookup`/
 * `singularizeComponentToken` in src/store.ts, per the stage 6 task note: store.ts's helpers are
 * private implementation details and must not be imported by other modules. This is a smaller,
 * graph-oriented variant — it only needs to recognize which `components/<slug>` route prefix a
 * component name like "switch" or "Switches" refers to, not the full alternate-slug resolution
 * store.ts does against the route plan.
 */

export function normalizeComponentSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/^-+|-+$/g, '');
}

function singularize(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.endsWith('ies') && token.length > 3) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 3) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 2) variants.add(token.slice(0, -1));
  return Array.from(variants);
}

/** Returns the set of acceptable `components/<slug>` prefixes for a given component name/slug input. */
export function componentRoutePrefixes(componentName: string): string[] {
  const normalized = normalizeComponentSlug(componentName);
  if (!normalized) return [];
  const variants = new Set<string>();
  for (const variant of singularize(normalized)) {
    variants.add(`components/${variant}`);
    variants.add(`components/${variant}s`);
    variants.add(`components/${variant}es`);
  }
  return Array.from(variants);
}

/** True when `route` (e.g. "/components/switch/specs") belongs to the given component name. */
export function routeBelongsToComponent(route: string, componentName: string): boolean {
  const prefixes = componentRoutePrefixes(componentName);
  const normalizedRoute = route.replace(/^\/+/, '');
  return prefixes.some((prefix) => normalizedRoute === prefix || normalizedRoute.startsWith(`${prefix}/`));
}
