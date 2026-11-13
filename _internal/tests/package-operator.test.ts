import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageOperator } from '../scripts/package-operator.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'tvt-package-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function sourceProject(): Promise<string> {
  const root = path.join(directory, 'source project');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture-tvt', version: '1.0.0', type: 'module', dependencies: { 'runtime-dep': '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'fixture-tvt' },
      'node_modules/runtime-dep': { version: '1.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
    } }),
    'setup-manifest.json': JSON.stringify({ schemaVersion: 1, mode: 'source', runtime: {
      version: '22.23.4', platform: 'win32', arch: 'x64',
      url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip',
      sha256: '0'.repeat(64), executableSha256: createHash('sha256').update('fixture portable node').digest('hex'),
    } }),
    'setup.mjs': await readFile(new URL('../setup.mjs', import.meta.url), 'utf8'),
    'Run-TVT.cmd': await readFile(new URL('../../Run-TVT.cmd', import.meta.url), 'utf8'),
    'runtime/node.exe': 'fixture portable node',
    'runtime/node_modules/npm/bin/npm-cli.js': 'fixture portable npm',
    'runtime/LICENSE': 'fixture runtime license',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmit: true }, include: ['src/**/*.ts', 'tests/**/*.ts'] }),
    'src/operator.ts': 'import { value } from "runtime-dep"; console.log(value);',
    'tests/not-shipped.test.ts': 'const invalid: number = "Not an application source file";',
    'node_modules/runtime-dep/package.json': JSON.stringify({ name: 'runtime-dep', version: '1.0.0', type: 'module', main: 'index.js', types: 'index.d.ts' }),
    'node_modules/runtime-dep/index.js': 'export const value = "ISOLATED_PACKAGE_OK";',
    'node_modules/runtime-dep/index.d.ts': 'export declare const value: string;',
    'node_modules/dev-only/package.json': JSON.stringify({ name: 'dev-only', version: '1.0.0' }),
    'config.json': JSON.stringify({ fixture: 'config' }),
    'environments.json': JSON.stringify({ fixture: 'profiles' }),
    'services.xlsx': 'operator input bytes',
    'LICENSE': 'Fixture license',
    'auth/kiali-session.json': 'DO_NOT_SHIP_SESSION',
    'temp/screenshot.png': 'DO_NOT_SHIP_EVIDENCE',
    'output/old-report.xlsx': 'DO_NOT_SHIP_OLD_REPORT',
    '.env': 'DO_NOT_SHIP_SETTINGS',
  };
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

describe('operator distribution', () => {
  it('creates a minimal outer folder and a relocatable runtime without source-project state', async () => {
    const root = await sourceProject();
    const destination = path.join(root, 'dist', 'TVT');
    const result = await packageOperator(root, destination);
    expect(result.directory).toBe(destination);
    expect((await readdir(destination)).sort()).toEqual(['Run-TVT.cmd', 'START-HERE.txt', '_internal', 'output', 'services.xlsx']);
    expect(await readFile(path.join(destination, 'services.xlsx'))).toEqual(await readFile(path.join(root, 'services.xlsx')));
    expect(await readdir(path.join(destination, 'output'))).toEqual([]);
    expect(await readFile(path.join(destination, '_internal', 'config.json'))).toEqual(await readFile(path.join(root, 'config.json')));
    expect(await readdir(path.join(destination, '_internal', 'node_modules'))).toEqual(['runtime-dep']);
    expect(await readdir(path.join(destination, '_internal', 'app'))).toEqual(['operator.js']);
    for (const excluded of ['auth', 'temp', 'tests', 'src', '.env']) {
      await expect(lstat(path.join(destination, excluded))).rejects.toThrow();
      await expect(lstat(path.join(destination, '_internal', excluded))).rejects.toThrow();
    }
    const launcher = await readFile(path.join(destination, 'Run-TVT.cmd'), 'utf8');
    expect(launcher).toContain('_internal\\runtime\\node.exe');
    expect(launcher).toContain('_internal\\setup.mjs');
    expect(launcher).toContain('set "TVT_ROOT=%~dp0"');
    expect(launcher).toContain('--data-directory "%TVT_ROOT%."');
    expect(launcher).not.toContain('tsx');
    expect(await readFile(path.join(destination, '_internal', 'runtime', 'node.exe'), 'utf8')).toBe('fixture portable node');
    const setup = JSON.parse(await readFile(path.join(destination, '_internal', 'setup-manifest.json'), 'utf8'));
    expect(setup.mode).toBe('compiled');
    expect(setup.dependencies).toEqual({ 'runtime-dep': '1.0.0' });
    await expect(lstat(path.join(destination, '_internal', '.setup-state.json'))).rejects.toThrow();
    const moved = path.join(directory, 'operator folder with spaces');
    await rename(destination, moved);
    const output = await promisify(execFile)(process.execPath, [path.join(moved, '_internal', 'app', 'operator.js')], { cwd: os.tmpdir() });
    expect(output.stdout).toContain('ISOLATED_PACKAGE_OK');
  });

  it('never overwrites an existing operator folder', async () => {
    const root = await sourceProject();
    const destination = path.join(directory, 'existing operator folder');
    await mkdir(destination);
    await writeFile(path.join(destination, 'services.xlsx'), 'operator edits');
    await expect(packageOperator(root, destination)).rejects.toThrow('already exists');
    expect(await readFile(path.join(destination, 'services.xlsx'), 'utf8')).toBe('operator edits');
  });

  it('packages the outer workbook when the development application lives under _internal', async () => {
    const root = await sourceProject();
    const operatorDirectory = path.join(directory, 'operator root');
    const applicationDirectory = path.join(operatorDirectory, '_internal');
    await mkdir(operatorDirectory);
    await rename(root, applicationDirectory);
    await rename(path.join(applicationDirectory, 'services.xlsx'), path.join(operatorDirectory, 'services.xlsx'));
    await rename(path.join(applicationDirectory, 'Run-TVT.cmd'), path.join(operatorDirectory, 'Run-TVT.cmd'));
    const destination = path.join(applicationDirectory, 'dist', 'TVT');
    await packageOperator(applicationDirectory, destination);
    expect(await readFile(path.join(destination, 'services.xlsx'), 'utf8')).toBe('operator input bytes');
    expect((await readdir(operatorDirectory)).sort()).toEqual(['Run-TVT.cmd', '_internal', 'services.xlsx']);
  });

  it('does not leave a partial package when a required runtime dependency is missing', async () => {
    const root = await sourceProject();
    const destination = path.join(directory, 'incomplete');
    await rm(path.join(root, 'node_modules', 'runtime-dep'), { recursive: true });
    await expect(packageOperator(root, destination)).rejects.toThrow();
    await expect(readdir(destination)).rejects.toThrow();
  });
});