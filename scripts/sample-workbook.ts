import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeErrorMessage } from '../src/logger.js';
import { projectDirectories } from '../src/paths.js';
import { writeWorkbook } from '../src/workbook.js';
import { createSampleResults, sampleMetadata } from '../tests/fixtures.js';

try {
  const { applicationDirectory, operatorDirectory } = projectDirectories(fileURLToPath(new URL('../', import.meta.url)));
  const tempRoot = path.join(applicationDirectory, 'temp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'workbook-sample-'));
  const results = await createSampleResults(directory);
  const output = await writeWorkbook(sampleMetadata, results, path.join(operatorDirectory, 'output'));
  await rm(directory, { recursive: true, force: true });
  console.log(`Sample workbook: ${output.path}`);
  console.log(`Verified: ${output.verification.worksheetCount} sheets, ${output.verification.summaryRows} service rows, ${output.verification.imageCount} embedded PNGs, ${output.verification.bytes} bytes.`);
  console.log('Generated fixtures only. This workbook is not live Kiali evidence.');
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}