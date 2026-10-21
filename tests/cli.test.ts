import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAuthentication, loadSession, openBrowserSession, saveAuthentication } from '../src/auth.js';
import { parseConfig } from '../src/config.js';
import { parseRunOptions } from '../src/run-tvt.js';
import { createRunTempDirectory } from '../src/screenshots.js';
import { loadServices } from '../src/services.js';

let directory: string;
const config = parseConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kiali-cli-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

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