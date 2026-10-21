import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSheetNames, safeExcelText, sheetHyperlink } from '../src/naming.js';
import { createServiceResult } from '../src/results.js';
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
    expect(summary.getCell('C10').value).toBe(2);
    expect(summary.getCell(SUMMARY_HEADER_ROW + 1, 2).value).toEqual({ text: 'sample-service', hyperlink: sheetHyperlink('sample-service') });
    expect(summary.views[0]).toMatchObject({ state: 'frozen', ySplit: SUMMARY_HEADER_ROW, showGridLines: false });
    expect(summary.autoFilter).toBeTruthy();
    expect(summary.getCell('C7').text).toContain('11:00:00');
    const service = workbook.getWorksheet('sample-service')!;
    expect(service.getCell('A12').value).toEqual({ text: 'Back to Summary', hyperlink: sheetHyperlink('Summary') });
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
      expect(workbook.worksheets[0]!.getCell(SUMMARY_HEADER_ROW + index + 1, 7).value).toBe('FAILED');
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