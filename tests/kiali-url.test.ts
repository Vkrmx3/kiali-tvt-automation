import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { isAuthenticationUrl, workloadUrl } from '../src/kiali.js';
import { logDiagnosticUrl, safeDiagnosticUrl } from '../src/logger.js';

const config = parseConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
const service = { serviceName: 'app', namespace: 'ns /+', workload: 'app/#?' };

describe('authentication URL evidence and URL logging', () => {
  it.each([
    'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?code=secret',
    'https://login.live.com/',
    'https://identity.example/adfs/ls/',
    'https://identity.example/realms/team/protocol/openid-connect/auth',
    'https://identity.example/oauth2/authorize',
    'https://identity.example/openid/login',
    `${config.kialiBaseUrl}/login`,
  ])('recognizes a known authentication URL: %s', (url) => {
    expect(isAuthenticationUrl(url, config.kialiBaseUrl)).toBe(true);
  });

  it.each([
    config.kialiBaseUrl,
    `${config.kialiBaseUrl}/namespaces/auth/workloads/login?tab=logs&code=401`,
    `${config.kialiBaseUrl}/namespaces/backoffice/workloads/service?tab=logs#unauthorized`,
    'https://documentation.example/workloads',
    'https://login.microsoftonline.com.untrusted.example/workloads',
    'about:blank',
  ])('does not infer authentication from ordinary Kiali pages, query text, or another origin: %s', (url) => {
    expect(isAuthenticationUrl(url, config.kialiBaseUrl)).toBe(false);
  });

  it('logs only origin and pathname, without credentials, query parameters, or fragments', () => {
    expect(safeDiagnosticUrl('https://user:password@login.example/oauth2/authorize?token=secret#private')).toBe('https://login.example/oauth2/authorize');
    expect(safeDiagnosticUrl('data:text/plain,secret')).toBe('[non-HTTP page]');
    expect(safeDiagnosticUrl('secret invalid input')).toBe('[invalid URL]');
    const logger = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logDiagnosticUrl('https://user:password@login.example/oauth2/authorize?token=secret#private', 'Current');
      expect(logger).toHaveBeenCalledExactlyOnceWith('Current page: https://login.example/oauth2/authorize');
    } finally {
      logger.mockRestore();
    }
  });
});

describe('direct workload URLs', () => {
  it('encodes each path segment and sets all Overview parameters', () => {
    const url = new URL(workloadUrl(config, service, 'info'));
    expect(url.pathname).toBe('/kiali/console/namespaces/ns%20%2F%2B/workloads/app%2F%23%3F');
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: 'info', duration: '300', refresh: '0', rangeDuration: '300' });
  });

  it('uses 15 minutes by default and overrides both logs durations', () => {
    const defaultUrl = new URL(workloadUrl(config, service, 'logs'));
    expect(defaultUrl.searchParams.get('rangeDuration')).toBe('900');
    const overridden = new URL(workloadUrl(config, service, 'logs', 1800));
    expect(Object.fromEntries(overridden.searchParams)).toEqual({ tab: 'logs', duration: '1800', refresh: '0', rangeDuration: '1800' });
  });

  it('rejects path normalization segments', () => {
    expect(() => workloadUrl(config, { ...service, namespace: '..' }, 'info')).toThrow('non-relative');
  });
});