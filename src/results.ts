import type { Service, ServiceResult } from './types.js';

export function createServiceResult(service: Service, sheetName: string): ServiceResult {
  return {
    ...service,
    sheetName,
    overviewStatus: 'NOT ATTEMPTED',
    logsStatus: 'NOT ATTEMPTED',
    result: 'FAILED',
    remarks: [],
    captureTimestamp: null,
    overviewScreenshotPath: undefined,
    logsScreenshotPath: undefined,
    errorScreenshotPath: undefined,
    elapsedMilliseconds: 0,
  };
}

export function finishResult(result: ServiceResult): void {
  result.result = result.overviewStatus !== 'CAPTURED' || result.logsStatus !== 'CAPTURED'
    ? 'FAILED'
    : result.remarks.length ? 'PASS WITH WARNING' : 'PASS';
}

export function resultCounts(results: readonly ServiceResult[]): { total: number; successful: number; warnings: number; failed: number } {
  return {
    total: results.length,
    successful: results.filter((result) => result.result === 'PASS').length,
    warnings: results.filter((result) => result.result === 'PASS WITH WARNING').length,
    failed: results.filter((result) => result.result === 'FAILED').length,
  };
}