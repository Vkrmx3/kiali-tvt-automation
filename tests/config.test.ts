import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseConfig, parseMinutes, validateBaseUrl } from '../src/config.js';
import { AuthenticationError, safeErrorMessage } from '../src/logger.js';

const settings = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('configuration', () => {
  it('reads settings with one base URL override', () => {
    const parsed = parseConfig(settings, 'https://example.invalid/kiali/console/');
    expect(parsed.kialiBaseUrl).toBe('https://example.invalid/kiali/console');
    expect(parsed.logsDurationSeconds).toBe(900);
    expect(parsed.viewportWidth).toBe(1920);
  });

  it.each(['0', '-1', '1.5', '1441', '15junk', '1e2', ''])('rejects invalid log periods: %s', (minutes) => {
    expect(() => parseMinutes(minutes)).toThrow('between 1 and 1440');
  });

  it('accepts the boundaries and normal log periods', () => {
    expect([parseMinutes('1'), parseMinutes('30'), parseMinutes('1440')]).toEqual([1, 30, 1440]);
  });

  it.each(['http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid?token=secret', 'https://example.invalid/#token', 'not a URL'])('rejects unsafe URLs without disclosing their values', (value) => {
    expect(() => validateBaseUrl(value)).toThrow();
    try { validateBaseUrl(value); } catch (error) { expect(safeErrorMessage(error)).not.toContain(value); }
  });

  it('permits loopback HTTP for offline browser fixtures', () => {
    expect(validateBaseUrl('http://127.0.0.1:1234/kiali')).toBe('http://127.0.0.1:1234/kiali');
  });

  it('validates numeric and boolean settings', () => {
    expect(() => parseConfig({ ...settings, viewportWidth: 0 })).toThrow('viewportWidth');
    expect(() => parseConfig({ ...settings, defaultHeadless: 'true' })).toThrow('defaultHeadless');
    expect(() => parseConfig({ ...settings, deviceScaleFactor: Infinity })).toThrow('deviceScaleFactor');
  });
});

describe('error hygiene', () => {
  it('never forwards arbitrary browser diagnostics, tokens, HTML, headers, or URLs', () => {
    const message = safeErrorMessage(new Error('Authorization: Bearer sensitive-value Cookie: session=private https://login.invalid/?token=secret <html>secret</html>'));
    expect(message).not.toMatch(/sensitive-value|private|secret|https:|<html>|Bearer|Cookie/);
  });

  it('provides a clear authentication remedy', () => {
    expect(safeErrorMessage(new AuthenticationError())).toContain('Run: npm run login');
  });
});