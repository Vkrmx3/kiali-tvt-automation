export class TvtError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TvtError';
    this.code = code;
  }
}

export class AuthenticationError extends TvtError {
  constructor(message = 'Authentication session expired or Kiali redirected to login. Run: npm run login') {
    super('AUTHENTICATION', message);
    this.name = 'AuthenticationError';
  }
}

export function consoleText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function safeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : '[non-HTTP page]';
  } catch {
    return '[invalid URL]';
  }
}

export function logDiagnosticUrl(value: string, stage: 'Target' | 'Current' | 'Retry'): void {
  console.log(`${stage} page: ${safeDiagnosticUrl(value)}`);
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof TvtError) return consoleText(error.message);
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'Page timed out before the required content was ready.';
    if (/ERR_CERT|CERTIFICATE_VERIFY_FAILED|SELF_SIGNED_CERT/i.test(error.message)) {
      return 'TLS certificate validation failed. Install the approved corporate CA; TLS validation remains enabled.';
    }
    if (/Executable doesn't exist|browserType\.launch.*executable/i.test(error.message)) {
      return 'Chromium is not installed. Run: npx playwright install chromium';
    }
    const code = 'code' in error ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'File access denied or file in use. Check permissions and close the workbook in Excel.';
    if (code === 'ENOSPC') return 'Insufficient disk space. Temporary evidence has been preserved.';
    if (code === 'ENOENT') return 'A required local file or directory was not found.';
    if (/net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(error.message)) return 'Navigation failed. Check VPN, DNS, network access, and the Kiali base URL.';
  }
  return 'Unexpected operation failure. Check configuration, network access, and local file permissions.';
}

export function progress(index: number, total: number, message: string): void {
  console.log(`[${index + 1}/${total}] ${consoleText(message)}`);
}