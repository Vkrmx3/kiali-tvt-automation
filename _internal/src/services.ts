import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { parseReleaseName } from './config.js';
import { TvtError } from './logger.js';
import type { EnvironmentProfile, OperatorInput, Service } from './types.js';

interface CsvRecord {
  record: Record<string, string>;
  info: { lines: number };
}

export function parseServices(csv: string): Service[] {
  const headers = ['serviceName', 'namespace', 'workload', 'enabled'];
  let validatedHeader = false;
  let rows: CsvRecord[];
  try {
    rows = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 16384,
      info: true,
      columns: (columns: string[]) => {
        const cleaned = columns.map((column) => column.trim());
        if (new Set(cleaned).size !== cleaned.length || headers.some((header) => !cleaned.includes(header)) || cleaned.some((header) => !headers.includes(header) && header !== 'expectedVersion')) {
          throw new TvtError('CSV', 'CSV headers must include serviceName,namespace,workload,enabled, with an optional expectedVersion column.');
        }
        validatedHeader = true;
        return cleaned;
      },
    }) as CsvRecord[];
  } catch (error) {
    if (error instanceof TvtError) throw error;
    throw new TvtError('CSV', 'Unable to parse CSV. Check quoting, row lengths, the four required columns, and the optional expectedVersion column.');
  }
  if (!validatedHeader) throw new TvtError('CSV', 'CSV is empty or missing its header row.');
  return servicesFromRows(rows.map(({ record, info }) => ({ values: record, rowNumber: info.lines })), 'CSV');
}

function servicesFromRows(rows: { values: Record<string, string>; rowNumber: number }[], source: 'CSV' | 'Excel'): Service[] {
  const code = source === 'CSV' ? 'CSV' : 'EXCEL';
  const serviceRows = new Map<string, number>();
  const workloadRows = new Map<string, number>();
  const services: Service[] = [];
  for (const { values: record, rowNumber } of rows) {
    const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.trim()]));
    const service: Service = {
      serviceName: values.serviceName ?? '',
      namespace: values.namespace ?? '',
      workload: values.workload ?? '',
    };
    for (const [field, value] of Object.entries(service)) {
      const label = source === 'Excel' ? (field === 'namespace' ? 'Namespace' : 'Service Name') : field;
      if (!value) throw new TvtError(code, `${source} row ${rowNumber}: ${label} is required.`);
      if (value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new TvtError(code, `${source} row ${rowNumber}: ${label} must be single-line text of at most 1024 characters.`);
      }
    }
    if ([service.namespace, service.workload].some((value) => value === '.' || value === '..')) {
      throw new TvtError(code, `${source} row ${rowNumber}: ${source === 'Excel' ? 'Namespace and Service Name' : 'namespace and workload'} cannot be relative path segments.`);
    }
    if (values.expectedVersion !== undefined) {
      if (!values.expectedVersion) throw new TvtError(code, `${source} row ${rowNumber}: Expected Version is required.`);
      if (values.expectedVersion.length > 1024 || /[\x00-\x1f\x7f]/.test(values.expectedVersion)) {
        throw new TvtError(code, `${source} row ${rowNumber}: Expected Version must be single-line text of at most 1024 characters.`);
      }
      service.expectedVersion = values.expectedVersion;
    }
    const enabled = values.enabled?.toLowerCase() || 'true';
    if (!['true', 'false'].includes(enabled)) throw new TvtError(code, `${source} row ${rowNumber}: enabled must be true, false, or blank.`);
    const earlierService = serviceRows.get(service.serviceName);
    if (earlierService !== undefined) throw new TvtError(code, `${source} row ${rowNumber} duplicates ${source === 'Excel' ? 'Service Name' : 'serviceName'} from row ${earlierService}.`);
    const workloadKey = JSON.stringify([service.namespace, service.workload]);
    const earlierWorkload = workloadRows.get(workloadKey);
    if (earlierWorkload !== undefined) throw new TvtError(code, `${source} row ${rowNumber} duplicates namespace/workload from row ${earlierWorkload}.`);
    serviceRows.set(service.serviceName, rowNumber);
    workloadRows.set(workloadKey, rowNumber);
    if (enabled === 'true') services.push(service);
  }
  return services;
}

function excelCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && 'richText' in value) return value.richText.map((part) => part.text).join('').trim();
  throw new TvtError('EXCEL', `Excel row ${cell.row}, cell ${cell.address}: enter plain text, not a formula, number, date, or link.`);
}

async function readExcelWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    throw new TvtError('EXCEL', 'Unable to open the service Excel file. Check the --config path, file permissions, and that it is a valid .xlsx workbook.');
  }
  return workbook;
}

function excelServices(workbook: ExcelJS.Workbook): Service[] {
  const worksheet = workbook.getWorksheet('Services') ?? (workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined);
  if (!worksheet) throw new TvtError('EXCEL', 'Add a worksheet named Services with Namespace, Service Name, and Expected Version in the first row.');
  const columns = new Map<number, string>();
  worksheet.getRow(1).eachCell((cell, columnNumber) => {
    const header = excelCellText(cell).toLowerCase();
    if (!header) return;
    const field = header === 'service name' || header === 'servicename' ? 'serviceName' : header === 'namespace' ? 'namespace' : header === 'expected version' || header === 'expectedversion' ? 'expectedVersion' : undefined;
    if (!field || [...columns.values()].includes(field)) {
      throw new TvtError('EXCEL', 'Excel headers must be Namespace, Service Name, and Expected Version in the first row. No Workload or Enabled column is needed.');
    }
    columns.set(columnNumber, field);
  });
  if (columns.size !== 3) throw new TvtError('EXCEL', 'Excel headers must be Namespace, Service Name, and Expected Version in the first row.');
  const rows: { values: Record<string, string>; rowNumber: number }[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    row.eachCell((cell, columnNumber) => {
      const value = excelCellText(cell);
      if (!value) return;
      const field = columns.get(columnNumber);
      if (!field) throw new TvtError('EXCEL', `Excel row ${rowNumber}, cell ${cell.address}: keep data under Namespace, Service Name, or Expected Version only.`);
      values[field] = value;
    });
    if (!Object.keys(values).length) return;
    values.workload = values.serviceName ?? '';
    values.expectedVersion ??= '';
    rows.push({ values, rowNumber });
  });
  return servicesFromRows(rows, 'Excel');
}

export async function loadOperatorInput(filePath: string): Promise<OperatorInput> {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') throw new TvtError('EXCEL', 'The launcher requires services.xlsx with Run Settings and Services worksheets.');
  const workbook = await readExcelWorkbook(filePath);
  const settings = workbook.getWorksheet('Run Settings');
  if (!settings) throw new TvtError('EXCEL', 'The Run Settings worksheet is missing. Ask the TVT maintainer to update the input workbook.');
  const values: string[] = [];
  for (const [address, label] of [['B3', 'Environment'], ['B4', 'Release Name']] as const) {
    let value: string;
    try {
      value = excelCellText(settings.getCell(address));
    } catch {
      throw new TvtError('EXCEL', `Run Settings!${address}: enter ${label} as plain text, not a formula, number, or link.`);
    }
    if (!value) throw new TvtError('EXCEL', `Run Settings!${address}: ${label} is required. Save the workbook before running TVT.`);
    values.push(value);
  }
  const services = excelServices(workbook);
  if (!services.length) throw new TvtError('EXCEL', 'The Services worksheet is empty. Add at least one service to check.');
  return Object.freeze({
    environmentId: values[0]!.toUpperCase(),
    release: parseReleaseName(values[1]),
    services: Object.freeze(services.map((service) => Object.freeze(service))),
  });
}

export async function updateOperatorWorkbook(filePath: string, profiles: readonly EnvironmentProfile[], backupDirectory = path.join(path.dirname(filePath), 'temp')): Promise<string> {
  if (!profiles.length) throw new TvtError('CONFIG', 'Configure at least one environment before preparing the workbook.');
  const original = await readFile(filePath);
  const workbook = await readExcelWorkbook(filePath);
  const services = workbook.getWorksheet('Services');
  if (!services) throw new TvtError('EXCEL', 'The Services worksheet is missing. No changes were made.');
  const settings = workbook.getWorksheet('Run Settings') ?? workbook.addWorksheet('Run Settings');
  settings.state = 'visible';
  settings.getColumn(1).width = 24;
  settings.getColumn(2).width = 38;
  settings.getColumn(3).width = 40;
  settings.getCell('A1').value = 'TVT Run Settings';
  settings.getCell('A1').font = { name: 'Calibri', size: 16, bold: true, color: { argb: '17365D' } };
  settings.getRow(1).height = 30;
  settings.getCell('A3').value = 'Environment';
  settings.getCell('A4').value = 'Release Name';
  settings.getCell('A6').value = 'Save this workbook before starting Run-TVT.cmd.';
  settings.getCell('A8').value = 'All populated Services rows run, including hidden or filtered rows.';
  for (const row of [3, 4]) {
    const cell = settings.getCell(row, 2);
    cell.numFmt = '@';
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
    cell.font = { name: 'Calibri', size: 12 };
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    settings.getRow(row).height = 30;
  }
  settings.getColumn(5).values = ['Approved environments', ...profiles.map((profile) => profile.id)];
  settings.getColumn(5).hidden = true;
  settings.getCell('B3').dataValidation = {
    type: 'list', allowBlank: false, showErrorMessage: true, errorStyle: 'stop',
    errorTitle: 'Choose an environment', error: 'Select an environment from the dropdown.',
    formulae: [`'Run Settings'!$E$2:$E$${profiles.length + 1}`],
  };
  services.getColumn(3).numFmt = '@';
  const model = workbook.model;
  model.sheets = [
    ...model.sheets.filter((sheet) => sheet.id === settings.id),
    ...model.sheets.filter((sheet) => sheet.id !== settings.id),
  ];
  workbook.model = model;
  workbook.views = [{
    x: 0, y: 0, width: 18000, height: 12000, ...workbook.views?.[0],
    firstSheet: 0, activeTab: 0, visibility: 'visible',
  }];
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDirectory, `services-before-settings-${randomUUID()}.xlsx`);
  const staged = path.join(path.dirname(filePath), `.services-${randomUUID()}.partial.xlsx`);
  try {
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    await writeFile(staged, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx', mode: 0o600 });
    const reopened = await readExcelWorkbook(staged);
    if (reopened.worksheets[0]?.name !== 'Run Settings' || reopened.views?.[0]?.activeTab !== 0 || reopened.views?.[0]?.firstSheet !== 0 ||
      JSON.stringify(reopened.getWorksheet('Services')!.getSheetValues()) !== JSON.stringify(services.getSheetValues())) {
      throw new TvtError('EXCEL', 'Workbook setup verification failed. The original file has not been replaced.');
    }
    if (!(await readFile(filePath)).equals(original)) throw new TvtError('EXCEL', 'The workbook changed during setup. Save your edits and run setup again; the current file was not overwritten.');
    await rename(staged, filePath);
    return backup;
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

export async function loadServices(filePath: string, selectedService?: string): Promise<Service[]> {
  const extension = path.extname(filePath).toLowerCase();
  let services: Service[];
  if (extension === '.xlsx') {
    services = excelServices(await readExcelWorkbook(filePath));
  } else if (extension === '.csv') {
    let csv: string;
    try {
      csv = await readFile(filePath, 'utf8');
    } catch {
      throw new TvtError('CSV', 'Unable to read service CSV. Check the --config path and file permissions.');
    }
    services = parseServices(csv);
  } else {
    throw new TvtError('SERVICES', 'Use an Excel workbook (.xlsx) or a CSV file (.csv). For older Excel files, choose Save As and select Excel Workbook (.xlsx).');
  }
  const selected = selectedService === undefined ? services : services.filter((service) => service.serviceName === selectedService);
  if (!selected.length) {
    if (extension === '.xlsx') {
      throw new TvtError('EXCEL', selectedService === undefined ? 'The Excel service list is empty. Add Namespace, Service Name, and Expected Version below the headers.' : 'The requested service was not found in the Excel list. --service must match the Service Name exactly, including capital letters.');
    }
    throw new TvtError('CSV', selectedService === undefined ? 'The CSV contains no enabled services.' : 'The requested service was not found among enabled CSV rows. --service is an exact, case-sensitive name.');
  }
  return selected;
}