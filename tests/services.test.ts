import { describe, expect, it } from 'vitest';
import { parseServices } from '../src/services.js';

const header = 'serviceName,namespace,workload,enabled\n';

describe('CSV services', () => {
  it('trims values, ignores blanks, defaults enabled to true, and excludes disabled rows', () => {
    const csv = '\uFEFF serviceName , namespace , workload , enabled \r\n\r\n kafka-ui , kafka , kafka-ui , \r\n  \r\n disabled, ns, off, FALSE\r\n app, ns, app, TRUE';
    expect(parseServices(csv)).toEqual([
      { serviceName: 'kafka-ui', namespace: 'kafka', workload: 'kafka-ui' },
      { serviceName: 'app', namespace: 'ns', workload: 'app' },
    ]);
  });

  it('supports standard quoted CSV without evaluating formula-like strings', () => {
    expect(parseServices(`${header}"=SUM(1,2)",ns,app,true`)[0]?.serviceName).toBe('=SUM(1,2)');
  });

  it('rejects duplicate names with row numbers', () => {
    expect(() => parseServices(`${header}app,ns,one,true\napp,ns,two,true`)).toThrow('row 3 duplicates serviceName from row 2');
  });

  it('rejects duplicate namespace/workload pairs, including disabled rows', () => {
    expect(() => parseServices(`${header}one,ns,app,true\ntwo,ns,app,false`)).toThrow('duplicates namespace/workload');
  });

  it.each(['app,,app,true', ',ns,app,false', 'app,ns,,true'])('requires fields even in disabled rows: %s', (row) => {
    expect(() => parseServices(header + row)).toThrow('required');
  });

  it('rejects ambiguous enabled flags', () => {
    expect(() => parseServices(`${header}app,ns,app,yes`)).toThrow('enabled must be true, false, or blank');
  });

  it.each(['', 'name,namespace,workload,enabled\na,ns,a,true', 'serviceName,namespace,workload,workload'])('rejects missing or wrong headers', (csv) => {
    expect(() => parseServices(csv)).toThrow();
  });

  it('does not echo invalid CSV data in errors', () => {
    expect(() => parseServices(`${header}app,ns,app,true,secret-value`)).toThrow('Unable to parse CSV');
  });

  it('rejects path traversal and control characters in identity fields', () => {
    expect(() => parseServices(`${header}app,..,app,true`)).toThrow('relative path segments');
    expect(() => parseServices(`${header}"two\nlines",ns,app,true`)).toThrow('single-line text');
  });
});