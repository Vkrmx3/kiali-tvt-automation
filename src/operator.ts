import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { chromium } from 'playwright';
import { loadEnvironmentSelection, parseEnvironmentProfiles } from './config.js';
import { ensureOperatorAuthentication } from './login.js';
import { TvtError, consoleText, safeErrorMessage } from './logger.js';
import { safePathSegment } from './naming.js';
import { projectDirectories } from './paths.js';
import { runPreparedTvt } from './run-tvt.js';
import { loadOperatorInput, updateOperatorWorkbook } from './services.js';
import type { AppConfig, EnvironmentProfile, OperatorInput, RunOptions } from './types.js';

const { applicationDirectory: projectRoot, operatorDirectory: operatorRoot } = projectDirectories(fileURLToPath(new URL('../', import.meta.url)));

export interface PreparedOperatorRun {
  readonly rootDirectory: string;
  readonly stateRoot: string;
  readonly authDirectory: string;
  readonly tempRoot: string;
  readonly outputDirectory: string;
  readonly input: OperatorInput;
  readonly profile: EnvironmentProfile;
  readonly config: AppConfig;
  readonly options: RunOptions;
}

export interface OperatorActions {
  confirm: (summary: string) => Promise<boolean>;
  checkPrerequisites?: (config: AppConfig) => Promise<void>;
  authenticate?: typeof ensureOperatorAuthentication;
  execute?: typeof runPreparedTvt;
  openReport?: (filePath: string) => Promise<void>;
  openFolder?: (directory: string) => Promise<void>;
  report?: (message: string) => void;
}

export async function prepareOperatorRun(rootDirectory = operatorRoot, stateRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Kiali-TVT'), applicationDirectory = path.resolve(rootDirectory) === operatorRoot ? projectRoot : rootDirectory): Promise<PreparedOperatorRun> {
  const root = path.resolve(rootDirectory);
  const applicationRoot = path.resolve(applicationDirectory);
  const input = await loadOperatorInput(path.join(root, 'services.xlsx'));
  const selected = await loadEnvironmentSelection(path.join(applicationRoot, 'config.json'), path.join(applicationRoot, 'environments.json'), input.environmentId);
  const identity = createHash('sha256').update(JSON.stringify([selected.profile.kialiBaseUrl, selected.config.authenticationMode])).digest('hex').slice(0, 20);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const state = path.resolve(stateRoot);
  return Object.freeze({
    rootDirectory: root, stateRoot: state,
    authDirectory: path.join(state, 'auth', `${selected.profile.id}-${identity}`),
    tempRoot: path.join(state, 'temp'),
    outputDirectory: path.join(root, 'output', selected.profile.id, `${safePathSegment(input.release, 'Release')}-${runId}`),
    input, profile: Object.freeze(selected.profile), config: Object.freeze(selected.config),
    options: Object.freeze({
      release: input.release, configPath: 'services.xlsx', settingsPath: 'config.json',
      minutes: undefined, headed: false, service: undefined, keepTemp: false, overwrite: false,
    }),
  });
}

export async function acquireOperatorLock(stateRoot: string): Promise<() => Promise<void>> {
  const identity = createHash('sha256').update(path.resolve(stateRoot).toLowerCase()).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\kiali-tvt-${identity}` : `\0kiali-tvt-${identity}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => reject(new TvtError('RUN_LOCK', 'code' in error && error.code === 'EADDRINUSE'
      ? 'TVT is already running for this Windows user. Finish or close the other TVT window first.'
      : 'Unable to reserve the TVT run lock. Ask the maintainer to check local permissions.')));
    server.listen({ path: address, readableAll: false, writableAll: false }, () => resolve());
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  };
}

async function findWindowsProgram(relativePaths: string[]): Promise<string | undefined> {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    for (const relativePath of relativePaths) {
      const candidate = path.join(root, relativePath);
      if (await access(candidate, constants.F_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}

async function checkPrerequisites(config: AppConfig): Promise<void> {
  if (process.platform !== 'win32') throw new TvtError('SETUP', 'The double-click TVT launcher supports Windows. Use the documented CLI on other platforms.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major === 24 || major === 22 && minor !== undefined && minor >= 13)) throw new TvtError('SETUP', 'Ask the TVT maintainer to install Node.js 22.13 or newer in the Node 22 or 24 release lines.');
  if (config.authenticationMode === 'persistentProfile') {
    if (!await findWindowsProgram([path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')])) {
      throw new TvtError('SETUP', 'Microsoft Edge was not found. Ask the TVT maintainer to check the browser installation.');
    }
  } else if (!await access(chromium.executablePath(), constants.F_OK).then(() => true, () => false)) {
    throw new TvtError('SETUP', 'The TVT browser is not installed. Ask the maintainer to complete the one-time Playwright setup.');
  }
}

async function checkReportFolder(directory: string): Promise<void> {
  const probe = path.join(directory, `.tvt-write-check-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    const handle = await open(probe, 'wx', 0o600);
    await handle.close();
  } catch {
    throw new TvtError('OUTPUT', 'The report folder is not writable. Ask the TVT maintainer to check folder permissions and disk space.');
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

function launchApplication(executable: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openReportInExcel(filePath: string): Promise<void> {
  if (process.platform !== 'win32') throw new TvtError('EXCEL_OPEN', 'Automatic Excel opening is available on Windows only.');
  const executable = await findWindowsProgram([
    path.join('Microsoft Office', 'root', 'Office16', 'EXCEL.EXE'),
    path.join('Microsoft Office', 'Office16', 'EXCEL.EXE'),
  ]);
  if (!executable) throw new TvtError('EXCEL_OPEN', 'Microsoft Excel was not found in the standard installation locations.');
  await launchApplication(executable, [path.resolve(filePath)]);
}

async function openReportFolder(directory: string): Promise<void> {
  if (process.platform === 'win32') await launchApplication('explorer.exe', [path.resolve(directory)]);
}

export function operatorSummary(prepared: PreparedOperatorRun): string {
  return [
    prepared.profile.production ? 'PRODUCTION TVT - confirm the target carefully' : 'TVT run confirmation',
    `Environment: ${prepared.profile.label} (${prepared.profile.id})`,
    `Kiali target: ${prepared.config.kialiBaseUrl}`,
    `Release: ${prepared.input.release}`,
    `Services: ${prepared.input.services.length} (all populated rows, including hidden or filtered rows)`,
    `Logs: ${prepared.config.logsDurationSeconds / 60} minutes`,
    'Only saved workbook values will be used. Kiali access is read-only.',
  ].map(consoleText).join('\n');
}

export async function runOperator(prepared: PreparedOperatorRun, actions: OperatorActions, signal: AbortSignal = new AbortController().signal): Promise<Awaited<ReturnType<typeof runPreparedTvt>> | undefined> {
  const report = actions.report ?? console.log;
  if (signal.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
  const releaseLock = await acquireOperatorLock(prepared.stateRoot);
  try {
    await (actions.checkPrerequisites ?? checkPrerequisites)(prepared.config);
    await checkReportFolder(prepared.outputDirectory);
    if (signal.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
    if (!await actions.confirm(operatorSummary(prepared))) {
      report('TVT cancelled. No Kiali pages were opened.');
      return undefined;
    }
    if (signal.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
    await (actions.authenticate ?? ensureOperatorAuthentication)(prepared.config, prepared.authDirectory, { signal, report });
    if (signal.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
    const result = await (actions.execute ?? runPreparedTvt)(prepared.options, {
      config: prepared.config, services: prepared.input.services, authDirectory: prepared.authDirectory,
      tempRoot: prepared.tempRoot, outputDirectory: prepared.outputDirectory, signal,
      report: (index, total, message) => report(`[${index + 1}/${total}] ${consoleText(message)}`),
    });
    if (signal.aborted || result.exitCode === 130) {
      report(`TVT was interrupted. The verified report was saved: ${result.workbookPath}`);
      return result;
    }
    report('Report verified. Opening it in Excel...');
    try {
      await (actions.openReport ?? openReportInExcel)(result.workbookPath);
    } catch {
      report(`The report is saved, but Excel could not open automatically: ${result.workbookPath}`);
      await (actions.openFolder ?? openReportFolder)(path.dirname(result.workbookPath)).catch(() => undefined);
    }
    return result;
  } finally {
    await releaseLock();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  let terminal: ReturnType<typeof createInterface> | undefined;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const command = new Command().name('Run TVT')
      .description('Run TVT using the saved Run Settings and Services worksheets.')
      .option('--check-input', 'validate and display the saved input without opening a browser or Excel')
      .option('--prepare-input', 'maintainer: add or refresh Run Settings and its environment dropdown, preserving a backup')
      .option('--data-directory <path>', 'maintainer: operator workbook and report directory', operatorRoot)
      .exitOverride();
    command.parse(process.argv);
    const flags = command.opts<{ checkInput?: boolean; prepareInput?: boolean; dataDirectory: string }>();
    const dataDirectory = path.resolve(flags.dataDirectory);
    if (flags.checkInput && flags.prepareInput) throw new TvtError('ARGUMENT', 'Choose either --check-input or --prepare-input.');
    if (flags.prepareInput) {
      const profiles = parseEnvironmentProfiles(JSON.parse(await readFile(path.join(projectRoot, 'environments.json'), 'utf8')));
      const backup = await updateOperatorWorkbook(path.join(dataDirectory, 'services.xlsx'), profiles, path.join(projectRoot, 'temp'));
      console.log(`Run Settings is ready. Existing values were preserved. Backup: ${backup}`);
      return;
    }
    const prepared = await prepareOperatorRun(dataDirectory, undefined, projectRoot);
    if (flags.checkInput) {
      console.log(operatorSummary(prepared));
      console.log('Input validation passed. No Kiali pages were opened.');
      return;
    }
    if (!stdin.isTTY) throw new TvtError('CONFIRMATION', 'Double-click Run-TVT.cmd to review and confirm the run.');
    terminal = createInterface({ input: stdin, output: stdout });
    terminal.on('SIGINT', interrupt);
    const result = await runOperator(prepared, {
      confirm: async (summary) => {
        console.log(`\n${summary}\n`);
        const expected = prepared.profile.production ? prepared.profile.id : 'yes';
        const answer = await terminal!.question(`Type ${expected} to start, or press Enter to cancel: `, { signal: controller.signal });
        return answer.trim().toLowerCase() === expected.toLowerCase();
      },
    }, controller.signal);
    process.exitCode = result?.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return;
    console.error(controller.signal.aborted ? 'TVT was interrupted. Any completed report or temporary evidence has been retained as applicable.' : safeErrorMessage(error));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    terminal?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();