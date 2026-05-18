import { describe, expect, it } from 'vitest';
import { parsePositiveIntegerOption, parsePositiveNumberOption } from '../src/options.js';

describe('numeric option validation', () => {
  it('parses positive integer options', () => {
    expect(parsePositiveIntegerOption('--max-pages', '250')).toBe(250);
    expect(parsePositiveIntegerOption('--max-pages', '1')).toBe(1);
    expect(parsePositiveIntegerOption('--max-pages', 25)).toBe(25);
    expect(parsePositiveIntegerOption('--max-pages', undefined, 10)).toBe(10);
  });

  it('rejects invalid positive integer options', () => {
    expect(() => parsePositiveIntegerOption('--max-pages', '0')).toThrow('--max-pages must be a positive integer.');
    expect(() => parsePositiveIntegerOption('--max-pages', '-1')).toThrow('--max-pages must be a positive integer.');
    expect(() => parsePositiveIntegerOption('--max-pages', '1.5')).toThrow('--max-pages must be a positive integer.');
    expect(() => parsePositiveIntegerOption('--max-pages', 'abc')).toThrow('--max-pages must be a finite number.');
    expect(() => parsePositiveIntegerOption('--max-pages', '')).toThrow('--max-pages must be a finite number.');
    expect(() => parsePositiveIntegerOption('--max-pages', '   ')).toThrow('--max-pages must be a finite number.');
  });

  it('parses positive number options', () => {
    expect(parsePositiveNumberOption('--max-age-hours', '24')).toBe(24);
    expect(parsePositiveNumberOption('--max-age-hours', '0.5')).toBe(0.5);
    expect(parsePositiveNumberOption('--max-age-hours', undefined, 12)).toBe(12);
  });

  it('rejects invalid positive number options', () => {
    expect(() => parsePositiveNumberOption('--max-age-hours', '0')).toThrow('--max-age-hours must be greater than zero.');
    expect(() => parsePositiveNumberOption('--max-age-hours', '-1')).toThrow('--max-age-hours must be greater than zero.');
    expect(() => parsePositiveNumberOption('--max-age-hours', 'NaN')).toThrow('--max-age-hours must be a finite number.');
    expect(() => parsePositiveNumberOption('--max-age-hours', undefined)).toThrow('--max-age-hours is required.');
  });
});
