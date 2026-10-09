import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { AuthenticationError } from './logger.js';

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;

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