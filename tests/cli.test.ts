import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSession } from '../src/auth.js';
import { parseRunOptions } from '../src/run-tvt.js';
import { createRunTempDirectory } from '../src/screenshots.js';
import { loadServices } from '../src/services.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kiali-cli-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('CLI and setup guards', () => {
  it('supports all requested arguments and separates CSV from application settings', () => {
    expect(parseRunOptions(['node', 'tvt', '--release', 'Test Release', '--minutes', '30', '--headed', '--service', 'kafka-ui', '--config', 'alternate.csv', '--settings', 'local.json', '--keep-temp', '--overwrite'])).toEqual({
      release: 'Test Release', minutes: 30, headed: true, service: 'kafka-ui',
      configPath: 'alternate.csv', settingsPath: 'local.json', keepTemp: true, overwrite: true,
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