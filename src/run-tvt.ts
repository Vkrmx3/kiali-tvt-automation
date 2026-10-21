import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loadAuthentication, openBrowserSession, type BrowserSession } from './auth.js';
import { collectServices } from './collect.js';
import { loadConfig, parseMinutes } from './config.js';
import { enableReadOnlyRequests } from './kiali.js';
import { TvtError, consoleText, measureStage, safeErrorMessage, type TimingSink, type TimingStage } from './logger.js';
import { createSheetNames } from './naming.js';
import { createServiceResult, resultCounts } from './results.js';
import { createRunTempDirectory } from './screenshots.js';
import { loadServices } from './services.js';
import { writeWorkbook } from './workbook.js';
import type { RunOptions, ServiceResult } from './types.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function parseRunOptions(argv: string[]): RunOptions {
  const command = new Command()
    .name('tvt')
    .description('Collect read-only Kiali Overview and Logs screenshots into a local Excel workbook.')
    .requiredOption('--release <name>', 'release label for the report')
    .option('--minutes <integer>', 'log period from 1 to 1440 minutes', parseMinutes)
    .option('--headed', 'show the configured browser', false)
    .option('--service <name>', 'process one exact, enabled serviceName')
    .option('--config <path>', 'service CSV path', 'services.csv')
    .option('--settings <path>', 'application settings JSON path', 'config.json')
    .option('--keep-temp', 'preserve temporary screenshots after workbook verification', false)
    .option('--overwrite', 'explicitly replace the existing release workbook', false)
    .option('--profile', 'print sanitized phase timings after collection', false)
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  try {
    command.parse(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.code !== 'commander.helpDisplayed') {
      throw new TvtError('ARGUMENT', 'Invalid arguments. --release is required. See: npm run tvt -- --help');
    }
    throw error;
  }
  const options = command.opts<{
    release: string; minutes?: number; headed: boolean; service?: string;
    config: string; settings: string; keepTemp: boolean; overwrite: boolean; profile: boolean;
  }>();
  if (!options.release.trim() || options.release.length > 200 || /[\x00-\x1f\x7f]/.test(options.release)) {
    throw new TvtError('ARGUMENT', 'Release must be a non-empty, single-line label of at most 200 characters.');
  }
  return {
    release: options.release,
    minutes: options.minutes,
    headed: options.headed,
    service: options.service,
    configPath: options.config,
    settingsPath: options.settings,
    keepTemp: options.keepTemp,
    overwrite: options.overwrite,
    profile: options.profile,
  };
}

export async function runTvt(options: RunOptions, rootDirectory = projectRoot): Promise<{ workbookPath: string; results: ServiceResult[]; exitCode: number; tempDirectory: string; timings: Partial<Record<TimingStage, number>> }> {
  const startedAt = new Date();
  const timings: Partial<Record<TimingStage, number>> = {};
  const timing: TimingSink | undefined = options.profile ? (stage, duration) => { timings[stage] = (timings[stage] ?? 0) + duration; } : undefined;
  const config = await loadConfig(path.resolve(rootDirectory, options.settingsPath));
  const services = await loadServices(path.resolve(rootDirectory, options.configPath), options.service);
  const authDirectory = path.join(rootDirectory, 'auth');
  const state = await loadAuthentication(config, authDirectory);
  const logsDurationSeconds = options.minutes === undefined ? config.logsDurationSeconds : options.minutes * 60;
  const tempDirectory = await createRunTempDirectory(path.join(rootDirectory, 'temp'), options.release);
  const controller = new AbortController();
  let session: BrowserSession | undefined;
  let results: ServiceResult[];
  const interrupt = (): void => {
    controller.abort();
    void session?.close().catch(() => undefined);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    session = await measureStage('browser-startup', timing, () => openBrowserSession(config, authDirectory, {
      headless: options.headed ? false : config.defaultHeadless,
      readOnly: true,
      storageState: state,
    }));
    if (controller.signal.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
    await enableReadOnlyRequests(session.context);
    results = await collectServices(session.context, services, config, tempDirectory, logsDurationSeconds, controller.signal, undefined, timing);
  } catch (error) {
    const names = createSheetNames(services.map((service) => service.serviceName));
    results = services.map((service, index) => {
      const result = createServiceResult(service, names[index]!);
      result.remarks.push(`Browser setup failed: ${safeErrorMessage(error)}`);
      return result;
    });
  } finally {
    await measureStage('browser-cleanup', timing, async () => { await session?.close().catch(() => undefined); });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  const output = await writeWorkbook({
    release: options.release,
    environment: config.environment,
    kialiBaseUrl: config.kialiBaseUrl,
    startedAt,
    completedAt: new Date(),
    logsDurationSeconds,
  }, results, path.join(rootDirectory, 'output'), options.overwrite, timing);
  const counts = resultCounts(results);
  console.log('\nTVT collection completed.\n');
  console.log(`Release:         ${consoleText(options.release)}`);
  console.log(`Total services:  ${counts.total}`);
  console.log(`Successful:      ${counts.successful}`);
  console.log(`Warnings:        ${counts.warnings}`);
  console.log(`Failed:          ${counts.failed}`);
  console.log(`Workbook:        ${output.path}`);
  if (options.profile) {
    console.log('\nPhase timings (seconds, cumulative across services):');
    for (const [stage, duration] of Object.entries(timings)) console.log(`  ${stage.padEnd(20)} ${(duration / 1000).toFixed(3)}`);
  }
  if (!options.keepTemp) {
    try {
      await rm(tempDirectory, { recursive: true, force: true });
    } catch {
      console.warn('Workbook verified, but temporary screenshots could not be removed. Check local file permissions.');
    }
  }
  return { workbookPath: output.path, results, exitCode: controller.signal.aborted ? 130 : counts.failed ? 1 : 0, tempDirectory, timings };
}

async function main(): Promise<void> {
  try {
    const options = parseRunOptions(process.argv);
    if (options.profile) console.log(`CLI bootstrap: ${process.uptime().toFixed(3)}s (before browser startup)`);
    const result = await runTvt(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return;
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();