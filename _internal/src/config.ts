import { readFile } from 'node:fs/promises';
import { TvtError } from './logger.js';
import type { AppConfig, EnvironmentProfile } from './types.js';

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
  const authenticationMode = settings.authenticationMode ?? 'storageState';
  if (authenticationMode !== 'storageState' && authenticationMode !== 'persistentProfile') {
    throw new TvtError('CONFIG', 'authenticationMode must be storageState or persistentProfile.');
  }
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
    authenticationMode,
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

export function parseReleaseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TvtError('ARGUMENT', 'Release must be a non-empty, single-line label of at most 200 characters.');
  }
  return value;
}

export function parseEnvironmentProfiles(input: unknown): EnvironmentProfile[] {
  const entries = input && typeof input === 'object' && 'environments' in input ? input.environments : undefined;
  if (!Array.isArray(entries) || !entries.length) throw new TvtError('CONFIG', 'The environment file must contain a non-empty environments list.');
  const ids = new Set<string>();
  const targets = new Set<string>();
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new TvtError('CONFIG', 'Each environment must be a configured profile.');
    const profile = entry as Record<string, unknown>;
    if (typeof profile.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(profile.id)) {
      throw new TvtError('CONFIG', 'Environment IDs must start with a letter and contain at most 32 letters, digits, underscores, or hyphens.');
    }
    if (typeof profile.label !== 'string' || !profile.label.trim() || profile.label.length > 200 || /[\x00-\x1f\x7f]/.test(profile.label) || typeof profile.production !== 'boolean') {
      throw new TvtError('CONFIG', 'Each environment needs a non-empty display label and an explicit production true/false flag.');
    }
    const id = profile.id.toUpperCase();
    const kialiBaseUrl = validateBaseUrl(profile.kialiBaseUrl);
    if (ids.has(id) || targets.has(kialiBaseUrl)) throw new TvtError('CONFIG', 'Environment IDs and Kiali target URLs must be unique.');
    ids.add(id);
    targets.add(kialiBaseUrl);
    return { id, label: profile.label.trim(), kialiBaseUrl, production: profile.production };
  });
}

export function resolveEnvironment(defaults: unknown, profiles: readonly EnvironmentProfile[], environmentId: string): { profile: EnvironmentProfile; config: AppConfig } {
  const profile = profiles.find((candidate) => candidate.id === environmentId.trim().toUpperCase());
  if (!profile) throw new TvtError('CONFIG', 'The selected environment is not configured. Choose an approved environment in Run Settings.');
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new TvtError('CONFIG', 'Application defaults must be a JSON object.');
  return { profile, config: parseConfig({ ...defaults, environment: profile.label, kialiBaseUrl: profile.kialiBaseUrl }) };
}

export async function loadEnvironmentSelection(settingsPath: string, profilesPath: string, environmentId: string): Promise<{ profile: EnvironmentProfile; config: AppConfig }> {
  let defaults: unknown;
  let profiles: unknown;
  try {
    defaults = JSON.parse(await readFile(settingsPath, 'utf8'));
    profiles = JSON.parse(await readFile(profilesPath, 'utf8'));
  } catch {
    throw new TvtError('CONFIG', 'Unable to read application defaults or environments.json. Ask the TVT maintainer to check the installation.');
  }
  return resolveEnvironment(defaults, parseEnvironmentProfiles(profiles), environmentId);
}