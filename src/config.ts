import { readFile } from 'node:fs/promises';
import { TvtError } from './logger.js';
import type { AppConfig } from './types.js';

function integerSetting(settings: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = settings[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TvtError('CONFIG', `${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TvtError('CONFIG', 'kialiBaseUrl must be a URL.');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TvtError('CONFIG', 'kialiBaseUrl must be a valid absolute URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TvtError('CONFIG', 'kialiBaseUrl must use HTTPS (HTTP is allowed only for loopback tests).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TvtError('CONFIG', 'kialiBaseUrl must not contain credentials, query parameters, or fragments.');
  }
  return url.href.replace(/\/+$/g, '');
}

export function parseConfig(input: unknown, baseUrlOverride?: string): AppConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TvtError('CONFIG', 'Configuration must be a JSON object.');
  }
  const settings = input as Record<string, unknown>;
  const environment = settings.environment ?? 'Production';
  if (typeof environment !== 'string' || !environment.trim() || environment.length > 200 || /[\x00-\x1f\x7f]/.test(environment)) {
    throw new TvtError('CONFIG', 'environment must be a non-empty, single-line label of at most 200 characters.');
  }
  if (typeof settings.defaultHeadless !== 'boolean') throw new TvtError('CONFIG', 'defaultHeadless must be true or false.');
  const scale = settings.deviceScaleFactor;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 3) {
    throw new TvtError('CONFIG', 'deviceScaleFactor must be a number between 0.5 and 3.');
  }
  return {
    environment: environment.trim(),
    kialiBaseUrl: validateBaseUrl(baseUrlOverride ?? settings.kialiBaseUrl),
    overviewDurationSeconds: integerSetting(settings, 'overviewDurationSeconds', 1, 86400),
    logsDurationSeconds: integerSetting(settings, 'logsDurationSeconds', 60, 86400),
    pageTimeoutMilliseconds: integerSetting(settings, 'pageTimeoutMilliseconds', 1000, 600000),
    renderWaitMilliseconds: integerSetting(settings, 'renderWaitMilliseconds', 0, 60000),
    viewportWidth: integerSetting(settings, 'viewportWidth', 640, 3840),
    viewportHeight: integerSetting(settings, 'viewportHeight', 480, 2160),
    deviceScaleFactor: scale,
    defaultHeadless: settings.defaultHeadless,
  };
}

export async function loadConfig(filePath: string, baseUrlOverride = process.env.KIALI_BASE_URL): Promise<AppConfig> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new TvtError('CONFIG', 'Unable to read settings. Check that the settings file exists and contains valid JSON.');
  }
  return parseConfig(input, baseUrlOverride);
}

export function parseMinutes(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
    throw new TvtError('ARGUMENT', 'Log period must be an integer between 1 and 1440 minutes.');
  }
  return Number(value);
}