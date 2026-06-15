export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function getPath(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const obj = asObject(current);
    if (!obj || !(key in obj)) return undefined;
    current = obj[key];
  }
  return current;
}

export function firstString(root: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = readString(getPath(root, ...path));
    if (value) return value;
  }
  return null;
}

export function firstObject(root: unknown, paths: string[][]): JsonObject | null {
  for (const path of paths) {
    const value = asObject(getPath(root, ...path));
    if (value) return value;
  }
  return null;
}

export function firstArray(root: unknown, paths: string[][]): unknown[] {
  for (const path of paths) {
    const value = getPath(root, ...path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function normalizeStringArray(values: unknown[]): string[] {
  return values.map(readString).filter((value): value is string => Boolean(value));
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function walkObjects(root: unknown, visitor: (value: JsonObject) => void): void {
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as JsonObject;
    visitor(obj);
    for (const nested of Object.values(obj)) visit(nested);
  };

  visit(root);
}
