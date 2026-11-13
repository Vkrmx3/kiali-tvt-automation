import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSheetNames, safeExcelText, sheetHyperlink } from '../src/naming.js';
import { createServiceResult, finishResult } from '../src/results.js';
import { fitImage, SUMMARY_HEADER_ROW, verifyWorkbook, writeWorkbook } from '../src/workbook.js';
import { createSampleResults, sampleMetadata } from './fixtures.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kiali-workbook-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('workbook integration (generated PNGs, no Kiali)', () => {
  it('reopens a complete workbook and validates sheets, hyperlinks, embedded images, and non-overlapping layout', async () => {
    const results = await createSampleResults(directory);
    const output = await writeWorkbook(sampleMetadata, results, path.join(directory, 'output'));
    expect(output.verification).toMatchObject({ worksheetCount: 3, summaryRows: 2, imageCount: 4 });
    expect(output.verification.bytes).toBeGreaterThan(1000);
    expect(path.basename(output.path)).toBe('TVT-Workbook-Sample.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.path);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Summary', 'sample-service', 'missing-logs']);
    const summary = workbook.worksheets[0]!;
    expect(summary.getCell('A1').text).toBe('Kiali Post-Release TVT Evidence');
    expect(summary.getRow(SUMMARY_HEADER_ROW).values).toEqual([
      undefined, 'Namespace', 'Service Name', 'Result', 'Expected Version', 'Deployed Version', 'Version Check', 'Overview', 'Logs', 'Remarks',
    ]);
    expect(summary.columns.reduce((total, column) => total + (column.width ?? 0), 0)).toBeLessThanOrEqual(225);
    for (const [index, count] of [2, 1, 0, 1].entries()) {
      const countCell = summary.getCell(10 + index, 3);
      expect(countCell.value).toBe(count);
      expect(countCell.alignment).toMatchObject({ horizontal: 'left', vertical: 'top', wrapText: true });
    }
    expect(summary.getCell(SUMMARY_HEADER_ROW + 1, 2).value).toEqual({ text: 'sample-service', hyperlink: sheetHyperlink('sample-service') });
    expect(summary.views[0]).toMatchObject({ state: 'frozen', ySplit: SUMMARY_HEADER_ROW, showGridLines: false });
    expect(summary.autoFilter).toBeTruthy();
    expect(summary.getCell('C7').text).toContain('11:00:00');
    const service = workbook.getWorksheet('sample-service')!;
    expect(service.getCell('A15').value).toEqual({ text: 'Back to Summary', hyperlink: sheetHyperlink('Summary') });
    expect(service.getCell('C13').value).toBe('NOT REQUESTED');
    expect(service.pageSetup).toMatchObject({ orientation: 'landscape', fitToWidth: 1 });
    const images = service.getImages();
    expect(images).toHaveLength(2);
    const overview = images[0]!;
    const logs = images[1]!;
    expect(logs.range.tl.nativeRow).toBeGreaterThan(overview.range.tl.nativeRow + fitImage(1920, 2300).rows);
    expect(logs.range).toMatchObject({ ext: { width: 1080, height: 608 } });
    expect(workbook.getImage(Number(overview.imageId)).buffer?.byteLength).toBeGreaterThan(0);
    const failed = workbook.getWorksheet('missing-logs')!;
    const text: string[] = [];
    failed.eachRow((row) => row.eachCell((cell) => text.push(cell.text)));
    expect(text.join(' ')).toContain('Logs screenshot unavailable (FAILED)');
    expect(text.join(' ')).toContain('Diagnostic capture (error page)');
    expect(failed.getImages()).toHaveLength(2);
    await rm(path.join(directory, '01-overview.png'));
    expect((await verifyWorkbook(output.path, results)).imageCount).toBe(4);
  });

  it('records deployment version outcomes without discarding captured evidence and verifies their read-back', async () => {
    const [sample] = await createSampleResults(directory);
    const cases = [
      ['MATCHED', '1.2.5', 'PASS'],
      ['MISMATCH', '1.2.4', 'FAILED'],
      ['NOT FOUND', undefined, 'FAILED'],
      ['AMBIGUOUS', '1.2.4, 1.2.5', 'FAILED'],
      ['CHANGED', '1.2.4', 'FAILED'],
      ['NOT CHECKED', undefined, 'FAILED'],
    ] as const;
    const results = cases.map(([versionStatus, deployedVersion], index) => ({
      ...sample!, serviceName: `version-check-${index}`, sheetName: `version-check-${index}`,
      expectedVersion: '1.2.5', versionStatus, deployedVersion, remarks: [],
    }));
    const output = await writeWorkbook(sampleMetadata, results, directory);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.path);
    const summary = workbook.getWorksheet('Summary')!;
    expect([4, 5, 6].map((column) => summary.getCell(SUMMARY_HEADER_ROW, column).value)).toEqual(['Expected Version', 'Deployed Version', 'Version Check']);
    for (const [index, result] of results.entries()) {
      const expected = cases[index]!;
      const row = SUMMARY_HEADER_ROW + index + 1;
      expect(result.result).toBe(expected[2]);
      expect(summary.getCell(row, 3).value).toBe(expected[2]);
      expect(summary.getCell(row, 4).value).toBe('1.2.5');
      expect(summary.getCell(row, 5).value).toBe(expected[1] ?? 'Not observed');
      expect(summary.getCell(row, 6).value).toBe(expected[0]);
      const sheet = workbook.getWorksheet(result.sheetName)!;
      expect(sheet.getCell('C11').value).toBe('1.2.5');
      expect(sheet.getCell('C12').value).toBe(expected[1] ?? 'Not observed');
      expect(sheet.getCell('C13').value).toBe(expected[0]);
      expect(sheet.getImages()).toHaveLength(2);
      expect(sheet.getImages()[0]!.range.tl.nativeRow).toBeGreaterThan(15);
    }
    summary.getCell(SUMMARY_HEADER_ROW + 1, 5).value = '9.9.9';
    await workbook.xlsx.writeFile(output.path);
    await expect(verifyWorkbook(output.path, results)).rejects.toThrow('deployment version validation results are missing or inconsistent');
  });

  it('requires an observed matching version before a fully captured service can pass', () => {
    const result = createServiceResult({ serviceName: 'app', namespace: 'test', workload: 'app', expectedVersion: '1.2.5' }, 'app');
    result.overviewStatus = 'CAPTURED';
    result.logsStatus = 'CAPTURED';
    finishResult(result);
    expect(result.result).toBe('FAILED');
    result.versionStatus = 'MATCHED';
    result.deployedVersion = '1.2.4';
    finishResult(result);
    expect(result.result).toBe('FAILED');
    result.deployedVersion = '1.2.5';
    finishResult(result);
    expect(result.result).toBe('PASS');
  });

  it('writes every service, even with no screenshots, and safely handles formula-like names', async () => {
    const names = ['=1+1', "a'b", 'Summary', 'a'.repeat(70)];
    const sheetNames = createSheetNames(names);
    const results = names.map((serviceName, index) => createServiceResult({ serviceName, namespace: '+namespace', workload: '@workload' }, sheetNames[index]!));
    const output = await writeWorkbook({ ...sampleMetadata, release: '=release' }, results, directory);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.path);
    expect(workbook.worksheets).toHaveLength(5);
    results.forEach((result, index) => {
      const sheet = workbook.getWorksheet(result.sheetName)!;
      expect(sheet.getCell('C3').value).toBe(safeExcelText(result.serviceName));
      expect(sheet.getImages()).toHaveLength(0);
      expect(workbook.worksheets[0]!.getCell(SUMMARY_HEADER_ROW + index + 1, 3).value).toBe('FAILED');
    });
    expect(output.verification.imageCount).toBe(0);
  });

  it('turns missing or corrupt screenshots into explicit failures without losing the workbook', async () => {
    const results = await createSampleResults(directory);
    await writeFile(results[0]!.logsScreenshotPath!, 'not a png');
    results[0]!.overviewScreenshotPath = path.join(directory, 'does-not-exist.png');
    const output = await writeWorkbook(sampleMetadata, results, directory);
    expect(results[0]!.result).toBe('FAILED');
    expect(results[0]!.overviewStatus).toBe('FAILED');
    expect(results[0]!.remarks.join(' ')).toContain('could not be embedded');
    expect(output.verification.imageCount).toBe(2);
  });

  it('does not overwrite unless explicitly requested', async () => {
    const results = await createSampleResults(directory);
    const first = await writeWorkbook(sampleMetadata, results, directory);
    const original = await readFile(first.path);
    const second = await writeWorkbook(sampleMetadata, results, directory);
    expect(second.path).not.toBe(first.path);
    expect(await readFile(first.path)).toEqual(original);
    const replacement = await writeWorkbook(sampleMetadata, results, directory, true);
    expect(replacement.path).toBe(first.path);
    expect((await stat(first.path)).size).toBeGreaterThan(0);
  });

  it('cleans unsafe release filenames', async () => {
    const output = await writeWorkbook({ ...sampleMetadata, release: '../../release:one' }, [], directory);
    expect(path.dirname(output.path)).toBe(directory);
    expect(path.basename(output.path)).toBe('TVT-release-one.xlsx');
  });

  it('preserves images when output writing fails', async () => {
    const results = await createSampleResults(directory);
    const blockedOutput = path.join(directory, 'not-a-directory');
    await writeFile(blockedOutput, 'blocked');
    await expect(writeWorkbook(sampleMetadata, results, blockedOutput)).rejects.toThrow('Temporary screenshots have been preserved');
    expect((await stat(results[0]!.overviewScreenshotPath!)).size).toBeGreaterThan(0);
  });
});