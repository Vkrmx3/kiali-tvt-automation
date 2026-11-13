import { describe, expect, it } from 'vitest';
import { createSheetNames, formatSydneyTime, safeExcelText, safePathSegment, sheetHyperlink } from '../src/naming.js';

describe('Excel sheet names', () => {
  it('preserves ordinary names and truncates long ones', () => {
    expect(createSheetNames(['kafka-ui', 'a'.repeat(60)])).toEqual(['kafka-ui', 'a'.repeat(31)]);
  });

  it('replaces every forbidden character', () => {
    expect(createSheetNames(['a\\b/c?d*e[f]g:h'])).toEqual(['a-b-c-d-e-f-g-h']);
    expect(createSheetNames(["team's service"])).toEqual(['team-s service']);
  });

  it('handles collisions, case, reserved names, and empty names deterministically', () => {
    const names = ['', '  ', 'Summary', 'SUMMARY', 'a/b', 'a:b', 'A-B', "'quoted'", 'History'];
    const expected = ['Service', 'Service-2', 'Summary-2', 'SUMMARY-3', 'a-b', 'a-b-2', 'A-B-3', 'quoted', 'History-2'];
    expect(createSheetNames(names)).toEqual(expected);
    expect(createSheetNames(names)).toEqual(expected);
  });

  it('leaves room for suffixes after truncation', () => {
    const names = createSheetNames(Array.from({ length: 12 }, () => 'a'.repeat(50)));
    expect(names.every((name) => name.length <= 31)).toBe(true);
    expect(new Set(names).size).toBe(12);
    expect(names[11]).toBe(`${'a'.repeat(28)}-12`);
  });

  it('quotes internal worksheet hyperlinks', () => {
    expect(sheetHyperlink("team's service")).toBe("#'team''s service'!A1");
  });
});

describe('safe text and paths', () => {
  it.each(['=HYPERLINK("https://example.invalid")', '+SUM(1)', '-1+1', '@SUM(1)', ' \t=1'])('escapes formula-like text: %s', (value) => {
    expect(safeExcelText(value)).toBe(`'${value}`);
  });

  it('preserves normal text and removes invalid XML control characters', () => {
    expect(safeExcelText('kafka-ui')).toBe('kafka-ui');
    expect(safeExcelText('hello\x00world')).toBe('helloworld');
  });

  it('contains filenames and supports Windows reserved names', () => {
    expect(safePathSegment('../../Release: 2026/10/09')).toBe('Release-2026-10-09');
    expect(safePathSegment('CON')).toBe('_CON');
    expect(safePathSegment('nul.txt')).toBe('_nul.txt');
    expect(safePathSegment('...')).toBe('item');
    expect(safePathSegment('a'.repeat(200)).length).toBe(90);
  });

  it('uses Sydney daylight saving instead of a fixed offset', () => {
    expect(formatSydneyTime(new Date('2026-01-01T00:00:00Z'))).toContain('11:00:00');
    expect(formatSydneyTime(new Date('2026-07-01T00:00:00Z'))).toContain('10:00:00');
  });
});