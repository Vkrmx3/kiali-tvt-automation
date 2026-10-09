import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { imageSize } from 'image-size';
import { TvtError, safeErrorMessage } from './logger.js';
import { formatSydneyTime, safeExcelText, safePathSegment, sheetHyperlink } from './naming.js';
import { finishResult, resultCounts } from './results.js';
import type { RunMetadata, ServiceResult, ResultStatus } from './types.js';

export const SUMMARY_HEADER_ROW = 16;
const ROW_PIXELS = 20;
const TITLE_COLOR = '17365D';
const STATUS_COLORS: Record<ResultStatus, string> = {
  PASS: 'E2F0D9',
  'PASS WITH WARNING': 'FCE4D6',
  FAILED: 'F4CCCC',
};

interface EvidenceImage {
  bytes: Buffer;
  width: number;
  height: number;
}

interface Evidence {
  overview: EvidenceImage | undefined;
  logs: EvidenceImage | undefined;
  error: EvidenceImage | undefined;
}

export interface WorkbookVerification {
  worksheetCount: number;
  summaryRows: number;
  imageCount: number;
  bytes: number;
}

export interface WorkbookOutput {
  path: string;
  verification: WorkbookVerification;
}

export function fitImage(width: number, height: number): { width: number; height: number; rows: number } {
  const scale = Math.min(1080 / width, 1400 / height, 1);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  return { width: scaledWidth, height: scaledHeight, rows: Math.ceil(scaledHeight / ROW_PIXELS) };
}

async function readImage(filePath: string | undefined): Promise<EvidenceImage | undefined> {
  if (!filePath) return undefined;
  const info = await stat(filePath);
  if (info.size > 50 * 1024 * 1024) throw new TvtError('IMAGE', 'Screenshot exceeds the 50 MB image limit.');
  const bytes = await readFile(filePath);
  const dimensions = imageSize(bytes);
  if (dimensions.type !== 'png' || !dimensions.width || !dimensions.height) {
    throw new TvtError('IMAGE', 'Screenshot is not a valid PNG image.');
  }
  return { bytes, width: dimensions.width, height: dimensions.height };
}

async function prepareEvidence(result: ServiceResult): Promise<Evidence> {
  const evidence: Evidence = { overview: undefined, logs: undefined, error: undefined };
  for (const kind of ['overview', 'logs', 'error'] as const) {
    const pathKey = `${kind}ScreenshotPath` as const;
    try {
      evidence[kind] = await readImage(result[pathKey]);
    } catch {
      result[pathKey] = undefined;
      result.remarks.push(`${kind === 'error' ? 'Diagnostic' : kind === 'overview' ? 'Overview' : 'Logs'} image could not be embedded: file is missing, unreadable, too large, or invalid.`);
    }
    if (kind !== 'error' && !evidence[kind]) {
      const statusKey = `${kind}Status` as const;
      if (result[statusKey] === 'CAPTURED') result[statusKey] = 'FAILED';
      const note = `${kind === 'overview' ? 'Overview' : 'Logs'} screenshot unavailable.`;
      if (!result.remarks.includes(note)) result.remarks.push(note);
    }
  }
  finishResult(result);
  return evidence;
}

function styleSheet(sheet: ExcelJS.Worksheet): void {
  sheet.properties.defaultRowHeight = 15;
  sheet.views = [{ showGridLines: false }];
  sheet.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
}

function band(sheet: ExcelJS.Worksheet, row: number, lastColumn: string, title: string): void {
  sheet.mergeCells(`A${row}:${lastColumn}${row}`);
  const cell = sheet.getCell(`A${row}`);
  cell.value = safeExcelText(title);
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_COLOR } };
  cell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFF' } };
  cell.alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(row).height = 27;
}

function metadataRow(sheet: ExcelJS.Worksheet, row: number, label: string, value: string | number, lastColumn: string): void {
  sheet.mergeCells(`A${row}:B${row}`);
  sheet.mergeCells(`C${row}:${lastColumn}${row}`);
  const labelCell = sheet.getCell(`A${row}`);
  labelCell.value = label;
  labelCell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: TITLE_COLOR } };
  labelCell.alignment = { vertical: 'top', wrapText: true };
  const valueCell = sheet.getCell(`C${row}`);
  valueCell.value = typeof value === 'string' ? safeExcelText(value) : value;
  valueCell.font = { name: 'Calibri', size: 11 };
  valueCell.alignment = { vertical: 'top', wrapText: true };
  sheet.getRow(row).height = Math.max(23, Math.ceil(String(value).length / 90) * 16);
}

function buildSummary(workbook: ExcelJS.Workbook, metadata: RunMetadata, results: ServiceResult[]): void {
  const sheet = workbook.addWorksheet('Summary');
  styleSheet(sheet);
  sheet.columns = [6, 44, 24, 48, 20, 20, 25, 80, 32].map((width) => ({ width }));
  band(sheet, 1, 'I', 'Kiali Post-Release TVT Evidence');
  sheet.getRow(1).height = 36;
  const counts = resultCounts(results);
  const details: Array<[string, string | number]> = [
    ['Release name', metadata.release],
    ['Environment', metadata.environment],
    ['Kiali base URL', metadata.kialiBaseUrl],
    ['Execution start time', formatSydneyTime(metadata.startedAt)],
    ['Execution completion time', formatSydneyTime(metadata.completedAt)],
    ['Requested log period', `${metadata.logsDurationSeconds / 60} minutes (${metadata.logsDurationSeconds} seconds)`],
    ['Total enabled services', counts.total],
    ['Successful services', counts.successful],
    ['Services with warnings', counts.warnings],
    ['Failed services', counts.failed],
  ];
  details.forEach(([label, value], index) => metadataRow(sheet, index + 4, label, value, 'I'));
  const header = sheet.getRow(SUMMARY_HEADER_ROW);
  header.values = ['No.', 'Service Name', 'Namespace', 'Workload', 'Overview', 'Logs', 'Result', 'Remarks', 'Captured At'];
  header.height = 28;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_COLOR } };
    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFF' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  results.forEach((result, index) => {
    const row = sheet.getRow(SUMMARY_HEADER_ROW + index + 1);
    row.values = [
      index + 1,
      { text: safeExcelText(result.serviceName), hyperlink: sheetHyperlink(result.sheetName) },
      safeExcelText(result.namespace), safeExcelText(result.workload),
      result.overviewStatus, result.logsStatus, result.result,
      safeExcelText(result.remarks.join(' ') || 'None'),
      result.captureTimestamp ? formatSydneyTime(result.captureTimestamp) : 'Not captured',
    ];
    row.height = Math.max(36, Math.ceil(result.remarks.join(' ').length / 65) * 15, Math.ceil(result.serviceName.length / 35) * 15);
    row.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'F3F6FA' : 'FFFFFF' } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'D9E2F3' } } };
    });
    row.getCell(2).font = { name: 'Calibri', color: { argb: '0563C1' }, underline: true };
    row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_COLORS[result.result] } };
    row.getCell(7).font = { name: 'Calibri', bold: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: SUMMARY_HEADER_ROW, showGridLines: false }];
  sheet.autoFilter = { from: { row: SUMMARY_HEADER_ROW, column: 1 }, to: { row: SUMMARY_HEADER_ROW + results.length, column: 9 } };
  sheet.pageSetup.printTitlesRow = `${SUMMARY_HEADER_ROW}:${SUMMARY_HEADER_ROW}`;
  sheet.pageSetup.printArea = `A1:I${SUMMARY_HEADER_ROW + results.length}`;
}

function imageSection(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, row: number, title: string, image: EvidenceImage | undefined, missingText: string): number {
  band(sheet, row, 'L', title);
  const imageRow = row + 2;
  if (!image) {
    sheet.mergeCells(`A${imageRow}:L${imageRow + 2}`);
    const cell = sheet.getCell(`A${imageRow}`);
    cell.value = safeExcelText(missingText);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_COLORS.FAILED } };
    cell.font = { name: 'Calibri', bold: true, color: { argb: '9C0006' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
    return imageRow + 5;
  }
  const dimensions = fitImage(image.width, image.height);
  const imageId = workbook.addImage({ base64: image.bytes.toString('base64'), extension: 'png' });
  sheet.addImage(imageId, {
    tl: { col: 0, row: imageRow - 1 },
    ext: { width: dimensions.width, height: dimensions.height },
    editAs: 'oneCell',
  });
  for (let imageOffset = 0; imageOffset < dimensions.rows; imageOffset++) {
    sheet.getRow(imageRow + imageOffset).height = 15;
  }
  return imageRow + dimensions.rows + 2;
}

function buildServiceSheet(workbook: ExcelJS.Workbook, metadata: RunMetadata, result: ServiceResult, evidence: Evidence): void {
  const sheet = workbook.addWorksheet(result.sheetName);
  styleSheet(sheet);
  sheet.columns = Array.from({ length: 12 }, () => ({ width: 13 }));
  band(sheet, 1, 'L', 'Kiali Workload Evidence');
  const details: Array<[string, string | number]> = [
    ['Service name', result.serviceName], ['Namespace', result.namespace], ['Workload', result.workload],
    ['Release name', metadata.release], ['Capture timestamp', result.captureTimestamp ? formatSydneyTime(result.captureTimestamp) : 'Not captured'],
    ['Result', result.result], ['Remarks', result.remarks.join(' ') || 'None'],
    ['Elapsed', `${(result.elapsedMilliseconds / 1000).toFixed(1)} seconds`],
  ];
  details.forEach(([label, value], index) => metadataRow(sheet, index + 3, label, value, 'L'));
  sheet.getCell('C8').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_COLORS[result.result] } };
  sheet.mergeCells('A12:D12');
  sheet.getCell('A12').value = { text: 'Back to Summary', hyperlink: sheetHyperlink('Summary') };
  sheet.getCell('A12').font = { color: { argb: '0563C1' }, underline: true };
  let nextRow = imageSection(workbook, sheet, 14, 'Overview', evidence.overview, `Overview screenshot unavailable (${result.overviewStatus}). See Remarks.`);
  nextRow = imageSection(workbook, sheet, nextRow, 'Logs', evidence.logs, `Logs screenshot unavailable (${result.logsStatus}). See Remarks.`);
  if (evidence.error) nextRow = imageSection(workbook, sheet, nextRow, 'Diagnostic capture (error page)', evidence.error, 'Diagnostic capture unavailable.');
  sheet.pageSetup.printArea = `A1:L${nextRow}`;
}

export async function verifyWorkbook(filePath: string, results: readonly ServiceResult[]): Promise<WorkbookVerification> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.size) throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: output is empty.');
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(filePath);
  const summary = reopened.worksheets[0];
  if (summary?.name !== 'Summary' || reopened.worksheets.length !== results.length + 1) {
    throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: worksheet count or Summary order is incorrect.');
  }
  if (summary.rowCount !== SUMMARY_HEADER_ROW + results.length) {
    throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: Summary row count is incorrect.');
  }
  let imageCount = 0;
  for (const [index, result] of results.entries()) {
    const sheet = reopened.getWorksheet(result.sheetName);
    const value = summary.getCell(SUMMARY_HEADER_ROW + index + 1, 2).value;
    if (!sheet || !value || typeof value !== 'object' || !('hyperlink' in value) || value.hyperlink !== sheetHyperlink(result.sheetName) || value.text !== safeExcelText(result.serviceName)) {
      throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: a service worksheet or internal Summary hyperlink is missing.');
    }
    const expectedImages = [result.overviewScreenshotPath, result.logsScreenshotPath, result.errorScreenshotPath].filter(Boolean).length;
    const images = sheet.getImages();
    if (images.length !== expectedImages) throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: embedded image count is incorrect.');
    for (const image of images) {
      const media = reopened.getImage(Number(image.imageId));
      if (!media || media.extension !== 'png' || !media.buffer?.byteLength) {
        throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: PNG image data is missing.');
      }
    }
    imageCount += images.length;
  }
  for (const sheet of reopened.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: executable formula detected.');
      const value = cell.value;
      if (value && typeof value === 'object' && 'hyperlink' in value) {
        const validLinks = new Set(reopened.worksheets.map((target) => sheetHyperlink(target.name)));
        if (!validLinks.has(value.hyperlink)) throw new TvtError('WORKBOOK_VALIDATION', 'Workbook verification failed: non-local or invalid hyperlink detected.');
      }
    }));
  }
  return { worksheetCount: reopened.worksheets.length, summaryRows: results.length, imageCount, bytes: fileInfo.size };
}

export async function writeWorkbook(metadata: RunMetadata, results: ServiceResult[], outputDirectory: string, overwrite = false): Promise<WorkbookOutput> {
  const directory = path.resolve(outputDirectory);
  const baseName = `TVT-${safePathSegment(metadata.release, 'Release')}`;
  const stagedPath = path.join(directory, `.${baseName}-${randomUUID()}.partial.xlsx`);
  try {
    await mkdir(directory, { recursive: true });
    const evidence: Evidence[] = [];
    for (const result of results) evidence.push(await prepareEvidence(result));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'kiali-tvt-automation';
    workbook.created = metadata.startedAt;
    workbook.modified = metadata.completedAt;
    buildSummary(workbook, metadata, results);
    results.forEach((result, index) => buildServiceSheet(workbook, metadata, result, evidence[index]!));
    const stagingFile = await open(stagedPath, 'wx', 0o600);
    await stagingFile.close();
    await workbook.xlsx.writeFile(stagedPath);
    const verification = await verifyWorkbook(stagedPath, results);
    let destination = path.join(directory, `${baseName}.xlsx`);
    if (overwrite) {
      await rename(stagedPath, destination);
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let sequence = 0;
      while (true) {
        try {
          await copyFile(stagedPath, destination, constants.COPYFILE_EXCL);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
          sequence++;
          destination = path.join(directory, `${baseName}-${timestamp}${sequence > 1 ? `-${sequence}` : ''}.xlsx`);
        }
      }
      await rm(stagedPath).catch(() => undefined);
    }
    return { path: destination, verification };
  } catch (error) {
    const failure = new TvtError('WORKBOOK', `Workbook creation failed. ${safeErrorMessage(error)} Temporary screenshots have been preserved.`);
    failure.cause = error;
    throw failure;
  }
}