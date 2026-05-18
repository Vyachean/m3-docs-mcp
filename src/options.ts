type NumericInput = string | number | undefined;

export function parsePositiveIntegerOption(name: string, value: NumericInput, defaultValue?: number): number {
  const parsed = parseFiniteNumber(name, value, defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parsePositiveNumberOption(name: string, value: NumericInput, defaultValue?: number): number {
  const parsed = parseFiniteNumber(name, value, defaultValue);
  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return parsed;
}

function parseFiniteNumber(name: string, value: NumericInput, defaultValue?: number): number {
  const resolved = value ?? defaultValue;
  if (resolved === undefined) {
    throw new Error(`${name} is required.`);
  }

  if (typeof resolved === 'string' && resolved.trim() === '') {
    throw new Error(`${name} must be a finite number.`);
  }

  const parsed = typeof resolved === 'number' ? resolved : Number(resolved);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return parsed;
}
