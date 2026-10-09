import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command, CommanderError } from 'commander';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { saveSession } from './auth.js';
import { loadConfig } from './config.js';
import { confirmKialiLoaded } from './kiali.js';
import { TvtError, safeErrorMessage } from './logger.js';

export async function login(settingsPath: string): Promise<void> {
  if (!stdin.isTTY) throw new TvtError('LOGIN', 'Run npm run login from an interactive terminal to confirm corporate authentication.');
  const config = await loadConfig(settingsPath);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const terminal = createInterface({ input: stdin, output: stdout });
  const controller = new AbortController();
  const interrupt = (): void => { controller.abort(); void browser?.close().catch(() => undefined); };
  terminal.on('SIGINT', interrupt);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      deviceScaleFactor: config.deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto(config.kialiBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMilliseconds });
    await terminal.question('Complete corporate authentication in Chromium, then press Enter here. Do not enter credentials in this terminal. ', { signal: controller.signal });
    await confirmKialiLoaded(page, config);
    await saveSession(context, fileURLToPath(new URL('../auth/kiali-session.json', import.meta.url)));
    console.log('Authentication session saved locally. You can now run npm run tvt.');
  } finally {
    terminal.off('SIGINT', interrupt);
    terminal.close();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

async function main(): Promise<void> {
  const command = new Command().name('login')
    .description('Open Chromium for manual corporate authentication and save a local Playwright session.')
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