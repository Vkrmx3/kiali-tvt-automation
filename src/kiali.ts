import type { BrowserContext, Locator, Page, Request, Response } from 'playwright';
import { AuthenticationError, TvtError } from './logger.js';
import type { AppConfig, Service } from './types.js';

export type KialiTab = 'info' | 'logs';

const LOG_AREA_SELECTOR = '#logsText, [role="log"], [data-testid="log-viewer"], [data-testid="logs-content"], [data-test="logs-content"], pre';

export function workloadUrl(config: AppConfig, service: Service, tab: KialiTab, logsDurationSeconds = config.logsDurationSeconds): string {
  if ([service.namespace, service.workload].some((value) => value === '.' || value === '..' || !value)) {
    throw new TvtError('URL', 'Namespace and workload must be non-empty, non-relative URL segments.');
  }
  const url = new URL(`${config.kialiBaseUrl}/namespaces/${encodeURIComponent(service.namespace)}/workloads/${encodeURIComponent(service.workload)}`);
  const duration = tab === 'info' ? config.overviewDurationSeconds : logsDurationSeconds;
  url.search = new URLSearchParams({ tab, duration: String(duration), refresh: '0', rangeDuration: String(duration) }).toString();
  return url.href;
}

async function visible(locator: Locator): Promise<boolean> {
  return locator.filter({ visible: true }).first().isVisible().catch(() => false);
}

async function visibleOutsideLogs(locator: Locator): Promise<boolean> {
  for (const candidate of await locator.filter({ visible: true }).all()) {
    if (await candidate.evaluate((element, selector) => !element.closest(selector), LOG_AREA_SELECTOR)) return true;
  }
  return false;
}

export async function getAuthenticationError(page: Page, config: AppConfig): Promise<AuthenticationError | undefined> {
  if (page.isClosed()) return undefined;
  const current = new URL(page.url());
  const base = new URL(config.kialiBaseUrl);
  if (current.protocol === 'about:') return undefined;
  if (current.origin !== base.origin) return new AuthenticationError('Browser left the configured Kiali site, possibly for corporate sign-in. Run: npm run login');
  if (/(?:^|\/)(?:login|sign-?in|oauth2?|authorize|saml|auth|callback)(?:\/|$)/i.test(current.pathname)) {
    return new AuthenticationError('Browser redirected to a sign-in or authentication route. Run: npm run login');
  }
  if (Array.from(current.searchParams.keys()).some((key) => /^(?:access_token|id_token|token|code|SAMLResponse)$/i.test(key))) {
    return new AuthenticationError('Browser is on an authentication callback rather than a clean workload URL. Run: npm run login');
  }
  if (await visible(page.locator('input[type="password"], input[autocomplete="one-time-code"], input[name="token" i], textarea[name="token" i]'))) {
    return new AuthenticationError('A sign-in credential field is visible instead of an authenticated Kiali view. Run: npm run login');
  }
  if (await visibleOutsideLogs(page.getByRole('heading', { name: /^(?:sign\s?in|log\s?in|authentication required|session expired)(?:\b|$)/i }))) {
    return new AuthenticationError('A sign-in or session-expiry heading is visible outside the log content. Run: npm run login');
  }
  if (await visibleOutsideLogs(page.getByRole('button', { name: /^(?:sign\s?in|log\s?in|authenticate)(?:\b|$)/i }))) {
    return new AuthenticationError('A sign-in button is visible outside the log content. Run: npm run login');
  }
  if (await visibleOutsideLogs(page.getByText(/^(?:your session has expired|authentication required|please log in|please sign in)[.!]?$/i))) {
    return new AuthenticationError('Kiali displays an authentication-required notice outside the log content. Run: npm run login');
  }
  return undefined;
}

export async function isAuthenticationPage(page: Page, config: AppConfig): Promise<boolean> {
  return Boolean(await getAuthenticationError(page, config));
}

export async function assertAuthenticated(page: Page, config: AppConfig): Promise<void> {
  const error = await getAuthenticationError(page, config);
  if (error) throw error;
}

export function apiAuthenticationError(response: Response, config: AppConfig): AuthenticationError | undefined {
  if (response.status() !== 401) return undefined;
  const url = new URL(response.url());
  if (url.origin !== new URL(config.kialiBaseUrl).origin || !url.pathname.includes('/api/')) return undefined;
  const source = /\/(?:pods|workloads)\/[^/]+\/logs(?:\/|$)/i.test(url.pathname) ? 'Kiali pod logs API'
    : /\/namespaces\/[^/]+\/workloads\/[^/]+\/?$/i.test(url.pathname) ? 'Kiali workload API' : 'Kiali API';
  return new AuthenticationError(`${source} returned HTTP 401 (Unauthorized). Verify session validity and workload/pod-log access. Run: npm run login`);
}

interface PageSignals {
  authenticationError: AuthenticationError | undefined;
  apiFailure: string | undefined;
  pendingLogs: Set<Request>;
  dispose: () => void;
}

function observeRequests(page: Page, config: AppConfig): PageSignals {
  const base = new URL(config.kialiBaseUrl);
  const signals: PageSignals = { authenticationError: undefined, apiFailure: undefined, pendingLogs: new Set(), dispose: () => undefined };
  const relevant = (request: Request): 'logs' | 'workload' | undefined => {
    const url = new URL(request.url());
    if (url.origin !== base.origin || !url.pathname.includes('/api/')) return undefined;
    if (/\/(?:pods|workloads)\/[^/]+\/logs(?:\/|$)/i.test(url.pathname)) return 'logs';
    if (/\/namespaces\/[^/]+\/workloads\/[^/]+\/?$/i.test(url.pathname)) return 'workload';
    return undefined;
  };
  const onRequest = (request: Request): void => { if (relevant(request) === 'logs') signals.pendingLogs.add(request); };
  const onFinished = (request: Request): void => { signals.pendingLogs.delete(request); };
  const onFailed = (request: Request): void => {
    if (relevant(request) && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      signals.apiFailure = 'A required Kiali data request failed. Check network access and workload permissions.';
    }
    signals.pendingLogs.delete(request);
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    signals.authenticationError ??= apiAuthenticationError(response, config);
    if (relevant(request) && response.status() >= 400 && response.status() !== 401) {
      signals.apiFailure = response.status() === 403 ? 'Access denied to workload data or logs.'
        : response.status() === 404 ? 'Workload or logs were not found.'
          : `Kiali data request failed with HTTP ${response.status()}.`;
    }
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  signals.dispose = () => {
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
  };
  return signals;
}

const pageFailure = /(?:workload.*not found|no workload found|could not fetch workload|unable to (?:load|fetch) workload|access denied|forbidden|not authorized|permission denied|something went wrong|internal server error|unexpected error|page not found)/i;

async function assertHealthy(page: Page, config: AppConfig, signals?: PageSignals): Promise<void> {
  if (signals?.authenticationError) throw signals.authenticationError;
  await assertAuthenticated(page, config);
  if (signals?.apiFailure) throw new TvtError('KIALI_API', signals.apiFailure);
  const errors = page.locator('[role="alert"], h1, h2, h3, h4, h5, [data-test="error-page"], [data-testid="error-page"]');
  if (await visible(errors.filter({ hasText: pageFailure }))) {
    throw new TvtError('KIALI_PAGE', 'Kiali reports a missing workload, denied access, or a page error. Inspect the diagnostic screenshot when available.');
  }
  if (await visible(page.getByText(/^Failed to fetch workload logs:/i))) {
    throw new TvtError('KIALI_LOGS', 'Kiali could not fetch workload logs. Check permissions and pod availability.');
  }
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function workloadVisible(page: Page, service: Service): Promise<boolean> {
  if (await visible(page.getByText(service.workload, { exact: true }))) return true;
  return visible(page.getByRole('heading', { name: new RegExp(`(?:^|\\s)${escapedRegex(service.workload)}(?:$|\\s)`) }));
}

async function tabVisible(page: Page, tab: KialiTab): Promise<boolean> {
  const label = tab === 'info' ? 'Overview' : 'Logs';
  const tabElement = page.getByRole('tab', { name: label, exact: true }).filter({ visible: true }).first();
  if (await tabElement.isVisible()) {
    const selected = await tabElement.getAttribute('aria-selected');
    return selected === null || selected === 'true';
  }
  return await visible(page.getByRole('link', { name: label, exact: true })) || await visible(page.getByRole('button', { name: label, exact: true }));
}

function loadingIndicators(page: Page): Locator {
  return page.locator('[role="progressbar"], [aria-busy="true"], [aria-label*="loading" i], [data-testid="loading"], [data-test="loading"]');
}

function logArea(page: Page): Locator {
  return page.locator(LOG_AREA_SELECTOR);
}

function emptyLogs(page: Page): Locator {
  return page.getByText(/^(?:No (?:container )?logs (?:found|for Workload|available)|There are no logs to display)/i);
}

async function logsVisible(page: Page): Promise<boolean> {
  if (await visible(emptyLogs(page))) return true;
  const areas = logArea(page).filter({ visible: true });
  for (const area of await areas.all()) {
    if ((await area.innerText()).trim().length) return true;
  }
  return false;
}

async function waitUntil(page: Page, config: AppConfig, signals: PageSignals, condition: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + config.pageTimeoutMilliseconds;
  do {
    await assertHealthy(page, config, signals);
    if (await condition()) return;
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  await assertHealthy(page, config, signals);
  throw new TvtError('PAGE_TIMEOUT', message);
}

export async function assertWorkloadView(page: Page, config: AppConfig, service: Service, tab: KialiTab, logsDurationSeconds: number): Promise<void> {
  await assertHealthy(page, config);
  const expected = new URL(workloadUrl(config, service, tab, logsDurationSeconds));
  const actual = new URL(page.url());
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.searchParams.get('tab') !== tab) {
    throw new TvtError('WRONG_PAGE', 'The browser is not on the requested workload and tab. No evidence was saved.');
  }
  for (const key of ['duration', 'rangeDuration', 'refresh']) {
    if (actual.searchParams.get(key) !== expected.searchParams.get(key)) {
      throw new TvtError('WRONG_PERIOD', 'Kiali changed the requested time range or refresh setting. No misleading evidence was saved.');
    }
  }
  if (!(await workloadVisible(page, service))) throw new TvtError('WORKLOAD_ABSENT', 'Expected workload name is not visible.');
  if (!(await tabVisible(page, tab))) throw new TvtError('TAB_ABSENT', 'The requested workload tab is not selected or visible.');
  if (tab === 'logs' && !(await logsVisible(page))) throw new TvtError('LOGS_ABSENT', 'The logs area never loaded.');
}

const sidecarName = /^(?:sidecar-proxy|istio-proxy|linkerd-proxy)$/i;
const uncertainContainer = 'Application container could not be confidently selected; preserved the default container view.';

async function chooseContainer(page: Page, service: Service, config: AppConfig): Promise<string[]> {
  if (sidecarName.test(service.workload)) return [uncertainContainer];
  const timeout = Math.min(3000, config.pageTimeoutMilliseconds);
  try {
    const select = page.getByRole('combobox', { name: /container/i }).or(page.locator('select[id*="container" i]')).filter({ visible: true });
    if (await select.count() === 1) {
      const options = await select.locator('option').evaluateAll((elements) => elements.map((element) => ({
        label: element.textContent?.trim(), value: (element as HTMLOptionElement).value,
      })));
      const match = options.filter((option) => option.label === service.workload || option.value === service.workload);
      if (match.length === 1) {
        await select.selectOption(match[0]!.value, { timeout });
        return [];
      }
      return [uncertainContainer];
    }
    const checkboxes = page.locator('input[type="checkbox"][id^="container-"]').filter({ visible: true });
    if (await checkboxes.count()) {
      const match = page.getByRole('checkbox', { name: service.workload, exact: true }).and(checkboxes);
      if (await match.count() !== 1) return [uncertainContainer];
      const matchingId = await match.getAttribute('id');
      await match.check({ timeout });
      for (const checkbox of await checkboxes.all()) {
        if (await checkbox.getAttribute('id') !== matchingId) await checkbox.uncheck({ timeout });
      }
      return [];
    }
    const toggle = page.getByRole('button', { name: /^(?:select )?containers?(?:\b|$)/i }).filter({ visible: true });
    if (await toggle.count() === 1) {
      await toggle.click({ timeout });
      const option = page.getByRole('option', { name: service.workload, exact: true })
        .or(page.getByRole('menuitem', { name: service.workload, exact: true })).filter({ visible: true });
      await option.first().waitFor({ state: 'visible', timeout }).catch(() => undefined);
      if (await option.count() === 1) {
        await option.click({ timeout });
        return [];
      }
      await page.keyboard.press('Escape');
    }
    return [uncertainContainer];
  } catch {
    await assertAuthenticated(page, config);
    await page.keyboard.press('Escape').catch(() => undefined);
    return ['Could not confirm application-only container selection; current container view retained.'];
  }
}

export async function prepareWorkloadPage(page: Page, config: AppConfig, service: Service, tab: KialiTab, logsDurationSeconds: number): Promise<string[]> {
  const signals = observeRequests(page, config);
  const notes: string[] = [];
  page.setDefaultTimeout(config.pageTimeoutMilliseconds);
  try {
    let response;
    try {
      response = await page.goto(workloadUrl(config, service, tab, logsDurationSeconds), {
        waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMilliseconds,
      });
    } catch (error) {
      await assertAuthenticated(page, config);
      throw error;
    }
    await assertAuthenticated(page, config);
    if (response?.status() === 401) throw new AuthenticationError('Workload page navigation returned HTTP 401 (Unauthorized). Run: npm run login');
    if (response?.status() === 403) throw new TvtError('ACCESS_DENIED', 'Access denied to the requested workload.');
    if (response?.status() === 404) throw new TvtError('NOT_FOUND', 'The requested workload page was not found.');
    if (response && response.status() >= 400) throw new TvtError('HTTP', `Kiali navigation failed with HTTP ${response.status()}.`);
    await waitUntil(page, config, signals, async () => await workloadVisible(page, service) && await tabVisible(page, tab), 'Expected workload name or requested tab did not become visible.');
    const ready = async (): Promise<boolean> => !(await visible(loadingIndicators(page))) &&
      (tab !== 'logs' || signals.pendingLogs.size === 0 && await logsVisible(page));
    await waitUntil(page, config, signals, ready, tab === 'logs' ? 'The logs area never finished loading.' : 'Workload loading indicators did not disappear.');
    if (tab === 'logs' && !(await visible(emptyLogs(page)))) {
      notes.push(...await chooseContainer(page, service, config));
    }
    await waitUntil(page, config, signals, ready, 'The workload view did not finish rendering after container selection.');
    if (config.renderWaitMilliseconds) await page.waitForTimeout(config.renderWaitMilliseconds);
    await waitUntil(page, config, signals, ready, 'The workload view did not stabilize before capture.');
    await assertWorkloadView(page, config, service, tab, logsDurationSeconds);
    if (tab === 'logs') {
      if (await visible(page.getByText(/Max lines exceeded/i))) notes.push('Max lines exceeded: the logs view is truncated.');
      if (await visible(emptyLogs(page))) notes.push('Kiali reports no logs for this workload or the selected time period.');
      const area = logArea(page).filter({ visible: true }).first();
      if (await area.isVisible()) {
        const bounds = await area.boundingBox();
        if (bounds && bounds.y >= config.viewportHeight - 100) await area.scrollIntoViewIfNeeded();
      }
    }
    return notes;
  } finally {
    signals.dispose();
  }
}

export async function canCaptureDiagnostic(page: Page, config: AppConfig, service: Service): Promise<boolean> {
  if (page.isClosed() || await isAuthenticationPage(page, config)) return false;
  const actual = new URL(page.url());
  const expected = new URL(workloadUrl(config, service, 'info'));
  return actual.origin === expected.origin && actual.pathname === expected.pathname;
}

export async function enableReadOnlyRequests(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) await route.continue();
    else await route.abort('blockedbyclient');
  });
}

export async function confirmKialiLoaded(page: Page, config: AppConfig): Promise<void> {
  await assertAuthenticated(page, config);
  const actual = new URL(page.url());
  const base = new URL(config.kialiBaseUrl);
  if (actual.origin !== base.origin || !(actual.pathname === base.pathname || actual.pathname.startsWith(`${base.pathname}/`))) {
    throw new AuthenticationError('Login was not confirmed on the configured Kiali site. Run: npm run login');
  }
  const navigation = page.getByRole('link', { name: /^(?:Workloads|Namespaces|Traffic Graph|Overview)$/i });
  try {
    await navigation.filter({ visible: true }).first().waitFor({ state: 'visible', timeout: config.pageTimeoutMilliseconds });
  } catch {
    throw new AuthenticationError('Kiali navigation is not visible. Finish authentication and run: npm run login');
  }
  await assertAuthenticated(page, config);
}