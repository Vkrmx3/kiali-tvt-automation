# kiali-tvt-automation

A local, read-only TypeScript CLI for Kiali post-release evidence. It reads enabled
workloads from CSV, opens each workload directly, captures Overview and Logs, and
embeds the images in one `.xlsx` workbook. Microsoft Excel is not required to
generate or verify the workbook. There is no web application, CI/CD integration,
Python, Electron, or Kubernetes mutation client.

## Prerequisites

- Node.js 22.13 or newer in the Node 22 or Node 24 release lines, with npm.
- Playwright Chromium, installed separately as below.
- Access to the corporate network/VPN and the configured Kiali site.
- A Kiali account allowed to view the required namespaces, workloads, and pod logs.
- Sufficient local disk space for screenshots and the finished workbook.

Development and automated checks have been run on Windows with Node 22.13.1.
The code uses platform-independent filesystem APIs. macOS and Linux have not
been validated on this workstation.

## Installation

Run commands from the project directory:

```sh
npm ci
npx playwright install chromium
npm run build
npm test
```

Use `npm install` instead of `npm ci` when intentionally changing dependencies.
Commit the updated lockfile with dependency changes. On Linux, Playwright may
also require OS libraries: `npx playwright install --with-deps chromium` installs
them, subject to your machine's administrative policy.

### PowerShell

Some corporate machines block the `npm.ps1` and `npx.ps1` shims. Use the `.cmd`
shims; changing execution policy is not necessary:

```powershell
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd run build
npm.cmd test
```

All following `npm`/`npx` examples also work with `npm.cmd`/`npx.cmd` on Windows.
Do not disable TLS validation to work around a corporate certificate error.
Install your approved corporate CA in the appropriate trust store. For Node
downloads, IT may supply a PEM file for `NODE_EXTRA_CA_CERTS`; Chromium uses the
browser/OS certificate configuration.

## Initial Login

```sh
npm run login
```

Chromium opens visibly at the configured Kiali base URL. Complete corporate SSO
and MFA **in the browser**, then press Enter in the terminal after Kiali loads.
Do not type passwords, MFA codes, or tokens into the terminal. The command
checks that Kiali navigation is visible before saving Playwright storage state
to `auth/kiali-session.json` and closing the browser.

The directory is created automatically. The state contains cookies, local
storage, and supported IndexedDB state; it is sensitive and must not be shared
or committed. It is never printed or added to the workbook. On POSIX systems the
utility requests owner-only file permissions; on Windows protect it with your
normal user-directory ACLs. Playwright does not persist sessionStorage; SSO that
depends exclusively on sessionStorage may need deployment-specific handling.

Use `npm run login -- --settings alternate-config.json` for alternative settings.

## First Live Validation

After logging in, run only one service initially:

```sh
npm run tvt -- --release "Test-Release" --service "kafka-ui" --headed --keep-temp
```

Review the Summary and service sheet. Confirm that the expected workload,
Overview content, Logs tab, application container, and requested log period are
visible. Check the PNGs in the release's temporary directory if needed.

Automated browser tests use local fixtures, not your corporate Kiali deployment.
Kiali versions can differ in markup and authentication. Validate this limited
run and adjust the centralized locators in `src/kiali.ts` before collecting the
full service list. A PASS means evidence was collected, not that the service's
health or log contents passed a business acceptance check.

## Normal Execution

```sh
npm run tvt -- --release "Release-2026-10-09"
npm run tvt -- --release "Release-2026-10-09" --minutes 15
npm run tvt -- --release "Release-2026-10-09" --headed
npm run tvt -- --release "Release-2026-10-09" --service "kafka-ui"
npm run tvt -- --release "Release-2026-10-09" --config "services.csv"
```

| Argument | Meaning |
| --- | --- |
| `--release <name>` | Required, non-empty release label, at most 200 characters. The original label is displayed; the filename is sanitized. |
| `--minutes <integer>` | Override log duration, from 1 through 1440 minutes. Defaults to the configured log duration, normally 15 minutes. |
| `--headed` | Show Chromium. Otherwise use `defaultHeadless`. |
| `--service <name>` | Process one enabled service by exact, case-sensitive `serviceName`. |
| `--config <path>` | Service CSV, default `services.csv`. This is **not** the JSON settings path. |
| `--settings <path>` | Application settings JSON, default `config.json`. |
| `--keep-temp` | Keep screenshots after workbook verification. |
| `--overwrite` | Explicitly allow replacement of the original release workbook. |
| `--help` | Display command help without launching a browser. |

Relative TVT input paths resolve from the project root. Login settings resolve
from the current directory, so run the documented commands from the project
root. Absolute input paths are also supported. Auth, output, and temporary
directories remain inside the project directory.

## Service CSV

```csv
serviceName,namespace,workload,enabled
kafka-ui,kafka,kafka-ui,true
anz-account-management-service-v1,backoffice,anz-account-management-service-v1,true
anz-adapter-service-v1,backoffice,anz-adapter-service-v1,true
```

- `serviceName` is the display name in Excel. Long names remain in full inside
  the sheet and Summary even when the tab name must be shortened.
- `namespace` and `workload` identify the exact Kiali workload.
- `enabled` accepts `true`, `false`, or blank (default `true`), case-insensitively.
- Headers and values are trimmed; blank lines and a UTF-8 BOM are supported.
  Use normal CSV quoting for commas or quotes inside values.
- All four column headers are required. Required identity fields must be
  non-empty, single-line text. Unknown or duplicate headers, malformed records,
  duplicate names, and duplicate namespace/workload pairs are rejected before
  browser startup. Duplicate errors identify both row numbers, including
  duplicates in disabled rows.
- Disabled services appear in neither the workbook nor screenshots.
- Add a row to add a service. Remove its row or set `enabled=false` to remove it
  from runs. Do not put credentials or tokens in this file.

## Configuration

`config.json` contains the base URL in one place and provides these defaults:

```json
{
  "environment": "Production",
  "kialiBaseUrl": "https://kiali.prd.ausiex.com.au/kiali/console",
  "overviewDurationSeconds": 300,
  "logsDurationSeconds": 900,
  "pageTimeoutMilliseconds": 90000,
  "renderWaitMilliseconds": 5000,
  "viewportWidth": 1920,
  "viewportHeight": 1080,
  "deviceScaleFactor": 1,
  "defaultHeadless": true
}
```

`environment` is the Summary label; it defaults to `Production` when omitted.
`KIALI_BASE_URL` overrides only `kialiBaseUrl`. Change `environment` yourself when
switching environments. Base URLs must use HTTPS, except loopback HTTP for
offline tests, and must not contain credentials, query parameters, or fragments.

PowerShell:

```powershell
$env:KIALI_BASE_URL = "https://your-kiali.example/kiali/console"
npm.cmd run login
npm.cmd run tvt -- --release "Test-Release" --service "kafka-ui" --headed
Remove-Item Env:KIALI_BASE_URL
```

POSIX shells:

```sh
export KIALI_BASE_URL="https://your-kiali.example/kiali/console"
npm run login
npm run tvt -- --release "Test-Release" --service "kafka-ui" --headed
unset KIALI_BASE_URL
```

Durations are validated. Page timeout accepts 1,000-600,000 milliseconds, render
delay 0-60,000 milliseconds, viewport width 640-3840, height 480-2160, and device
scale 0.5-3. Page timeout applies to each navigation/readiness stage, not the
entire run. Defaults favor reliable sequential collection over speed.

## Collection Behavior

The utility navigates directly to:

```text
<base>/namespaces/<URL-encoded namespace>/workloads/<URL-encoded workload>
```

Overview uses `tab=info`, the configured overview duration in `duration` and
`rangeDuration`, and `refresh=0`. Logs uses `tab=logs`, the selected log duration
in both duration parameters, and `refresh=0`. For example, `--minutes 30` sets
`rangeDuration=1800` and `duration=1800`. Parameter order does not matter.

Each tab waits for DOMContentLoaded, the workload identity, the requested tab,
visible loading indicators to disappear, and the configured render delay.
Logs also waits for rendered log content or an explicit empty-log state and
for relevant log requests to finish. HTTP errors, missing workloads, denied
access, page errors, and missing log content are recorded as failures.

For multiple containers, an exact workload-name match is preferred. Supported
native selects, labelled checkboxes, and container dropdowns are handled.
With checkboxes, the exact application container is retained and others are
deselected. The utility never deliberately selects `sidecar-proxy`,
`istio-proxy`, or `linkerd-proxy`. Ambiguous views are retained with a warning.
This is a display selection only; log filters, log levels, and pod data are not
changed. Empty logs and visible "Max lines exceeded" messages produce warnings.

Overview uses a full-page capture when the page is at most three viewport
heights; taller pages use a viewport capture with a Summary warning. Logs and
diagnostic captures use the visible viewport to avoid unusably tall virtualized
log screenshots. This is evidence of the visible log view, **not a complete log
export**. Warnings, health indicators, and application log errors are never
hidden, edited, or filtered out. The navigation is left intact.

## Output and Workbook Layout

The normal output is:

```text
output/TVT-Release-2026-10-09.xlsx
```

Unsafe filename characters, traversal segments, and Windows device names are
sanitized. If the workbook already exists, a UTC timestamp is added to the new
filename. There is no silent overwrite. `--overwrite` replaces the base-named
file only after a new staged workbook has been generated and verified. Close
the old workbook in Excel first. The absolute output path is always printed
after successful workbook creation, even when service failures set exit code 1.

The first worksheet is **Summary**, containing run metadata and a filterable,
frozen-header table with No., Service Name, Namespace, Workload, Overview, Logs,
Result, Remarks, and Captured At. Service names link to their worksheets.

Results are `PASS`, `PASS WITH WARNING`, or `FAILED`, with green, orange, and
light-red formatting. "Successful" counts PASS only; warnings are a separate,
non-overlapping count. Selected-service runs count only the selected enabled
service. Timestamps are displayed as Sydney-local text including the timezone,
using `Australia/Sydney` daylight-saving rules rather than a fixed UTC offset.

Each service sheet includes the full name, namespace, workload, release,
capture timestamp, result, remarks, elapsed time, and a link back to Summary.
Overview is above Logs. Images preserve aspect ratio inside a consistent
maximum 1080-by-1400-pixel area; the next heading is placed using the scaled
image height. Missing captures have visible failure messages, and a diagnostic
image is embedded when available. Print settings are landscape, one page wide,
with narrow margins. No Excel installation is involved.

Tab names are deterministic and case-insensitively unique, at most 31
characters. Forbidden characters and internal apostrophes become hyphens.
Blank names get a fallback; `Summary` and Excel's `History` name are reserved.
Collisions receive `-2`, `-3`, etc. Full display names are retained in cells.
Formula-like input is escaped as text; all hyperlinks are internal, with no
formulas, macros, or external workbook links.

Before publishing, the workbook is reopened with ExcelJS to check the first
sheet, worksheet count, every Summary row, service sheets, valid internal
hyperlinks, embedded PNG payloads, absence of formulas, and a non-empty file.

## Temporary Evidence and Failures

```text
temp/<safe-release>/<safe-service>/01-overview.png
temp/<safe-release>/<safe-service>/02-logs.png
temp/<safe-release>/<safe-service>/error.png
```

Existing release directories are never reused: a timestamped suffix protects
preserved evidence, and colliding service directory names receive numeric
suffixes. Only the current run's directory is removed, after successful
workbook verification, unless `--keep-temp` was supplied. If workbook creation
fails, temporary screenshots and any staged workbook are preserved.

Services run sequentially, each with a fresh page. A failed Overview does not
prevent an attempt to capture Logs, and a failed service does not stop later
services. Successfully captured tabs are retained. Missing or unreadable PNGs
also downgrade the affected result rather than breaking other service sheets.

Authentication failure is the exception: further navigation stops, and every
remaining service receives a FAILED/not-attempted Summary row. Login pages
are never intentionally saved as screenshots or embedded as evidence.
Navigation and authentication are checked again after capture, before writing
image bytes. Ctrl+C during collection closes Chromium and attempts to generate
a partial workbook; unattempted services are recorded as failed.

Exit codes: `0` for no failed services (warnings allowed), `1` for failed
services or setup/output errors, and `130` for an interrupted collection when
the partial workbook can be completed. Pages, contexts, and browsers are closed
in `finally` blocks. A forced OS termination cannot guarantee finalization.

## Session Expiry and Troubleshooting

| Symptom | Action |
| --- | --- |
| `Authentication session not found. Run: npm run login` | Run initial login from an interactive terminal. |
| Login redirect, HTTP 401, or expired session | Run `npm run login` again. Then repeat the limited headed test. |
| Missing Chromium executable | Run `npx playwright install chromium`. |
| `npm.ps1 cannot be loaded` | Use `npm.cmd` and `npx.cmd` on PowerShell. |
| DNS, connection, or navigation failure | Check VPN, Kiali URL, network access, and certificate trust. |
| TLS certificate validation failure | Use the approved corporate CA/trust configuration. Do not bypass TLS. |
| Workload not found or access denied | Check exact CSV names and account permissions. No role or cluster changes are performed by this utility. |
| Expected tab/workload or logs area absent | Rerun one service with `--headed --keep-temp`; inspect sanitized remarks and PNGs. The deployed Kiali markup may require selector adjustment. |
| Wrong time range reported | Confirm your Kiali version accepts the required URL parameters. The tool refuses to save misleading evidence after a range rewrite. |
| Empty logs or Max lines exceeded | Review the warning and visible evidence. The utility does not change log limits or export all logs. |
| Output file in use or permission denied | Close it in Excel, check directory permissions, or omit `--overwrite` to write a new filename. |
| Unexpected browser failure | Review sanitized Remarks, rerun one headed service, and check Chromium installation. Raw Playwright diagnostics are deliberately not printed. |

Normal TVT contexts block non-GET/HEAD/OPTIONS requests as a defense against
mutations. An SSO deployment that requires POST token refresh during collection
may need a fresh manual login; the utility does not weaken the read-only policy.

## Local Tests

```sh
npm run build
npm test
npm run test:workbook
npm run test:browser
npm run sample:workbook
```

All tests run without corporate Kiali access. Unit tests cover naming, CSV,
configuration, formula safety, URL parameters, and command guards. Workbook
tests generate PNGs and inspect reopened ExcelJS workbooks. Browser tests launch
real Chromium against a temporary loopback fixture server and close it afterward.
They verify container selection, capture dimensions and nonblank pixels, failed
service continuation, authentication suppression, read-only requests, and the
end-to-end report/cleanup flow. There is no development server to leave running.

`sample:workbook` writes `output/TVT-Workbook-Sample.xlsx` (or a timestamped
variant), with clearly labelled generated fixtures, not real Kiali evidence.
It verifies three worksheets, two Summary rows, and four embedded images.
Do not use it as release sign-off evidence.

## Security and Retention

- Never commit or share `auth/kiali-session.json`. Git ignores all authentication
  contents, workbooks, temporary evidence, local environment files, and test logs.
- Do not put secrets in settings, CSV, release labels, or command arguments.
- The utility never logs passwords, MFA codes, cookies, headers, session data,
  browser console output, raw HTML, or raw browser errors. Session state is not
  passed to the workbook writer. Error messages use controlled, sanitized text.
- Screenshots contain real workload information and application logs, which
  may themselves contain sensitive business data. Treat all output and retained
  temporary images as confidential. Review application logging policy before
  collection; the utility does not redact or change evidence content.
- The tool does not click Kiali Actions, change proxy log levels, invoke
  Kubernetes mutation APIs, or disable certificate verification.
- Follow your organization's evidence retention and secure-disposal policies.
  Git ignore rules are not encryption and do not prevent manual file sharing.

The lockfile includes patched `csv-parse` and an ExcelJS-scoped `uuid` 11.1.1
override. The latter keeps ExcelJS's CommonJS import compatible while addressing
the reported UUID advisory. Review the override when upgrading ExcelJS.

See [runtime-validation-report.md](runtime-validation-report.md) for the local
verification results and the live-deployment validation boundary.

## Project Structure

`src/login.ts` handles manual login; `auth.ts` isolates session persistence.
`run-tvt.ts` coordinates options and output; `collect.ts` processes service
results sequentially. `kiali.ts` owns readiness and container selection;
`screenshots.ts` owns guarded image capture and temporary directories.
`config.ts`, `services.ts`, `naming.ts`, and `logger.ts` validate and sanitize
inputs. `workbook.ts` generates and verifies Excel output. `types.ts` and
`results.ts` define shared result contracts. Tests and generated-image helpers
live under `tests/`, with the workbook-only command under `scripts/`.