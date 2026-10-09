import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { safeErrorMessage } from '../src/logger.js';
import { writeWorkbook } from '../src/workbook.js';
import { createSampleResults, sampleMetadata } from '../tests/fixtures.js';

try {
  await mkdir('temp', { recursive: true });
  const directory = await mkdtemp(path.resolve('temp', 'workbook-sample-'));
  const results = await createSampleResults(directory);
  const output = await writeWorkbook(sampleMetadata, results, 'output');
  await rm(directory, { recursive: true, force: true });
  console.log(`Sample workbook: ${output.path}`);
  console.log(`Verified: ${output.verification.worksheetCount} sheets, ${output.verification.summaryRows} service rows, ${output.verification.imageCount} embedded PNGs, ${output.verification.bytes} bytes.`);
  console.log('Generated fixtures only. This workbook is not live Kiali evidence.');
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}