import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrap = await import(new URL('../setup.mjs', import.meta.url).href);
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tvt-setup-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function runtimeFixture() {
  const internal = path.join(directory, '_internal');
  await mkdir(internal);
  const runtime = {
    version: '22.23.4', platform: 'win32', arch: 'x64',
    url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip',
    sha256: checksum('verified archive'), executableSha256: checksum('verified node'),
  };
  await writeFile(path.join(internal, 'setup-manifest.json'), JSON.stringify({ schemaVersion: 1, mode: 'source', runtime }));
  const download = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, 'verified archive'); });
  const extract = vi.fn(async (_archive: string, destination: string) => {
    const extracted = path.join(destination, 'node-v22.23.4-win-x64');
    await mkdir(path.join(extracted, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(path.join(extracted, 'node.exe'), 'verified node');
    await writeFile(path.join(extracted, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'fixture npm');
    await writeFile(path.join(extracted, 'LICENSE'), 'fixture license');
  });
  const run = vi.fn(async () => ({ exitCode: 0, stdout: 'v22.23.4\n', stderr: '' }));
  return { internal, runtime, download, extract, run, report: vi.fn() };
}

describe('portable setup runtime', () => {
  it('installs only verified runtime bytes and reuses the installation on later checks', async () => {
    const fixture = await runtimeFixture();
    const first = await bootstrap.prepareRuntime(fixture.internal, fixture);
    expect(await readFile(first.nodePath, 'utf8')).toBe('verified node');
    expect(await readFile(first.npmCliPath, 'utf8')).toBe('fixture npm');
    expect(first.installed).toBe(true);
    const second = await bootstrap.prepareRuntime(fixture.internal, fixture);
    expect(second.installed).toBe(false);
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(fixture.extract).toHaveBeenCalledOnce();
    expect((await readdir(fixture.internal)).sort()).toEqual(['runtime', 'setup-manifest.json']);
  });

  it('rejects an incorrect archive checksum before extraction or execution', async () => {
    const fixture = await runtimeFixture();
    fixture.download.mockImplementation(async (_url, destination) => { await writeFile(destination, 'corrupt archive'); });
    await expect(bootstrap.prepareRuntime(fixture.internal, fixture)).rejects.toThrow('checksum');
    expect(fixture.extract).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(await readdir(fixture.internal)).toEqual(['setup-manifest.json']);
  });

  it('rejects a replaced executable before publishing or running it', async () => {
    const fixture = await runtimeFixture();
    const extract = async (archive: string, destination: string) => {
      await fixture.extract(archive, destination);
      await writeFile(path.join(destination, 'node-v22.23.4-win-x64', 'node.exe'), 'unexpected binary');
    };
    await expect(bootstrap.prepareRuntime(fixture.internal, { ...fixture, extract })).rejects.toThrow('checksum');
    expect(fixture.run).not.toHaveBeenCalled();
    expect(await readdir(fixture.internal)).toEqual(['setup-manifest.json']);
  });
});

async function setupFixture(mode: 'source' | 'compiled' = 'source') {
  const fixture = await runtimeFixture();
  const runtime = await bootstrap.prepareRuntime(fixture.internal, fixture) as { nodePath: string; npmCliPath: string; installed: boolean };
  const manifestPath = path.join(fixture.internal, 'setup-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.mode = mode;
  manifest.dependencies = { playwright: '1.0.0' };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(fixture.internal, 'package.json'), JSON.stringify({ type: 'module', dependencies: { playwright: '1.0.0' }, devDependencies: { tsx: '1.0.0' } }));
  await writeFile(path.join(fixture.internal, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': {}, 'node_modules/playwright': { version: '1.0.0' }, 'node_modules/tsx': { version: '1.0.0', dev: true },
  } }));
  await writeFile(path.join(fixture.internal, 'config.json'), JSON.stringify({ authenticationMode: 'storageState' }));
  const entryDirectory = path.join(fixture.internal, mode === 'source' ? 'src' : 'app');
  await mkdir(entryDirectory);
  await writeFile(path.join(entryDirectory, mode === 'source' ? 'operator.ts' : 'operator.js'), 'fixture entry');
  const workbook = path.join(directory, 'services.xlsx');
  await writeFile(workbook, 'unchanged input');
  const primary = path.join(directory, 'browser.exe');
  const headless = path.join(directory, 'headless.exe');
  const writeDependencies = async () => {
    for (const name of mode === 'source' ? ['playwright', 'tsx'] : ['playwright']) {
      const location = path.join(fixture.internal, 'node_modules', name);
      await mkdir(location, { recursive: true });
      await writeFile(path.join(location, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
      await writeFile(path.join(location, 'index.js'), 'module.exports = {};');
      await writeFile(path.join(location, 'cli.js'), 'fixture CLI');
    }
  };
  const smoke = vi.fn(async () => { await access(headless); return [primary, headless]; });
  const browserProvider = vi.fn(async () => ({ kind: 'chromium', identity: 'fixture-chromium-1', executablePath: primary, smoke }));
  const run = vi.fn(async (_executable: string, args: string[]) => {
    if (args[0] === runtime.npmCliPath) await writeDependencies();
    if (args.includes('install')) { await writeFile(primary, 'browser'); await writeFile(headless, 'headless browser'); }
    return { exitCode: 0, stdout: 'fixture application ready', stderr: '' };
  });
  return { ...fixture, ...runtime, run, browserProvider, smoke, writeDependencies, workbook, primary, headless };
}

describe('automatic first-run setup', () => {
  it.runIf(process.platform === 'win32').each(['absolute', 'relative'])('runs the actual CMD setup-only path using a %s path without global Node or npm', async (invocation) => {
    const root = path.join(directory, 'folder with spaces');
    const internal = path.join(root, '_internal');
    await mkdir(path.join(internal, 'runtime'), { recursive: true });
    await copyFile(process.execPath, path.join(internal, 'runtime', 'node.exe'));
    await writeFile(path.join(internal, 'setup.mjs'), `
import path from 'node:path';
if (!process.argv.includes('--setup-only')) throw new Error('TVT must not run in this check');
console.log('CMD_SETUP_ONLY_OK');
console.log('CMD_DATA_DIRECTORY=' + path.resolve(process.argv[process.argv.indexOf('--data-directory') + 1]));
`);
    await copyFile(new URL('../../Run-TVT.cmd', import.meta.url), path.join(root, 'Run-TVT.cmd'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const launcher = invocation === 'relative' ? '.\\Run-TVT.cmd' : path.join(root, 'Run-TVT.cmd');
    const result = await promisify(execFile)(path.join(env.PATH, 'cmd.exe'), ['/d', '/c', `call "${launcher}" --setup-only`], {
      cwd: invocation === 'relative' ? root : os.tmpdir(), env, timeout: 15000, windowsVerbatimArguments: true,
    });
    expect(result.stdout).toContain('CMD_SETUP_ONLY_OK');
    expect(result.stdout).toContain(`CMD_DATA_DIRECTORY=${root}`);
    expect(result.stdout).not.toContain('Press any key');
  });

  it('installs missing components once and makes no process or install calls on a ready second run', async () => {
    const fixture = await setupFixture();
    const first = await bootstrap.ensureSetup(fixture.internal, fixture);
    expect(first.dependenciesInstalled).toBe(true);
    expect(first.browserInstalled).toBe(true);
    expect(fixture.run.mock.calls.filter((call) => call[1].includes('ci'))).toHaveLength(1);
    expect(fixture.run.mock.calls.filter((call) => call[1].includes('install'))).toHaveLength(1);
    const calls = fixture.run.mock.calls.length;
    const second = await bootstrap.ensureSetup(fixture.internal, fixture);
    expect(second.dependenciesInstalled).toBe(false);
    expect(second.browserInstalled).toBe(false);
    expect(fixture.run).toHaveBeenCalledTimes(calls);
    expect(fixture.smoke).toHaveBeenCalledOnce();
    expect(await readFile(fixture.workbook, 'utf8')).toBe('unchanged input');
  });

  it('repairs missing dependencies even when a previous readiness record exists', async () => {
    const fixture = await setupFixture();
    await bootstrap.ensureSetup(fixture.internal, fixture);
    await rm(path.join(fixture.internal, 'node_modules', 'tsx'), { recursive: true });
    expect((await bootstrap.ensureSetup(fixture.internal, fixture)).dependenciesInstalled).toBe(true);
    expect(fixture.run.mock.calls.filter((call) => call[1].includes('ci'))).toHaveLength(2);
  });

  it('repairs a missing headless browser without reinstalling dependencies', async () => {
    const fixture = await setupFixture();
    await bootstrap.ensureSetup(fixture.internal, fixture);
    await rm(fixture.headless);
    const next = await bootstrap.ensureSetup(fixture.internal, fixture);
    expect(next.dependenciesInstalled).toBe(false);
    expect(next.browserInstalled).toBe(true);
    expect(fixture.run.mock.calls.filter((call) => call[1].includes('ci'))).toHaveLength(1);
  });

  it('keeps compiled packages independent of npm and never installs development dependencies into them', async () => {
    const fixture = await setupFixture('compiled');
    await fixture.writeDependencies();
    await rm(path.join(fixture.internal, 'package-lock.json'));
    await rm(fixture.npmCliPath);
    const result = await bootstrap.ensureSetup(fixture.internal, fixture);
    expect(result.dependenciesInstalled).toBe(false);
    expect(fixture.run.mock.calls.some((call) => call[1].includes('ci'))).toBe(false);
    await rm(path.join(fixture.internal, 'node_modules', 'playwright'), { recursive: true });
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).rejects.toThrow('incomplete');
    expect(fixture.run.mock.calls.some((call) => call[1].includes('ci'))).toBe(false);
  });

  it('revalidates changed compiled metadata without attempting an npm install', async () => {
    const fixture = await setupFixture('compiled');
    await fixture.writeDependencies();
    await bootstrap.ensureSetup(fixture.internal, fixture);
    const manifestPath = path.join(fixture.internal, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = '1.0.1';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).resolves.toMatchObject({ dependenciesInstalled: false });
    expect(fixture.run.mock.calls.some((call) => call[1].includes('ci'))).toBe(false);
  });

  it('hands off to TVT only after setup and keeps the setup lock until TVT exits', async () => {
    const fixture = await setupFixture();
    const working = fixture.run.getMockImplementation()!;
    fixture.run.mockImplementation(async (executable, args) => {
      if (args.includes('--data-directory')) {
        await expect(bootstrap.acquireSetupLock(fixture.internal)).rejects.toThrow('already in use');
        expect(args.at(-1)).toBe(directory);
        return { exitCode: 130, stdout: '', stderr: '' };
      }
      return working(executable, args);
    });
    const result = await bootstrap.ensureSetup(fixture.internal, { ...fixture, launch: true, dataDirectory: directory });
    expect(result.exitCode).toBe(130);
    const release = await bootstrap.acquireSetupLock(fixture.internal);
    await release();
  });

  it('does not install Chromium or change authentication mode when Edge is configured', async () => {
    const fixture = await setupFixture();
    await writeFile(path.join(fixture.internal, 'config.json'), JSON.stringify({ authenticationMode: 'persistentProfile' }));
    await writeFile(fixture.primary, 'installed Edge');
    fixture.browserProvider.mockResolvedValue({ kind: 'edge', identity: 'fixture-edge', executablePath: fixture.primary, smoke: fixture.smoke });
    await bootstrap.ensureSetup(fixture.internal, fixture);
    expect(fixture.run.mock.calls.some((call) => call[1].includes('install'))).toBe(false);
    expect(fixture.smoke).not.toHaveBeenCalled();
    await rm(fixture.primary);
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).rejects.toThrow('Microsoft Edge');
  });

  it('does not mark failed installs ready or disclose installer output and allows a later retry', async () => {
    const fixture = await setupFixture();
    const working = fixture.run.getMockImplementation()!;
    fixture.run.mockImplementation(async (executable, args) => args.includes('ci')
      ? { exitCode: 1, stdout: '', stderr: 'CERTIFICATE_VERIFY_FAILED https://user:secret@proxy.invalid' }
      : working(executable, args));
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).rejects.toThrow('certificate');
    expect(fixture.report.mock.calls.flat().join(' ')).not.toContain('secret');
    await expect(readFile(path.join(fixture.internal, '.setup-state.json'))).rejects.toThrow();
    fixture.run.mockImplementation(working);
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).resolves.toMatchObject({ dependenciesInstalled: true });
  });

  it('rejects concurrent setup and releases its lock after cancellation', async () => {
    const fixture = await setupFixture();
    const release = await bootstrap.acquireSetupLock(fixture.internal);
    try { await expect(bootstrap.ensureSetup(fixture.internal, fixture)).rejects.toThrow('already in use'); }
    finally { await release(); }
    const controller = new AbortController();
    controller.abort();
    await expect(bootstrap.ensureSetup(fixture.internal, { ...fixture, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(bootstrap.ensureSetup(fixture.internal, fixture)).resolves.toBeDefined();
  });

  it('does not continue to the browser or TVT after cancellation during dependency installation', async () => {
    const fixture = await setupFixture();
    const controller = new AbortController();
    const working = fixture.run.getMockImplementation()!;
    fixture.run.mockImplementation(async (executable, args) => {
      const result = await working(executable, args);
      if (args.includes('ci')) controller.abort();
      return result;
    });
    await expect(bootstrap.ensureSetup(fixture.internal, { ...fixture, launch: true, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fixture.browserProvider).not.toHaveBeenCalled();
    expect(fixture.run.mock.calls.some((call) => call[1].includes('--data-directory'))).toBe(false);
    await expect(readFile(path.join(fixture.internal, '.setup-state.json'))).rejects.toThrow();
    const release = await bootstrap.acquireSetupLock(fixture.internal);
    await release();
  });

  it('passes cancellation into the fresh browser check', async () => {
    const fixture = await setupFixture();
    const controller = new AbortController();
    await bootstrap.ensureSetup(fixture.internal, { ...fixture, signal: controller.signal });
    expect(fixture.smoke).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it('terminates only its setup subprocess when the phase exceeds its deadline', async () => {
    await expect(bootstrap.runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMilliseconds: 100 })).rejects.toThrow('took too long');
  });
});