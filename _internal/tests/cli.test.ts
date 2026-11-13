import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAuthentication, loadSession, openBrowserSession, saveAuthentication } from '../src/auth.js';
import { parseConfig } from '../src/config.js';
import { acquireOperatorLock, prepareOperatorRun, runOperator } from '../src/operator.js';
import { projectDirectories } from '../src/paths.js';
import { parseRunOptions } from '../src/run-tvt.js';
import { createRunTempDirectory } from '../src/screenshots.js';
import { loadServices } from '../src/services.js';

let directory: string;
const config = parseConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kiali-cli-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('operator launcher', () => {
  it('resolves an internal application folder to the outer operator folder', () => {
    expect(projectDirectories(path.join(directory, '_internal'))).toEqual({
      applicationDirectory: path.join(directory, '_internal'), operatorDirectory: directory,
    });
    expect(projectDirectories(directory)).toEqual({ applicationDirectory: directory, operatorDirectory: directory });
  });

  async function inputFiles(environment = 'DEV', developmentUrl = 'https://dev.example.invalid/kiali'): Promise<void> {
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    await writeFile(path.join(directory, 'environments.json'), JSON.stringify({ environments: [
      { id: 'DEV', label: 'Development', kialiBaseUrl: developmentUrl, production: false },
      { id: 'PRD', label: 'Production', kialiBaseUrl: 'https://prd.example.invalid/kiali', production: true },
    ] }));
    const workbook = new ExcelJS.Workbook();
    const settings = workbook.addWorksheet('Run Settings');
    settings.getCell('B3').value = environment;
    settings.getCell('B4').value = 'Release-123';
    workbook.addWorksheet('Services').addRows([['Namespace', 'Service Name', 'Expected Version'], ['test', 'app', '1.2.5']]);
    await workbook.xlsx.writeFile(path.join(directory, 'services.xlsx'));
  }

  function actions(workbookPath: string) {
    return {
      confirm: vi.fn().mockResolvedValue(true),
      checkPrerequisites: vi.fn().mockResolvedValue(undefined),
      authenticate: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({ workbookPath, results: [], exitCode: 0, tempDirectory: path.join(directory, 'temp') }),
      openReport: vi.fn().mockResolvedValue(undefined),
      openFolder: vi.fn().mockResolvedValue(undefined),
      report: vi.fn(),
    };
  }

  it('isolates authentication by environment and target identity', async () => {
    const stateRoot = path.join(directory, 'state');
    await inputFiles();
    const development = await prepareOperatorRun(directory, stateRoot);
    await inputFiles('PRD');
    const production = await prepareOperatorRun(directory, stateRoot);
    await inputFiles('DEV', 'https://changed.example.invalid/kiali');
    const changed = await prepareOperatorRun(directory, stateRoot);
    expect(new Set([development.authDirectory, production.authDirectory, changed.authDirectory]).size).toBe(3);
    expect(production.profile.production).toBe(true);
    expect(production.outputDirectory).toContain(path.join('output', 'PRD'));
    expect(Object.isFrozen(production.config)).toBe(true);
  });

  it('keeps operator input and output outside the internal application configuration', async () => {
    await inputFiles('PRD');
    const applicationDirectory = path.join(directory, '_internal');
    await mkdir(applicationDirectory);
    await rename(path.join(directory, 'config.json'), path.join(applicationDirectory, 'config.json'));
    await rename(path.join(directory, 'environments.json'), path.join(applicationDirectory, 'environments.json'));
    await writeFile(path.join(directory, 'config.json'), 'not the application settings');
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'), applicationDirectory);
    expect(prepared.rootDirectory).toBe(directory);
    expect(prepared.config.kialiBaseUrl).toBe('https://prd.example.invalid/kiali');
    expect(prepared.input.services[0]!.serviceName).toBe('app');
    expect(path.relative(directory, prepared.outputDirectory)).toMatch(/^output[\\/]PRD[\\/]/);
    await rm(path.join(applicationDirectory, 'environments.json'));
    await expect(prepareOperatorRun(directory, path.join(directory, 'state'), applicationDirectory)).rejects.toThrow('Unable to read');
  });

  it('prevents a second run and releases its lock for the next run', async () => {
    const stateRoot = path.join(directory, 'state');
    const release = await acquireOperatorLock(stateRoot);
    try {
      await expect(acquireOperatorLock(stateRoot)).rejects.toThrow('already running');
    } finally {
      await release();
    }
    await (await acquireOperatorLock(stateRoot))();
  });

  it('executes only the confirmed snapshot and opens the completed report', async () => {
    await inputFiles('PRD');
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.confirm.mockImplementation(async () => {
      await writeFile(path.join(directory, 'services.xlsx'), 'changed after confirmation');
      return true;
    });
    const result = await runOperator(prepared, controls);
    expect(result?.exitCode).toBe(0);
    expect(controls.confirm.mock.calls[0]?.[0]).toContain('PRODUCTION');
    expect(controls.confirm.mock.calls[0]?.[0]).toContain('prd.example.invalid');
    expect(controls.execute).toHaveBeenCalledWith(expect.objectContaining({ release: 'Release-123' }), expect.objectContaining({ services: prepared.input.services, authDirectory: prepared.authDirectory }));
    expect(controls.openReport).toHaveBeenCalledExactlyOnceWith(result!.workbookPath);
    expect(controls.openFolder).not.toHaveBeenCalled();
  });

  it('does not authenticate or collect when confirmation is declined', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.confirm.mockResolvedValue(false);
    expect(await runOperator(prepared, controls)).toBeUndefined();
    expect(controls.authenticate).not.toHaveBeenCalled();
    expect(controls.execute).not.toHaveBeenCalled();
    await (await acquireOperatorLock(prepared.stateRoot))();
  });

  it('honors cancellation after confirmation and releases the run lock', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controller = new AbortController();
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.confirm.mockImplementation(async () => { controller.abort(); return true; });
    await expect(runOperator(prepared, controls, controller.signal)).rejects.toThrow('interrupted');
    expect(controls.authenticate).not.toHaveBeenCalled();
    expect(controls.execute).not.toHaveBeenCalled();
    await (await acquireOperatorLock(prepared.stateRoot))();
  });

  it('keeps a verified partial report without opening Excel after cancellation', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controller = new AbortController();
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.execute.mockImplementation(async () => {
      controller.abort();
      return { workbookPath: path.join(prepared.outputDirectory, 'report.xlsx'), results: [], exitCode: 130, tempDirectory: prepared.tempRoot };
    });
    const result = await runOperator(prepared, controls, controller.signal);
    expect(result?.exitCode).toBe(130);
    expect(controls.openReport).not.toHaveBeenCalled();
    expect(controls.report.mock.calls.flat().join(' ')).toContain('report was saved');
  });

  it('preserves a completed report when Excel cannot open it', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.openReport.mockRejectedValue(new Error('Excel unavailable'));
    const result = await runOperator(prepared, controls);
    expect(result?.exitCode).toBe(0);
    expect(controls.openFolder).toHaveBeenCalledExactlyOnceWith(prepared.outputDirectory);
    expect(controls.report.mock.calls.flat().join(' ')).toContain('report is saved');
  });

  it('never opens a report when workbook creation fails', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.execute.mockRejectedValue(new Error('Workbook creation failed'));
    await expect(runOperator(prepared, controls)).rejects.toThrow('Workbook creation failed');
    expect(controls.openReport).not.toHaveBeenCalled();
    await (await acquireOperatorLock(prepared.stateRoot))();
  });

  it('stops before authentication for missing prerequisites or an unwritable report folder', async () => {
    await inputFiles();
    const prepared = await prepareOperatorRun(directory, path.join(directory, 'state'));
    const controls = actions(path.join(prepared.outputDirectory, 'report.xlsx'));
    controls.checkPrerequisites.mockRejectedValueOnce(new Error('Browser missing'));
    await expect(runOperator(prepared, controls)).rejects.toThrow('Browser missing');
    expect(controls.confirm).not.toHaveBeenCalled();
    await writeFile(path.join(directory, 'output'), 'blocked');
    await expect(runOperator(prepared, controls)).rejects.toThrow('report folder');
    expect(controls.authenticate).not.toHaveBeenCalled();
  });
});

describe('CLI and setup guards', () => {
  it('uses a single storage-state context and closes both context and browser', async () => {
    const context = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) } as unknown as Browser;
    const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
    const persistent = vi.spyOn(chromium, 'launchPersistentContext');
    const state = { cookies: [], origins: [] };
    const session = await openBrowserSession(config, directory, { headless: true, readOnly: true, storageState: state });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storageState: state, serviceWorkers: 'block' }));
    expect(persistent).not.toHaveBeenCalled();
    expect(session.context).toBe(context);
    await session.close();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('opens only the dedicated persistent Edge profile and requires its initial manual login', async () => {
    const profileConfig = { ...config, authenticationMode: 'persistentProfile' as const };
    await expect(loadAuthentication(profileConfig, directory)).rejects.toThrow('npm run login');
    const context = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
    const launch = vi.spyOn(chromium, 'launch');
    const persistent = vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(context);
    const session = await openBrowserSession(profileConfig, directory, { headless: false, readOnly: true });
    expect(persistent).toHaveBeenCalledExactlyOnceWith(path.join(directory, 'kiali-edge-profile'), expect.objectContaining({ channel: 'msedge', headless: false, serviceWorkers: 'block' }));
    expect(launch).not.toHaveBeenCalled();
    expect(session.context).toBe(context);
    await saveAuthentication(context, profileConfig, directory);
    await expect(loadAuthentication(profileConfig, directory)).resolves.toBeUndefined();
    await session.close();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('closes the browser after context setup failure without disclosing raw diagnostics', async () => {
    const browser = { newContext: vi.fn().mockRejectedValue(new Error('secret state details')), close: vi.fn().mockResolvedValue(undefined) } as unknown as Browser;
    vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
    await expect(openBrowserSession(config, directory, { headless: true })).rejects.toThrow('Unable to initialize the browser context');
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('defaults to the Excel service list', () => {
    expect(parseRunOptions(['node', 'tvt', '--release', 'Test Release']).configPath).toBe('services.xlsx');
  });

  it.each(['alternate.xlsx', 'alternate.csv'])('supports all requested arguments and separates %s from application settings', (configPath) => {
    expect(parseRunOptions(['node', 'tvt', '--release', 'Test Release', '--minutes', '30', '--headed', '--service', 'kafka-ui', '--config', configPath, '--settings', 'local.json', '--keep-temp', '--overwrite'])).toEqual({
      release: 'Test Release', minutes: 30, headed: true, service: 'kafka-ui',
      configPath, settingsPath: 'local.json', keepTemp: true, overwrite: true,
    });
  });

  it('rejects missing releases and invalid minutes', () => {
    expect(() => parseRunOptions(['node', 'tvt'])).toThrow('--release');
    expect(() => parseRunOptions(['node', 'tvt', '--release', 'test', '--minutes', '0'])).toThrow('1 and 1440');
    expect(() => parseRunOptions(['node', 'tvt', '--release', ' '])).toThrow('non-empty');
  });

  it('fails before launching a browser if authentication is missing', async () => {
    await expect(loadSession(path.join(directory, 'missing.json'))).rejects.toThrow('Authentication session not found. Run: npm run login');
  });

  it('does not echo corrupt authentication state', async () => {
    const filePath = path.join(directory, 'session.json');
    await writeFile(filePath, '{sensitive-value}');
    await expect(loadSession(filePath)).rejects.toThrow('Authentication session is invalid. Run: npm run login');
  });

  it('never reuses preserved release evidence directories', async () => {
    const first = await createRunTempDirectory(directory, '../../Test:Release');
    await mkdir(path.join(first, 'service'));
    const second = await createRunTempDirectory(directory, '../../Test:Release');
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(directory);
    expect(path.dirname(second)).toBe(directory);
  });

  it('selects one enabled service by exact name', async () => {
    const filePath = path.join(directory, 'services.csv');
    await writeFile(filePath, 'serviceName,namespace,workload,enabled\na,ns,a,true\nb,ns,b,false');
    expect(await loadServices(filePath, 'a')).toEqual([{ serviceName: 'a', namespace: 'ns', workload: 'a' }]);
    await expect(loadServices(filePath, 'b')).rejects.toThrow('not found among enabled');
  });
});