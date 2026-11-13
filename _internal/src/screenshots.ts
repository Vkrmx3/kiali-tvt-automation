import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Frame, Page } from 'playwright';
import { TvtError } from './logger.js';
import { safePathSegment } from './naming.js';
import type { AppConfig } from './types.js';

export async function createRunTempDirectory(tempRoot: string, release: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const base = safePathSegment(release, 'Release');
  let candidate = path.join(tempRoot, base);
  let sequence = 0;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  while (true) {
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      candidate = path.join(tempRoot, `${base}-${timestamp}-${++sequence}`);
    }
  }
}

export async function captureAuthenticationCheck(page: Page, config: AppConfig, directory: string): Promise<void> {
  const bytes = await page.screenshot({
    type: 'png', fullPage: false, timeout: Math.min(config.pageTimeoutMilliseconds, 10000),
    mask: [page.locator('form, input, textarea, [contenteditable="true"], [role="textbox"], img, canvas, svg')],
    maskColor: '#000000',
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'authentication-check.png'), bytes, { mode: 0o600 });
}

export async function captureScreenshot(page: Page, config: AppConfig, destination: string, kind: 'overview' | 'logs' | 'error', verify: () => Promise<void>): Promise<string[]> {
  await verify();
  let navigated = false;
  const onNavigation = (frame: Frame): void => { if (frame === page.mainFrame()) navigated = true; };
  page.on('framenavigated', onNavigation);
  try {
    const notes: string[] = [];
    let fullPage = false;
    if (kind === 'overview') {
      const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      fullPage = height <= config.viewportHeight * 3;
      if (!fullPage) notes.push('Overview exceeds three viewport heights; captured the visible page to keep the image readable.');
    }
    const bytes = await page.screenshot({ type: 'png', fullPage, timeout: config.pageTimeoutMilliseconds });
    await verify();
    if (navigated) throw new TvtError('CAPTURE_NAVIGATION', 'Page changed during capture. No potentially misleading screenshot was saved.');
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    return notes;
  } finally {
    page.off('framenavigated', onNavigation);
  }
}