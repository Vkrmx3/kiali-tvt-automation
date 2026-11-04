import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServices, parseServices } from '../src/services.js';

const header = 'serviceName,namespace,workload,enabled\n';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function serviceWorkbook(rows: ExcelJS.CellValue[][], sheetName = 'Services'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tvt-services-'));
  directories.push(directory);
  const filePath = path.join(directory, 'services.xlsx');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(sheetName).addRows(rows);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

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

  it('accepts an optional expectedVersion column without changing legacy CSV rows', () => {
    expect(parseServices('serviceName,namespace,workload,enabled,expectedVersion\napp,ns,app,true, 1.2.5 ')).toEqual([
      { serviceName: 'app', namespace: 'ns', workload: 'app', expectedVersion: '1.2.5' },
    ]);
  });

  it('requires a value when the expectedVersion column is included', () => {
    expect(() => parseServices('serviceName,namespace,workload,enabled,expectedVersion\napp,ns,app,true,')).toThrow('row 2: Expected Version is required');
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

describe('Excel services', () => {
  const excelHeaders = ['Namespace', 'Service Name', 'Expected Version'];

  it('uses the service name as workload, includes every service, and ignores blank rows', async () => {
    const filePath = await serviceWorkbook([
      excelHeaders,
      [' kafka ', ' kafka-ui ', ' 1.2.5 '],
      [],
      ['  ', ' ', ' '],
      ['backoffice', 'app', 'v2.0.0-rc.1'],
    ]);
    expect(await loadServices(filePath)).toEqual([
      { serviceName: 'kafka-ui', namespace: 'kafka', workload: 'kafka-ui', expectedVersion: '1.2.5' },
      { serviceName: 'app', namespace: 'backoffice', workload: 'app', expectedVersion: 'v2.0.0-rc.1' },
    ]);
  });

  it('accepts reordered, case-insensitive headers and a single renamed worksheet', async () => {
    const filePath = await serviceWorkbook([[' expected version ', 'SERVICE NAME', 'namespace'], ['1.2.5', 'app', 'ns']], 'Sheet1');
    expect(await loadServices(filePath)).toEqual([{ serviceName: 'app', namespace: 'ns', workload: 'app', expectedVersion: '1.2.5' }]);
  });

  it('supports exact service selection', async () => {
    const filePath = await serviceWorkbook([excelHeaders, ['ns', 'one', '1.0.0'], ['ns', 'two', '2.0.0']]);
    expect(await loadServices(filePath, 'two')).toEqual([{ serviceName: 'two', namespace: 'ns', workload: 'two', expectedVersion: '2.0.0' }]);
    await expect(loadServices(filePath, 'Two')).rejects.toThrow('must match the Service Name exactly');
  });

  it('reports the original Excel row numbers for duplicates across blank rows', async () => {
    const filePath = await serviceWorkbook([excelHeaders, ['ns', 'app', '1.2.5'], [], ['other', 'app', '1.2.5']]);
    await expect(loadServices(filePath)).rejects.toThrow('Excel row 4 duplicates Service Name from row 2');
  });

  it.each([
    [['', 'app', '1.2.5'], 'Namespace is required'],
    [['ns', '', '1.2.5'], 'Service Name is required'],
    [['ns', '..', '1.2.5'], 'relative path segments'],
    [['ns', 'app\nname', '1.2.5'], 'single-line text'],
    [['ns', 'app', ''], 'Expected Version is required'],
    [['ns', 'app', '  '], 'Expected Version is required'],
    [['ns', 'app', '1.2.5\nother'], 'Expected Version must be single-line text'],
    [['ns', 'app', '1.2.5', 'extra'], 'keep data under Namespace, Service Name, or Expected Version only'],
  ] as [ExcelJS.CellValue[], string][])('rejects invalid service rows: %j', async (row, message) => {
    const filePath = await serviceWorkbook([excelHeaders, row]);
    await expect(loadServices(filePath)).rejects.toThrow(`Excel row 2`);
    await expect(loadServices(filePath)).rejects.toThrow(message);
  });

  it.each([123, true, { formula: '"app"', result: 'app' }])('rejects non-text cells without trusting cached formula results: %j', async (value) => {
    const filePath = await serviceWorkbook([excelHeaders, [value, 'app', '1.2.5']]);
    await expect(loadServices(filePath)).rejects.toThrow('cell A2: enter plain text');
  });

  it.each([1.2, { formula: '"1.2.5"', result: '1.2.5' }])('requires literal text for expected versions: %j', async (value) => {
    const filePath = await serviceWorkbook([excelHeaders, ['ns', 'app', value]]);
    await expect(loadServices(filePath)).rejects.toThrow('cell C2: enter plain text');
  });

  it.each([
    ['Name', 'Namespace'],
    ['Service Name', 'Service Name'],
    ['Service Name', 'Namespace', 'Enabled'],
    ['Service Name'],
    ['Namespace', 'Service Name'],
    ['Namespace', 'Service Name', 'Expected Version', 'ExpectedVersion'],
  ])('explains the required headers: %j', async (...headers) => {
    const filePath = await serviceWorkbook([headers]);
    await expect(loadServices(filePath)).rejects.toThrow('Excel headers must be Namespace, Service Name, and Expected Version');
  });

  it('explains how to fill an empty workbook', async () => {
    const filePath = await serviceWorkbook([excelHeaders]);
    await expect(loadServices(filePath)).rejects.toThrow('Add Namespace, Service Name, and Expected Version below the headers');
  });

  it('explains how to convert an older Excel file', async () => {
    await expect(loadServices('services.xls')).rejects.toThrow('choose Save As and select Excel Workbook (.xlsx)');
  });
});