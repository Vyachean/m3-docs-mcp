function stripPagesPrefix(value: string): string {
  return value.replace(/^pages\//i, '');
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function normalizeGraphRoute(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';

  let pathname = trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      pathname = trimmed;
    }
  }

  const normalized = normalizeSlashes(stripPagesPrefix(pathname))
    .replace(/\.md$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (!normalized || normalized === 'index') return '/';
  return `/${normalized}`;
}

export function routeToMarkdownPath(route: string): string {
  const normalized = normalizeGraphRoute(route);
  if (normalized === '/') return 'index.md';
  return `${normalized.replace(/^\/+/, '')}.md`;
}

export function markdownPathToRoute(path: string): string {
  return normalizeGraphRoute(path);
}
