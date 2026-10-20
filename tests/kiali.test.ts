import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { PNG } from 'pngjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectServices } from '../src/collect.js';
import { parseConfig } from '../src/config.js';
import { assertAuthenticated, assertWorkloadView, enableReadOnlyRequests, isAuthenticationPage, prepareWorkloadPage } from '../src/kiali.js';
import { runTvt } from '../src/run-tvt.js';
import { captureScreenshot } from '../src/screenshots.js';
import { verifyWorkbook } from '../src/workbook.js';
import type { AppConfig, RunOptions, ServiceResult } from '../src/types.js';

let browser: Browser;
let context: BrowserContext;
let server: Server;
let config: AppConfig;
let directory: string;
let requests: Array<{ method: string; pathname: string }>;
const baseSettings = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function fixtureHtml(workload: string, tab: string): string {
  const displayedWorkload = workload === 'wrong-workload' ? 'unrelated-service' : workload;
  const title = `<h1>Workload: ${displayedWorkload}</h1>`;
  const tabs = `<div role="tablist"><button role="tab" aria-selected="${tab === 'info'}">Overview</button><button role="tab" aria-selected="${tab === 'logs'}">Logs</button></div>`;
  let controls = '';
  let content = '<section><h2>Health</h2><p>Healthy: all local fixture pods are ready.</p></section>';
  let script = '';
  if (workload === 'generic-error') content = '<div role="alert">Could not fetch Workload.</div>';
  if (tab === 'logs') {
    const matchingName = workload === 'ambiguous-container' ? 'different-app' : workload;
    controls = '<button id="metrics_filter_interval_duration" aria-label="metrics_filter_interval_duration">Custom</button><button>Pause</button>';
    content = `<section id="logs"><label><input id="container-0" type="checkbox" checked>sidecar-proxy</label><label><input id="container-1" type="checkbox" checked>${matchingName}</label><button id="wpl_tailLines" aria-label="wpl_tailLines" aria-haspopup="listbox">3000 lines</button><ul id="line-options" role="listbox" hidden><li><button role="option" aria-label="-1" id="all-lines">All lines</button></li></ul><div id="logsText" role="log">Loading fixture...</div></section>`;
    if (workload === 'no-logs-area') content = '<p>Waiting for logs content.</p>';
    else if (workload === 'empty-logs') content = '<h2>No logs for Workload empty-logs</h2><p>There are no logs to display because the workload has no pods.</p>';
    else {
      script = `let allLines = false;
        const loadLogs = async () => {
          const area = document.getElementById('logsText');
          area.setAttribute('aria-busy', 'true');
          try {
            const response = await fetch('/api/namespaces/test/pods/${workload}/logs?tailLines=' + (allLines ? '-1' : '3000') + '&sidecar=' + document.getElementById('container-0').checked);
            if (response.ok) {
              area.textContent = await response.text();
              area.scrollTop = area.scrollHeight;
              area.scrollLeft = 100;
            }
          } finally { area.removeAttribute('aria-busy'); }
        };
        document.querySelectorAll('input[id^="container-"]').forEach(input => input.addEventListener('change', loadLogs));
        document.getElementById('wpl_tailLines').onclick = () => { document.getElementById('line-options').hidden = false; };
        document.getElementById('all-lines').onclick = () => {
          allLines = true;
          document.getElementById('line-options').hidden = true;
          setTimeout(() => {
            document.getElementById('wpl_tailLines').textContent = 'All lines';
            loadLogs();
          }, 80);
        };
        loadLogs();`;
    }
    if (workload === 'max-lines') content += '<div role="alert">Max lines exceeded</div>';
    if (workload === 'cancelled-refresh') script = `const controller = new AbortController();
      fetch('/api/namespaces/test/pods/cancelled-refresh/logs?cancelled=true', {signal: controller.signal}).catch(() => undefined);
      setTimeout(() => controller.abort(), 30);
      ${script}`;
    if (workload === 'active-refresh') {
      controls = '<button id="metrics_filter_interval_duration">Custom</button><button id="metrics-refresh">Every 1m</button><ul id="refresh-options" role="listbox" hidden><li><button id="pause-refresh" role="option" aria-label="0">Pause</button></li></ul>';
      script += `
        const refreshSettings = new URLSearchParams(location.search);
        refreshSettings.set('refresh', '60000');
        history.replaceState(null, '', location.pathname + '?' + refreshSettings.toString());
        document.getElementById('metrics-refresh').onclick = () => { document.getElementById('refresh-options').hidden = false; };
        document.getElementById('pause-refresh').onclick = () => {
          refreshSettings.set('refresh', '0');
          history.replaceState(null, '', location.pathname + '?' + refreshSettings.toString());
          document.getElementById('metrics-refresh').textContent = 'Pause';
          document.getElementById('refresh-options').hidden = true;
        };
      `;
    }
    if (workload === 'range-reset') {
      controls = '<button id="range-toggle" aria-haspopup="menu" aria-expanded="false">Last 30m</button><div id="range-options" role="menu" hidden><button role="menuitem" id="range-15">Last 15m</button></div><button>Pause</button>';
      script += `
        const resetRange = new URLSearchParams(location.search);
        resetRange.set('duration', '300');
        resetRange.set('rangeDuration', '1800');
        resetRange.delete('refresh');
        history.replaceState(null, '', location.pathname + '?' + resetRange.toString());
        document.getElementById('range-toggle').onclick = () => {
          document.getElementById('range-options').hidden = false;
          document.getElementById('range-toggle').setAttribute('aria-expanded', 'true');
        };
        document.getElementById('range-15').onclick = async () => {
          const selectedRange = new URLSearchParams(location.search);
          selectedRange.set('rangeDuration', '900');
          history.replaceState(null, '', location.pathname + '?' + selectedRange.toString());
          document.getElementById('range-toggle').textContent = 'Last 15m';
          document.getElementById('range-toggle').setAttribute('aria-expanded', 'false');
          document.getElementById('range-options').hidden = true;
          document.getElementById('logsText').setAttribute('aria-busy', 'true');
          await fetch('/api/namespaces/test/pods/range-reset/logs?sinceTime=' + (Math.floor(Date.now() / 1000) - 900));
          document.getElementById('logsText').textContent = 'APPLICATION logs for the selected 15 minutes';
          document.getElementById('logsText').removeAttribute('aria-busy');
        };
      `;
    }
  }
  if (workload === 'too-tall' && tab === 'info') content += '<section style="height:5000px">Additional overview data</section>';
  return `<!doctype html><html><head><title>Local Kiali Fixture</title><style>body{font:18px sans-serif;margin:32px;background:#f4f6f8;color:#172c46}nav{padding:12px;background:#dce5ef}button{padding:12px;margin:4px}section{margin:24px 0;padding:20px;background:white}#logsText{white-space:pre;height:600px;overflow:auto;background:#17212c;color:white;padding:20px}label{margin:12px;display:inline-block}</style></head><body><nav><a href="/kiali/console">Workloads</a></nav><main>${title}${controls}${tabs}<div role="progressbar" aria-label="Loading workload"></div>${content}</main><script>
    setTimeout(() => document.querySelector('[role="progressbar"]').remove(), 60);
    const reordered = new URLSearchParams([...new URLSearchParams(location.search)].reverse());
    history.replaceState(null, '', location.pathname + '?' + reordered.toString());
    ${script}
  </script></body></html>`;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests?.push({ method: request.method ?? 'GET', pathname: url.pathname });
    if (url.pathname.startsWith('/api/')) {
      if (url.searchParams.has('cancelled')) {
        setTimeout(() => { response.writeHead(200); response.end('superseded fixture'); }, 100);
        return;
      }
      if (url.pathname.includes('/api-unauthorized/')) {
        response.writeHead(401, { 'Content-Type': 'text/plain' });
        response.end('Synthetic authentication failure');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        const banner = url.searchParams.get('tailLines') === '-1' && !url.pathname.includes('/missing-banner/') ? '  .   ____          _\n /\\ / ___\'__ _ _(_)_ __\n :: Spring Boot :: (fixture)\n' : '';
        const proxy = url.searchParams.get('sidecar') === 'true' ? 'SIDECAR proxy debug\n' : '';
        response.end(banner + 'APPLICATION ready\napplication error preserved\n' + proxy + Array.from({ length: 80 }, (_, index) => `Application entry ${index}`).join('\n'));
      }
      return;
    }
    const workload = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (workload === 'expired') {
      response.writeHead(302, { Location: '/login?code=synthetic-sensitive-code' });
      response.end();
      return;
    }
    if (url.pathname === '/login') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<h1>Sign in</h1><input type="password" value="synthetic-password">');
      return;
    }
    if (workload === 'missing') {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end('<h1>Workload not found</h1>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(fixtureHtml(workload, url.searchParams.get('tab') ?? 'info'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  config = parseConfig({ ...baseSettings, pageTimeoutMilliseconds: 2500, renderWaitMilliseconds: 80 }, `http://127.0.0.1:${address.port}/kiali/console`);
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  vi.stubEnv('KIALI_BASE_URL', config.kialiBaseUrl);
  requests = [];
  directory = await mkdtemp(path.join(os.tmpdir(), 'kiali-browser-'));
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
  await enableReadOnlyRequests(context);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await context?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); });
});

async function collect(names: string[]): Promise<ServiceResult[]> {
  return collectServices(context, names.map((name) => ({ serviceName: name, namespace: 'test', workload: name })), config, directory, 1800, undefined, () => undefined);
}

describe('real Chromium, loopback Kiali fixtures only', () => {
  it.each(['inner', 'wrapper'])('scrolls the actual %s log viewport without scrolling unrelated panels', async (layout) => {
    const page = await context.newPage();
    const end = Date.now();
    const service = { serviceName: 'nested-scroll', namespace: 'test', workload: 'nested-scroll' };
    const content = ':: Spring Boot :: (fixture)\n' + 'Application log entry with a long horizontal line '.repeat(45) + '\n' + 'Application log entry\n'.repeat(80);
    const logMarkup = layout === 'inner'
      ? `<div id="logsText" role="log"><div id="actual-log-viewport"><pre>${content}</pre></div></div>`
      : `<div id="actual-log-viewport"><pre id="logsText" role="log">${content}</pre></div>`;
    await context.route('**/namespaces/test/workloads/nested-scroll?*', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<style>body{margin:20px}#actual-log-viewport{height:320px;width:800px;overflow:auto}pre{margin:0;font:14px/20px monospace}#unrelated-panel{height:40px;width:100px;overflow:auto}</style>
        <main><h1>Workload: nested-scroll</h1><button role="tab" aria-selected="true">Logs</button><button>Custom</button><button>Pause</button>
        <label><input id="container-0" type="checkbox" checked>nested-scroll</label><button id="wpl_tailLines">All lines</button>${logMarkup}</main>
        <aside id="unrelated-panel"><div style="height:500px">Unrelated panel</div></aside>
        <script>const pane = document.getElementById('actual-log-viewport'); pane.scrollTop = pane.scrollHeight; pane.scrollLeft = 300; document.getElementById('unrelated-panel').scrollTop = 200;</script>`,
    }));
    try {
      await prepareWorkloadPage(page, config, service, 'logs', 86400, end);
      expect(await page.locator('#actual-log-viewport').evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([0, 0]);
      expect(await page.locator('#unrelated-panel').evaluate((element) => element.scrollTop)).toBe(200);
      await expect(assertWorkloadView(page, config, service, 'logs', 86400, end)).resolves.toBeUndefined();
      const screenshot = path.join(directory, `nested-${layout}.png`);
      await captureScreenshot(page, config, screenshot, 'logs', () => assertWorkloadView(page, config, service, 'logs', 86400, end));
      expect(PNG.sync.read(await readFile(screenshot)).height).toBe(1080);
      await page.locator('#actual-log-viewport').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(assertWorkloadView(page, config, service, 'logs', 86400, end)).rejects.toThrow('top-left');
    } finally {
      await page.close();
    }
  });

  it('pauses a restored refresh setting before taking startup evidence', async () => {
    const [result] = await collect(['active-refresh']);
    expect(result!.result).toBe('PASS');
    expect(result!.logsStatus).toBe('CAPTURED');
  });

  it.each(['missing-banner', 'banner-below-top'])('does not claim startup evidence when the Spring banner is absent or off-screen: %s', async (workload) => {
    if (workload === 'banner-below-top') {
      await context.route('**/api/namespaces/test/pods/banner-below-top/logs?*', (route) => route.fulfill({
        contentType: 'text/plain', body: 'Earlier application log\n'.repeat(100) + ':: Spring Boot ::',
      }));
    }
    const results = await collect([workload, 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'PASS']);
    expect(results[0]!.overviewStatus).toBe('CAPTURED');
    expect(results[0]!.logsScreenshotPath).toBeUndefined();
    expect(results[0]!.remarks.join(' ')).toContain('Spring Boot banner is not visible');
  });

  it.each(['proxy', 'lines', 'scroll', 'window'])('rechecks Logs controls and pinned bounds before capture: %s', async (changed) => {
    const page = await context.newPage();
    const end = Date.now();
    const service = { serviceName: 'good-app', namespace: 'test', workload: 'good-app' };
    try {
      await prepareWorkloadPage(page, config, service, 'logs', 86400, end);
      if (changed === 'proxy') await page.getByRole('checkbox', { name: 'sidecar-proxy', exact: true }).check();
      if (changed === 'lines') await page.locator('#wpl_tailLines').evaluate((element) => { element.textContent = '3000 lines'; });
      if (changed === 'scroll') await page.locator('#logsText').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      if (changed === 'window') await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('from', String(Number(url.searchParams.get('from')) + 1000));
        url.searchParams.set('to', String(Number(url.searchParams.get('to')) + 1000));
        history.replaceState(null, '', url.pathname + url.search);
      });
      const failures = { proxy: 'proxy container', lines: 'All lines', scroll: 'top-left', window: 'custom 86400-second' };
      await expect(assertWorkloadView(page, config, service, 'logs', 86400, end)).rejects.toThrow(failures[changed as keyof typeof failures]);
    } finally {
      await page.close();
    }
  });

  it('uses identical custom bounds for the Logs retry and every service in the run', async () => {
    const windows: string[] = [];
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.searchParams.get('tab') === 'logs') {
        windows.push(JSON.stringify([url.searchParams.get('from'), url.searchParams.get('to')]));
      }
    });
    let logNavigations = 0;
    await context.route('**/namespaces/test/workloads/window-retry?*', async (route) => {
      const tab = new URL(route.request().url()).searchParams.get('tab') ?? 'info';
      if (tab === 'logs' && ++logNavigations === 1) await route.fulfill({ status: 302, headers: { location: '/login' } });
      else await route.fulfill({ contentType: 'text/html', body: fixtureHtml('window-retry', tab) });
    });
    const services = ['window-retry', 'good-app'].map((name) => ({ serviceName: name, namespace: 'test', workload: name }));
    const results = await collectServices(context, services, config, directory, 86400, undefined, () => undefined);
    expect(results.map((result) => result.result)).toEqual(['PASS WITH WARNING', 'PASS']);
    expect(windows).toHaveLength(3);
    expect(new Set(windows).size).toBe(1);
    const [from, to] = JSON.parse(windows[0]!) as [string, string];
    expect(Number(to) - Number(from)).toBe(86400000);
  });

  it('opens a one-day Custom Logs window without relying on preset menu options', async () => {
    const page = await context.newPage();
    try {
      const end = Date.now();
      const notes = await prepareWorkloadPage(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'logs', 86400, end);
      expect(notes).toEqual([]);
      const url = new URL(page.url());
      expect(url.searchParams.get('to')).toBe(String(end));
      expect(url.searchParams.get('from')).toBe(String(end - 86400000));
      expect(url.searchParams.has('rangeDuration')).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('verifies a custom Logs window independently of Overview duration', async () => {
    const page = await context.newPage();
    try {
      const end = Date.now();
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=logs&duration=300&from=${end - 86400000}&to=${end}&refresh=0`);
      await page.setContent('<h1>Workload: good-app</h1><button role="tab" aria-selected="true">Logs</button><button>Custom</button><button id="wpl_tailLines">All lines</button><div role="log">:: Spring Boot :: APPLICATION ready</div>');
      await expect(assertWorkloadView(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'logs', 86400, end)).resolves.toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it.each([
    { query: 'from=1700000000000&to=1700001800000&refresh=0', label: 'Custom', pause: true, error: 'custom 86400-second' },
    { query: 'from=1700000000000&to=1700086400000&refresh=0', label: 'Last 30m', pause: true, error: 'custom 86400-second' },
    { query: 'from=1700000000000&to=1700086400000&refresh=30', label: 'Custom', pause: false, error: 'automatic refresh' },
    { query: 'from=1700000000000&to=1700086400000', label: 'Custom', pause: false, error: 'automatic refresh' },
  ])('rejects a wrong Logs range or unverified refresh setting: $query / $label', async ({ query, label, pause, error }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=logs&duration=300&${query}`);
      await page.setContent(`<h1>Workload: good-app</h1><button role="tab" aria-selected="true">Logs</button><button>${label}</button>${pause ? '<button>Pause</button>' : ''}<div role="log">APPLICATION ready</div>`);
      await expect(assertWorkloadView(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'logs', 86400)).rejects.toThrow(error);
    } finally {
      await page.close();
    }
  });

  it('does not relax the Overview range checks when fixing Logs', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=info&duration=1800&rangeDuration=300&refresh=0`);
      await expect(assertWorkloadView(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'info', 900)).rejects.toThrow('Overview time range');
    } finally {
      await page.close();
    }
  });

  it('rejects Kiali replacing the custom window with a preset rather than capturing a different period', async () => {
    const page = await context.newPage();
    try {
      await expect(prepareWorkloadPage(page, config, { serviceName: 'range-reset', namespace: 'test', workload: 'range-reset' }, 'logs', 86400)).rejects.toThrow('custom 86400-second Logs window');
      expect(await page.getByRole('button', { name: 'Last 30m', exact: true }).isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('captures custom Logs windows and processes the next service', async () => {
    const services = ['custom-app', 'good-app'].map((name) => ({ serviceName: name, namespace: 'test', workload: name }));
    const results = await collectServices(context, services, config, directory, 86400, undefined, () => undefined);
    expect(results.map((result) => result.result)).toEqual(['PASS', 'PASS']);
    expect(results.map((result) => result.logsStatus)).toEqual(['CAPTURED', 'CAPTURED']);
    expect(results[0]!.errorScreenshotPath).toBeUndefined();
    expect(await readdir(path.join(directory, 'custom-app'))).toEqual(['01-overview.png', '02-logs.png']);
  });

  it('waits for session bootstrap on each workload navigation instead of treating a temporary login heading as expiry', async () => {
    await context.route('**/namespaces/test/workloads/session-bootstrap?*', async (route) => {
      const tab = new URL(route.request().url()).searchParams.get('tab');
      const content = `<h1>Workload: session-bootstrap</h1><div role="tablist"><button role="tab" aria-selected="${tab === 'info'}">Overview</button><button role="tab" aria-selected="${tab === 'logs'}">Logs</button></div><label><input type="checkbox" id="container-0" checked>session-bootstrap</label><button id="wpl_tailLines">All lines</button><div id="logsText" role="log">:: Spring Boot :: APPLICATION ready</div>`;
      await route.fulfill({
        contentType: 'text/html',
        body: `<h1>Log in</h1><script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(content)}; }, 350);</script>`,
      });
    });
    const results = await collect(['session-bootstrap', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['PASS', 'PASS']);
    expect(results[0]!.overviewStatus).toBe('CAPTURED');
    expect(results[0]!.logsStatus).toBe('CAPTURED');
  });

  it('ignores authentication-related headings and buttons without URL or form evidence', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=info`);
      await page.setContent('<h1>Log in</h1><h2>Authentication failed</h2><button>Sign in</button><p>Unauthorized 401 403</p>');
      expect(await isAuthenticationPage(page, config)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('does not capture a login form that persists through bootstrap', async () => {
    await context.route('**/namespaces/test/workloads/persistent-login?*', (route) => route.fulfill({
      contentType: 'text/html', body: '<h1>Log in</h1><form id="login-form"><button>Continue</button></form>',
    }));
    const results = await collect(['persistent-login', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'FAILED']);
    expect(results[0]!.remarks.join(' ')).toContain('visible login form');
    expect(results[0]!.overviewScreenshotPath).toBeUndefined();
    expect(results[0]!.errorScreenshotPath).toBeUndefined();
    expect(results[1]!.overviewStatus).toBe('NOT ATTEMPTED');
  });

  it.each(['Authentication required', 'Authentication failed', 'login', 'unauthorized', '401', '403', 'Please sign in', 'Your session has expired'])('does not mistake application log text for a login page: %s', async (message) => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=logs`);
      await page.setContent(`<h1>Workload: good-app</h1><button role="tab" aria-selected="true">Logs</button><div id="logsText" role="log">${message}</div>`);
      expect(await isAuthenticationPage(page, config)).toBe(false);
      await assertAuthenticated(page, config);
      expect(await page.locator('#logsText').innerText()).toBe(message);
    } finally {
      await page.close();
    }
  });

  it('still detects a sign-in overlay while workload logs remain visible', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=logs`);
      await page.setContent('<h1>Workload: good-app</h1><div id="logsText" role="log">APPLICATION ready</div><div role="dialog"><h2>Sign in</h2><input type="password"></div>');
      expect(await isAuthenticationPage(page, config)).toBe(true);
      await expect(assertAuthenticated(page, config)).rejects.toThrow('npm run login');
    } finally {
      await page.close();
    }
  });

  it.each([
    '<input type="password">',
    '<form id="login-form"><button>Continue</button></form>',
    '<form id="loginForm"><button>Continue</button></form>',
    '<form action="/oauth2/authorize"><button>Continue</button></form>',
  ])('detects visible password or stable login form evidence', async (content) => {
    const page = await context.newPage();
    try {
      await page.goto(`${config.kialiBaseUrl}/namespaces/test/workloads/good-app?tab=logs`);
      await page.setContent(content);
      expect(await isAuthenticationPage(page, config)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('tolerates an aborted log request when a replacement completes', async () => {
    const [result] = await collect(['cancelled-refresh']);
    expect(result!.result).toBe('PASS');
  });

  it('does not persist a screenshot if authentication changes during capture', async () => {
    const page = await context.newPage();
    const destination = path.join(directory, 'must-not-exist.png');
    try {
      await prepareWorkloadPage(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'info', 1800);
      let checks = 0;
      await expect(captureScreenshot(page, config, destination, 'overview', async () => {
        if (++checks === 2) await page.goto(new URL('/login', config.kialiBaseUrl).href);
        await assertAuthenticated(page, config);
      })).rejects.toThrow('npm run login');
      await expect(readFile(destination)).rejects.toThrow();
    } finally {
      await page.close();
    }
  });

  it('selects the exact application container without touching operational controls', async () => {
    const page = await context.newPage();
    try {
      const notes = await prepareWorkloadPage(page, config, { serviceName: 'good-app', namespace: 'test', workload: 'good-app' }, 'logs', 1800);
      expect(notes).toEqual([]);
      expect(await page.getByRole('checkbox', { name: 'good-app', exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole('checkbox', { name: 'sidecar-proxy', exact: true }).isChecked()).toBe(false);
      expect(await page.locator('#wpl_tailLines').innerText()).toBe('All lines');
      expect(await page.locator('#logsText').evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([0, 0]);
      expect(await page.locator('#logsText').innerText()).toContain(':: Spring Boot ::');
      expect(await page.locator('#logsText').innerText()).toContain('application error preserved');
      const url = new URL(page.url());
      expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(1800000);
      const mutation = await page.evaluate(async () => {
        try { await fetch('/api/never-mutate', { method: 'POST', body: '{}' }); return 'allowed'; }
        catch { return 'blocked'; }
      });
      expect(mutation).toBe('blocked');
      expect(requests.some((request) => request.method !== 'GET')).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('captures useful PNGs, continues after a failed workload, and closes all pages', async () => {
    const results = await collect(['missing', 'good-app', 'max-lines']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'PASS', 'PASS WITH WARNING']);
    expect(results[0]!.errorScreenshotPath).toBeTruthy();
    expect(results[2]!.remarks.join(' ')).toContain('Max lines exceeded');
    const overview = PNG.sync.read(await readFile(results[1]!.overviewScreenshotPath!));
    const logs = PNG.sync.read(await readFile(results[1]!.logsScreenshotPath!));
    expect(overview.width).toBe(1920);
    expect(logs.width).toBe(1920);
    expect(logs.height).toBe(1080);
    expect(new Set(logs.data).size).toBeGreaterThan(20);
    expect(context.pages()).toHaveLength(0);
  });

  it('retains Overview when Logs fails and still processes the next service', async () => {
    const results = await collect(['no-logs-area', 'good-app']);
    expect(results[0]!.overviewStatus).toBe('CAPTURED');
    expect(results[0]!.logsStatus).toBe('FAILED');
    expect(results[0]!.remarks.join(' ')).toContain('logs area');
    expect(results[1]!.result).toBe('PASS');
  });

  it('retries once, saves a redacted authentication check, then skips later services for a confirmed login URL', async () => {
    const results = await collect(['expired', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'FAILED']);
    expect(results[0]!.errorScreenshotPath).toBeUndefined();
    expect(results[0]!.logsScreenshotPath).toBeUndefined();
    expect(results[1]!.overviewStatus).toBe('NOT ATTEMPTED');
    expect(results[1]!.remarks.join(' ')).toContain('npm run login');
    expect(JSON.stringify(results)).not.toMatch(/synthetic-sensitive-code|synthetic-password/);
    expect(results[0]!.remarks.join(' ')).toContain('redirected to a known sign-in URL');
    expect(requests.some((request) => request.pathname.endsWith('/good-app'))).toBe(false);
    expect(requests.filter((request) => request.pathname.endsWith('/expired'))).toHaveLength(2);
    expect(await readdir(path.join(directory, 'expired'))).toEqual(['authentication-check.png']);
    expect(PNG.sync.read(await readFile(path.join(directory, 'expired', 'authentication-check.png'))).width).toBe(1920);
  });

  it('does not skip later services when only the logs API returns HTTP 401', async () => {
    const results = await collect(['api-unauthorized', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'PASS']);
    expect(results[0]!.remarks.join(' ')).toContain('HTTP 401');
    expect(results[0]!.overviewStatus).toBe('CAPTURED');
    expect(results[1]!.logsStatus).toBe('CAPTURED');
  });

  it('recovers from a login redirect on the single retry using the same context', async () => {
    let navigations = 0;
    const contexts = browser.contexts();
    await context.route('**/namespaces/test/workloads/recover-login?*', async (route) => {
      if (++navigations === 1) await route.fulfill({ status: 302, headers: { location: '/login?code=synthetic-code' } });
      else await route.fulfill({ contentType: 'text/html', body: fixtureHtml('recover-login', new URL(route.request().url()).searchParams.get('tab') ?? 'info') });
    });
    const results = await collect(['recover-login', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['PASS WITH WARNING', 'PASS']);
    expect(navigations).toBe(3);
    expect(browser.contexts()).toEqual(contexts);
    expect(results[0]!.remarks.join(' ')).toContain('recovered after one');
  });

  it('does not set global authentication failure when the retry fails for a normal page reason', async () => {
    let navigations = 0;
    await context.route('**/namespaces/test/workloads/retry-error?*', async (route) => {
      if (++navigations === 1) await route.fulfill({ status: 302, headers: { location: '/login' } });
      else await route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Service unavailable</h1>' });
    });
    const results = await collect(['retry-error', 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'PASS']);
    expect(results[0]!.remarks.join(' ')).toContain('HTTP 503');
  });

  it('fails empty startup logs but preserves a non-fatal note for an ambiguous application container', async () => {
    const results = await collect(['empty-logs', 'ambiguous-container']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'PASS WITH WARNING']);
    expect(results[0]!.remarks.join(' ')).toContain('no logs');
    expect(results[1]!.remarks.join(' ')).toContain('preserved the default');
  });

  it('fails on a missing workload identity and generic Kiali error page', async () => {
    const results = await collect(['wrong-workload', 'generic-error']);
    expect(results.every((result) => result.result === 'FAILED')).toBe(true);
    expect(results.every((result) => result.overviewScreenshotPath === undefined)).toBe(true);
  });

  it('caps an impractically tall Overview at the viewport and records the limitation', async () => {
    const [result] = await collect(['too-tall']);
    const image = PNG.sync.read(await readFile(result!.overviewScreenshotPath!));
    expect(image.height).toBe(1080);
    expect(result!.remarks.join(' ')).toContain('three viewport heights');
  });

  it('runs the full collector-to-workbook flow, returns failure status, and honors keep-temp', async () => {
    await copyFile(new URL('../config.json', import.meta.url), path.join(directory, 'config.json'));
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    await mkdir(path.join(directory, 'auth'));
    await writeFile(path.join(directory, 'auth', 'kiali-session.json'), JSON.stringify({ cookies: [], origins: [] }));
    await writeFile(path.join(directory, 'services.csv'), 'serviceName,namespace,workload,enabled\nmissing,test,missing,true\ngood-app,test,good-app,true\ndisabled,test,disabled,false');
    const options: RunOptions = { release: 'Offline-Integration', configPath: 'services.csv', settingsPath: 'config.json', minutes: 30, headed: false, service: undefined, keepTemp: true, overwrite: false };
    const failedRun = await runTvt(options, directory);
    expect(failedRun.exitCode).toBe(1);
    expect(failedRun.results).toHaveLength(2);
    expect((await verifyWorkbook(failedRun.workbookPath, failedRun.results)).worksheetCount).toBe(3);
    expect(await readdir(failedRun.tempDirectory)).toContain('good-app');
    const selectedRun = await runTvt({ ...options, service: 'good-app', keepTemp: false }, directory);
    expect(selectedRun.exitCode).toBe(0);
    expect(selectedRun.workbookPath).not.toBe(failedRun.workbookPath);
    await expect(readdir(selectedRun.tempDirectory)).rejects.toThrow();
    expect((await verifyWorkbook(selectedRun.workbookPath, selectedRun.results)).imageCount).toBe(2);
  });
});