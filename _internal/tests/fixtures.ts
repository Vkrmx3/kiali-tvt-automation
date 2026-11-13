import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createServiceResult, finishResult } from '../src/results.js';
import type { RunMetadata, ServiceResult } from '../src/types.js';

export const sampleMetadata: RunMetadata = {
  release: 'Workbook-Sample',
  environment: 'LOCAL TEST FIXTURES (not live Kiali)',
  kialiBaseUrl: 'https://example.invalid/kiali/console',
  startedAt: new Date('2026-10-09T00:00:00Z'),
  completedAt: new Date('2026-10-09T00:02:00Z'),
  logsDurationSeconds: 900,
};

export async function createPng(filePath: string, width = 960, height = 540): Promise<void> {
  const image = new PNG({ width, height });
  for (let pixel = 0; pixel < image.data.length; pixel += 4) {
    const pixelRow = Math.floor(pixel / 4 / width);
    image.data[pixel] = pixelRow < 60 ? 23 : 225;
    image.data[pixel + 1] = pixelRow < 60 ? 54 : 235;
    image.data[pixel + 2] = pixelRow < 60 ? 93 : 245;
    image.data[pixel + 3] = 255;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, PNG.sync.write(image));
}

export async function createSampleResults(directory: string): Promise<ServiceResult[]> {
  const overviewPath = path.join(directory, '01-overview.png');
  const logsPath = path.join(directory, '02-logs.png');
  const errorPath = path.join(directory, 'error.png');
  await createPng(overviewPath, 1920, 2300);
  await createPng(logsPath, 1920, 1080);
  await createPng(errorPath, 960, 540);
  const success = createServiceResult({ serviceName: 'sample-service', namespace: 'sample', workload: 'sample-service' }, 'sample-service');
  success.overviewStatus = 'CAPTURED';
  success.logsStatus = 'CAPTURED';
  success.overviewScreenshotPath = overviewPath;
  success.logsScreenshotPath = logsPath;
  success.captureTimestamp = new Date('2026-10-09T00:01:00Z');
  success.elapsedMilliseconds = 5000;
  finishResult(success);
  const failure = createServiceResult({ serviceName: 'missing-logs', namespace: 'sample', workload: 'missing-logs' }, 'missing-logs');
  failure.overviewStatus = 'CAPTURED';
  failure.overviewScreenshotPath = overviewPath;
  failure.logsStatus = 'FAILED';
  failure.errorScreenshotPath = errorPath;
  failure.captureTimestamp = new Date('2026-10-09T00:01:30Z');
  failure.remarks.push('Local fixture: logs area did not load.');
  return [success, failure];
}