import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { workloadUrl } from '../src/kiali.js';

const config = parseConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
const service = { serviceName: 'app', namespace: 'ns /+', workload: 'app/#?' };

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