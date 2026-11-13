import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command, CommanderError } from 'commander';
import { loadAuthentication, openBrowserSession, saveAuthentication, type BrowserSession, type SessionState } from './auth.js';
import { loadConfig } from './config.js';
import { confirmKialiLoaded, enableReadOnlyRequests, getAuthenticationError } from './kiali.js';
import { AuthenticationError, TvtError, safeErrorMessage } from './logger.js';
import type { AppConfig } from './types.js';

export async function login(settingsPath: string): Promise<void> {
  if (!stdin.isTTY) throw new TvtError('LOGIN', 'Run npm run login from an interactive terminal to confirm corporate authentication.');
  const config = await loadConfig(settingsPath);
  const authDirectory = fileURLToPath(new URL('../auth', import.meta.url));
  let session: BrowserSession | undefined;
  const terminal = createInterface({ input: stdin, output: stdout });
  const controller = new AbortController();
  const interrupt = (): void => { controller.abort(); void session?.close().catch(() => undefined); };
  terminal.on('SIGINT', interrupt);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    session = await openBrowserSession(config, authDirectory, { headless: false });
    if (controller.signal.aborted) throw new TvtError('INTERRUPTED', 'Login was interrupted.');
    const page = session.context.pages()[0] ?? await session.context.newPage();
    await page.goto(config.kialiBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMilliseconds });
    await terminal.question('Complete corporate authentication in the browser, then press Enter here. Do not enter credentials in this terminal. ', { signal: controller.signal });
    await confirmKialiLoaded(page, config);
    await saveAuthentication(session.context, config, authDirectory);
    console.log('Authentication session saved locally. You can now run npm run tvt.');
  } finally {
    terminal.off('SIGINT', interrupt);
    terminal.close();
    await session?.close().catch(() => undefined);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

export async function ensureOperatorAuthentication(config: AppConfig, authDirectory: string, options: {
  signal?: AbortSignal;
  report?: (message: string) => void;
  timeoutMilliseconds?: number;
  openSession?: typeof openBrowserSession;
} = {}): Promise<void> {
  if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
  const report = options.report ?? console.log;
  const openSession = options.openSession ?? openBrowserSession;
  let savedState: SessionState | undefined;
  let initialized = true;
  try {
    savedState = await loadAuthentication(config, authDirectory);
  } catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
    initialized = false;
  }
  const checkSession = async (interactive: boolean): Promise<boolean> => {
    if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
    const session = await openSession(config, authDirectory, { headless: !interactive, readOnly: !interactive, storageState: interactive ? undefined : savedState });
    const interrupt = (): void => { void session.close().catch(() => undefined); };
    options.signal?.addEventListener('abort', interrupt, { once: true });
    try {
      if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
      if (!interactive) await enableReadOnlyRequests(session.context);
      const page = session.context.pages()[0] ?? await session.context.newPage();
      const response = await page.goto(config.kialiBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMilliseconds });
      const loginPage = await getAuthenticationError(page, config);
      if (!interactive && loginPage) return false;
      if (!loginPage && response && response.status() >= 400) throw new TvtError('KIALI_ACCESS', `Kiali returned HTTP ${response.status()}. Check network access and permissions; no login failure was assumed.`);
      if (!interactive) {
        try {
          await confirmKialiLoaded(page, config);
        } catch (error) {
          if (await getAuthenticationError(page, config)) return false;
          throw new TvtError('KIALI_ACCESS', `The selected Kiali site could not be verified. ${safeErrorMessage(error)}`);
        }
        await saveAuthentication(session.context, config, authDirectory);
        return true;
      }
      const deadline = Date.now() + (options.timeoutMilliseconds ?? 300000);
      while (Date.now() < deadline) {
        if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
        if (page.isClosed()) throw new TvtError('INTERRUPTED', 'The login browser was closed before authentication completed.');
        try {
          await confirmKialiLoaded(page, { ...config, pageTimeoutMilliseconds: Math.max(1, Math.min(1000, deadline - Date.now())) });
          if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
          await saveAuthentication(session.context, config, authDirectory);
          return true;
        } catch (error) {
          if (!(error instanceof AuthenticationError)) throw error;
        }
        await page.waitForTimeout(Math.max(1, Math.min(250, deadline - Date.now())));
      }
      throw new TvtError('AUTHENTICATION', 'Login was not completed in time. Run TVT again and complete SSO/MFA in the browser.');
    } catch (error) {
      if (options.signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', interrupt);
      await session.close().catch(() => undefined);
    }
  };
  if (initialized) {
    report('Checking the saved login for the selected environment...');
    if (await checkSession(false)) {
      report('Saved login confirmed.');
      return;
    }
  }
  report('Complete corporate SSO/MFA in the browser. TVT will continue automatically; do not type credentials into this window.');
  await checkSession(true);
  report('Login confirmed. Continuing TVT...');
}

async function main(): Promise<void> {
  const command = new Command().name('login')
    .description('Open the configured browser for manual corporate authentication and retain its dedicated local session.')
    .option('--settings <path>', 'application settings JSON path', 'config.json')
    .configureOutput({ writeErr: () => undefined }).exitOverride();
  try {
    command.parse(process.argv);
    await login(path.resolve(command.opts<{ settings: string }>().settings));
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed') return;
      console.error('Invalid arguments. See: npm run login -- --help');
    } else {
      console.error(safeErrorMessage(error));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();