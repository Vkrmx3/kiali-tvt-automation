import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { assertWorkloadView, canCaptureDiagnostic, getAuthenticationError, prepareWorkloadPage, workloadUrl } from './kiali.js';
import { AuthenticationError, TvtError, logDiagnosticUrl, progress, safeErrorMessage } from './logger.js';
import { createSheetNames, safePathSegment } from './naming.js';
import { createServiceResult, finishResult } from './results.js';
import { captureAuthenticationCheck, captureScreenshot } from './screenshots.js';
import type { AppConfig, Service, ServiceResult } from './types.js';

type ProgressReporter = (index: number, total: number, message: string) => void;

export async function collectServices(context: BrowserContext, services: Service[], config: AppConfig, tempDirectory: string, logsDurationSeconds: number, signal?: AbortSignal, report: ProgressReporter = progress): Promise<ServiceResult[]> {
  const sheetNames = createSheetNames(services.map((service) => service.serviceName));
  const results: ServiceResult[] = [];
  const usedDirectories = new Set<string>();
  let authenticationFailure: AuthenticationError | undefined;
    for (const [index, service] of services.entries()) {
      const result = createServiceResult(service, sheetNames[index]!);
      results.push(result);
      if (authenticationFailure || signal?.aborted) {
        result.remarks.push(authenticationFailure ? `Not attempted after an earlier authentication failure: ${safeErrorMessage(authenticationFailure)}` : 'Not attempted: run was interrupted.');
        report(index, services.length, 'FAILED (not attempted)');
        continue;
      }
      report(index, services.length, `Capturing ${service.serviceName}...`);
      const started = performance.now();
      const baseDirectoryName = safePathSegment(service.serviceName, 'Service');
      let directoryName = baseDirectoryName;
      let sequence = 2;
      while (usedDirectories.has(directoryName.toLowerCase())) directoryName = `${baseDirectoryName}-${sequence++}`;
      usedDirectories.add(directoryName.toLowerCase());
      const directory = path.join(tempDirectory, directoryName);
      let page: Page | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (const tab of ['info', 'logs'] as const) {
          const kind = tab === 'info' ? 'overview' : 'logs';
          const label = tab === 'info' ? 'Overview' : 'Logs';
          const statusKey = `${kind}Status` as const;
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              if (signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
              if (!page || page.isClosed()) page = await context.newPage();
              const activePage = page;
              try {
                const notes = await prepareWorkloadPage(activePage, config, service, tab, logsDurationSeconds);
                const destination = path.join(directory, tab === 'info' ? '01-overview.png' : '02-logs.png');
                notes.push(...await captureScreenshot(activePage, config, destination, kind, async () => {
                  await assertWorkloadView(activePage, config, service, tab, logsDurationSeconds);
                }));
                result.remarks.push(...notes);
                if (attempt) result.remarks.push(`${label}: recovered after one authentication-page retry.`);
                result[`${kind}ScreenshotPath`] = destination;
                result[statusKey] = 'CAPTURED';
                result.captureTimestamp = new Date();
                report(index, services.length, `${label} captured`);
                break;
              } catch (error) {
                logDiagnosticUrl(activePage.url(), 'Current');
                const confirmed = await getAuthenticationError(activePage, config).catch(() => undefined);
                if (!confirmed) throw error;
                try {
                  await captureAuthenticationCheck(activePage, config, directory);
                } catch {
                  result.remarks.push('Redacted authentication diagnostic could not be captured.');
                }
                if (attempt === 0 && !signal?.aborted) {
                  report(index, services.length, `${label}: checking the target again before confirming authentication failure.`);
                  logDiagnosticUrl(workloadUrl(config, service, tab, logsDurationSeconds), 'Retry');
                  continue;
                }
                if (signal?.aborted) throw new TvtError('INTERRUPTED', 'Run was interrupted.');
                const finalConfirmation = await getAuthenticationError(activePage, config).catch(() => undefined);
                if (!finalConfirmation) throw new TvtError('PAGE_CHANGED', 'The authentication page changed during confirmation. No global authentication failure was declared.');
                authenticationFailure = finalConfirmation;
                throw finalConfirmation;
              }
            }
          } catch (error) {
            result[statusKey] = 'FAILED';
            const message = signal?.aborted ? 'Run was interrupted.' : safeErrorMessage(error);
            result.remarks.push(`${label}: ${message}`);
            report(index, services.length, `${label} failed: ${message}`);
            if (!authenticationFailure && page && !result.errorScreenshotPath && await canCaptureDiagnostic(page, config, service).catch(() => false)) {
              try {
                const diagnosticPage = page;
                const destination = path.join(directory, 'error.png');
                await captureScreenshot(diagnosticPage, config, destination, 'error', async () => {
                  if (authenticationFailure || !(await canCaptureDiagnostic(diagnosticPage, config, service))) throw new AuthenticationError();
                });
                result.errorScreenshotPath = destination;
                result.captureTimestamp ??= new Date();
              } catch {
                result.remarks.push('Diagnostic screenshot unavailable or suppressed for authentication safety.');
              }
            }
            if (authenticationFailure || signal?.aborted) break;
          }
        }
      } catch (error) {
        result.remarks.push(safeErrorMessage(error));
      } finally {
        result.elapsedMilliseconds = Math.round(performance.now() - started);
        finishResult(result);
        await page?.close().catch(() => undefined);
      }
      report(index, services.length, result.result);
    }
  return results;
}