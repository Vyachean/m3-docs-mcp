import crypto from 'node:crypto';

const SKIP_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|xml|json|txt)$/i;
const ABSOLUTE_OR_ROOT_RELATIVE_URL = /^[a-z][a-z\d+.-]*:|^\/|^[?#]/i;
const NON_DOC_PATH_PREFIXES = [
  'assets/',
  'static/',
  '_dsm/',
  'm3/pages/',
  'favicon',
  'manifest',
  'robots.txt',
  'sitemap'
];

export function normalizeMaterialUrl(raw: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const resolutionBase = ABSOLUTE_OR_ROOT_RELATIVE_URL.test(raw) ? baseUrl : `${base.origin}/`;
    const url = new URL(raw, resolutionBase);
    if (url.origin !== base.origin) return null;
    url.hash = '';
    url.search = '';
    if (SKIP_EXTENSIONS.test(url.pathname)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function normalizeMaterialPublicDocPath(raw: string, baseUrl: string): string | null {
  const normalizedUrl = normalizeMaterialUrl(raw, baseUrl);
  if (!normalizedUrl) return null;
  const pathname = new URL(normalizedUrl).pathname.replace(/\/+/g, '/');
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  const pathWithoutLeadingSlash = normalizedPath.replace(/^\/+/, '');
  if (NON_DOC_PATH_PREFIXES.some((prefix) => pathWithoutLeadingSlash === prefix || pathWithoutLeadingSlash.startsWith(prefix))) return null;
  return normalizedPath;
}

export function materialPagePath(url: string): string {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  return `${pathname || 'index'}.md`;
}

export function sectionFromPagePath(filePath: string): string {
  const parts = filePath.replace(/\.md$/, '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
}

export function materialPageId(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}
