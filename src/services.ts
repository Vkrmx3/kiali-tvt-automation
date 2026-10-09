import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { TvtError } from './logger.js';
import type { Service } from './types.js';

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
        if (cleaned.length !== headers.length || new Set(cleaned).size !== headers.length || headers.some((header) => !cleaned.includes(header))) {
          throw new TvtError('CSV', 'CSV headers must be exactly: serviceName,namespace,workload,enabled.');
        }
        validatedHeader = true;
        return cleaned;
      },
    }) as CsvRecord[];
  } catch (error) {
    if (error instanceof TvtError) throw error;
    throw new TvtError('CSV', 'Unable to parse CSV. Check quoting, row lengths, and the four required columns.');
  }
  if (!validatedHeader) throw new TvtError('CSV', 'CSV is empty or missing its header row.');
  const serviceRows = new Map<string, number>();
  const workloadRows = new Map<string, number>();
  const services: Service[] = [];
  for (const { record, info } of rows) {
    const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.trim()]));
    const service: Service = {
      serviceName: values.serviceName ?? '',
      namespace: values.namespace ?? '',
      workload: values.workload ?? '',
    };
    for (const [field, value] of Object.entries(service)) {
      if (!value) throw new TvtError('CSV', `CSV row ${info.lines}: ${field} is required.`);
      if (value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new TvtError('CSV', `CSV row ${info.lines}: ${field} must be single-line text of at most 1024 characters.`);
      }
    }
    if ([service.namespace, service.workload].some((value) => value === '.' || value === '..')) {
      throw new TvtError('CSV', `CSV row ${info.lines}: namespace and workload cannot be relative path segments.`);
    }
    const enabled = values.enabled?.toLowerCase() || 'true';
    if (!['true', 'false'].includes(enabled)) throw new TvtError('CSV', `CSV row ${info.lines}: enabled must be true, false, or blank.`);
    const earlierService = serviceRows.get(service.serviceName);
    if (earlierService !== undefined) throw new TvtError('CSV', `CSV row ${info.lines} duplicates serviceName from row ${earlierService}.`);
    const workloadKey = JSON.stringify([service.namespace, service.workload]);
    const earlierWorkload = workloadRows.get(workloadKey);
    if (earlierWorkload !== undefined) throw new TvtError('CSV', `CSV row ${info.lines} duplicates namespace/workload from row ${earlierWorkload}.`);
    serviceRows.set(service.serviceName, info.lines);
    workloadRows.set(workloadKey, info.lines);
    if (enabled === 'true') services.push(service);
  }
  return services;
}

export async function loadServices(filePath: string, selectedService?: string): Promise<Service[]> {
  let csv: string;
  try {
    csv = await readFile(filePath, 'utf8');
  } catch {
    throw new TvtError('CSV', 'Unable to read service CSV. Check the --config path and file permissions.');
  }
  const services = parseServices(csv);
  const selected = selectedService === undefined ? services : services.filter((service) => service.serviceName === selectedService);
  if (!selected.length) {
    throw new TvtError('CSV', selectedService === undefined ? 'The CSV contains no enabled services.' : 'The requested service was not found among enabled CSV rows. --service is an exact, case-sensitive name.');
  }
  return selected;
}