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
import { assertAuthenticated, enableReadOnlyRequests, prepareWorkloadPage } from '../src/kiali.js';
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
  let content = '<section><h2>Health</h2><p>Healthy: all local fixture pods are ready.</p></section>';
  let script = '';
  if (workload === 'generic-error') content = '<div role="alert">Could not fetch Workload.</div>';
  if (tab === 'logs') {
    const matchingName = workload === 'ambiguous-container' ? 'different-app' : workload;
    content = `<section id="logs"><label><input id="container-0" type="checkbox" checked>sidecar-proxy</label><label><input id="container-1" type="checkbox" checked>${matchingName}</label><div id="logsText" role="log">Loading fixture...</div></section>`;
    if (workload === 'no-logs-area') content = '<p>Waiting for logs content.</p>';
    else if (workload === 'empty-logs') content = '<h2>No logs for Workload empty-logs</h2><p>There are no logs to display because the workload has no pods.</p>';
    else {
      script = `fetch('/api/namespaces/test/pods/${workload}/logs').then(async response => {
        if (response.ok) {
          document.getElementById('logsText').textContent = await response.text();
          const update = () => { document.getElementById('logsText').textContent = document.getElementById('container-0').checked ? 'APPLICATION ready\\nSIDECAR proxy debug' : 'APPLICATION ready\\napplication error preserved'; };
          document.querySelectorAll('input[id^="container-"]').forEach(input => input.addEventListener('change', update));
        }
      });`;
    }
    if (workload === 'max-lines') content += '<div role="alert">Max lines exceeded</div>';
    if (workload === 'cancelled-refresh') script = `const controller = new AbortController();
      fetch('/api/namespaces/test/pods/cancelled-refresh/logs?cancelled=true', {signal: controller.signal}).catch(() => undefined);
      setTimeout(() => controller.abort(), 30);
      ${script}`;
  }
  if (workload === 'too-tall' && tab === 'info') content += '<section style="height:5000px">Additional overview data</section>';
  return `<!doctype html><html><head><title>Local Kiali Fixture</title><style>body{font:18px sans-serif;margin:32px;background:#f4f6f8;color:#172c46}nav{padding:12px;background:#dce5ef}button{padding:12px;margin:4px}section{margin:24px 0;padding:20px;background:white}#logsText{white-space:pre;height:600px;overflow:auto;background:#17212c;color:white;padding:20px}label{margin:12px;display:inline-block}</style></head><body><nav><a href="/kiali/console">Workloads</a></nav><main>${title}${tabs}<div role="progressbar" aria-label="Loading workload"></div>${content}</main><script>
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
        response.end('APPLICATION ready\nSIDECAR proxy debug');
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
      expect(await page.locator('#logsText').innerText()).toContain('application error preserved');
      expect(new URL(page.url()).searchParams.get('rangeDuration')).toBe('1800');
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

  it.each(['expired', 'api-unauthorized'])('stops captures after authentication failure: %s', async (name) => {
    const results = await collect([name, 'good-app']);
    expect(results.map((result) => result.result)).toEqual(['FAILED', 'FAILED']);
    expect(results[0]!.errorScreenshotPath).toBeUndefined();
    expect(results[0]!.logsScreenshotPath).toBeUndefined();
    expect(results[1]!.overviewStatus).toBe('NOT ATTEMPTED');
    expect(results[1]!.remarks.join(' ')).toContain('npm run login');
    expect(JSON.stringify(results)).not.toMatch(/synthetic-sensitive-code|synthetic-password/);
    expect(requests.some((request) => request.pathname.endsWith('/good-app'))).toBe(false);
    if (name === 'expired') expect(await readdir(path.join(directory, name))).toEqual([]);
  });

  it('records empty logs and ambiguous containers as non-fatal warnings', async () => {
    const results = await collect(['empty-logs', 'ambiguous-container']);
    expect(results.map((result) => result.result)).toEqual(['PASS WITH WARNING', 'PASS WITH WARNING']);
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