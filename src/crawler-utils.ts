import crypto from 'node:crypto';

const SKIP_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|xml|json|txt)$/i;

export function normalizeMaterialUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin) return null;
    url.hash = '';
    url.search = '';
    if (SKIP_EXTENSIONS.test(url.pathname)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
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
