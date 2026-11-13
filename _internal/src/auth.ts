import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { AuthenticationError, TvtError } from './logger.js';
import type { AppConfig } from './types.js';

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

export async function loadAuthentication(config: AppConfig, authDirectory: string): Promise<SessionState | undefined> {
  if (config.authenticationMode === 'storageState') return loadSession(path.join(authDirectory, 'kiali-session.json'));
  try {
    await access(path.join(authDirectory, 'kiali-edge-profile', '.authenticated'));
  } catch {
    throw new AuthenticationError('Dedicated Edge profile has not been initialized. Set authenticationMode to persistentProfile and run: npm run login');
  }
  return undefined;
}

export async function openBrowserSession(config: AppConfig, authDirectory: string, options: {
  headless: boolean;
  readOnly?: boolean;
  storageState?: SessionState | undefined;
}): Promise<BrowserSession> {
  const contextOptions = {
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    deviceScaleFactor: config.deviceScaleFactor,
    serviceWorkers: options.readOnly ? 'block' as const : 'allow' as const,
  };
  if (config.authenticationMode === 'persistentProfile') {
    const profileDirectory = path.join(authDirectory, 'kiali-edge-profile');
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDirectory, {
        ...contextOptions, channel: 'msedge', headless: options.headless,
      });
    } catch {
      throw new TvtError('EDGE_PROFILE', 'Unable to open the dedicated Microsoft Edge profile. Ensure Edge is installed and close any other TVT or login process using this profile.');
    }
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless: options.headless });
  try {
    const context = await browser.newContext({
      ...contextOptions,
      ...(options.storageState ? { storageState: options.storageState } : {}),
    });
    return {
      context,
      close: async () => {
        try { await context.close(); } finally { await browser.close(); }
      },
    };
  } catch {
    await browser.close().catch(() => undefined);
    throw new TvtError('BROWSER_CONTEXT', 'Unable to initialize the browser context. Check browser installation and rerun npm run login if the saved session is invalid.');
  }
}

export async function saveAuthentication(context: BrowserContext, config: AppConfig, authDirectory: string): Promise<void> {
  if (config.authenticationMode === 'storageState') {
    await saveSession(context, path.join(authDirectory, 'kiali-session.json'));
    return;
  }
  const profileDirectory = path.join(authDirectory, 'kiali-edge-profile');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(profileDirectory, '.authenticated'), 'Initialized by manual Kiali login.\n', { mode: 0o600 });
}

export async function loadSession(filePath: string): Promise<SessionState> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AuthenticationError('Authentication session not found. Run: npm run login');
    }
    throw new AuthenticationError('Authentication session cannot be read. Check file permissions and run: npm run login');
  }
  try {
    const state = JSON.parse(contents) as Partial<SessionState> | null;
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Invalid state');
    return state as SessionState;
  } catch {
    throw new AuthenticationError('Authentication session is invalid. Run: npm run login');
  }
}

export async function saveSession(context: BrowserContext, filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const state = await context.storageState({ indexedDB: true });
    await writeFile(staging, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(staging, filePath);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}