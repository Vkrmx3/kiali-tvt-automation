# Runtime Validation Report

Date: 2026-10-09

Target: local kiali-tvt-automation CLI. No corporate Kiali login or live workload
collection was attempted. No CI/CD or production infrastructure was created.

## Environment

- Windows; Node.js 22.13.1; TypeScript 5.9.3.
- Playwright 1.64.0 with installed Chromium; real browser tests on loopback only.
- Vitest 4.1.11; ExcelJS 4.4.0; csv-parse 7.0.3.
- No database, Docker, Azure, or Kubernetes runtime dependency.
- PowerShell execution policy blocks npm.ps1; npm.cmd works without policy changes.

## Final Checks

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| `npm run build` | PASS | 0 | Strict TypeScript compilation with no emit. |
| `npm test` | PASS | 0 | 70 passed, 0 failed, 0 skipped, across seven test files. |
| `npm run login -- --help` | PASS | 0 | Login entry point loads without opening a browser. |
| `npm run tvt -- --help` | PASS | 0 | All documented execution options are available. |
| `npm run sample:workbook` | PASS | 0 | Generated and reopened a non-empty XLSX with 3 sheets, 2 service rows, and 4 embedded PNGs. |

The final standalone validation run passed all five assertions. Its local,
Git-ignored machine-readable result is
[.tsupgrader/runtime-validation/standalone-result.json](.tsupgrader/runtime-validation/standalone-result.json).

## Coverage

- Deterministic, collision-safe Excel tab names, Windows-safe filenames,
  formula-safe text, and Sydney daylight-saving time formatting.
- CSV trimming, disabled rows, required fields, duplicate identities, malformed
  input, exact service filtering, and argument/configuration validation.
- Summary-first ordering, service worksheets, internal hyperlinks, embedded
  image bytes, scaled non-overlapping Overview/Logs layout, missing-image failure
  messages, diagnostic images, and collision-safe output publication.
- Real Chromium navigation with reordered query parameters, loading states,
  container selection, nonblank pixels, and viewport-limited Logs screenshots.
- Continuation after failed workloads; preservation of a successful Overview
  when Logs fails; browser/page cleanup; selected and disabled service behavior.
- Login redirects and API 401 responses suppress unsafe evidence and mark later
  services not attempted. Authentication changing during capture leaves no PNG.
- Non-read-only requests are blocked. Cancelled superseded log requests are
  tolerated. Tests isolate KIALI_BASE_URL to their temporary loopback server.
- The full collector-to-workbook flow returns failure status after writing a
  report, honors keep-temp, and removes only verified current-run evidence.

## Fixes Verified

- ExcelJS print-area round trips failed with internal apostrophes in sheet
  names. Tab names now replace them while retaining full service names in cells.
- The validation runner initially used a lowercase Windows drive prefix,
  causing duplicate Vitest runner module identities. Running from the canonical
  uppercase `D:` path passed without weakening or skipping tests.
- Dependency assessment checked 37 selected direct/tooling dependencies and key
  ExcelJS transitive dependencies against GitHub advisories. This was a targeted
  scan, not an exhaustive audit of every optional/transitive package.

| Advisory | Dependency | Initial version | Patched resolution |
| --- | --- | --- | --- |
| CVE-2026-85063 | csv-parse | 6.2.1 | 7.0.3 |
| CVE-2026-41907 | uuid (ExcelJS transitive) | 8.3.2 | 11.1.1 |

Both were medium severity. The final scan of the two patched resolutions found
no known CVEs. Nineteen focused CSV/workbook checks and the complete 70-test suite
passed after installation. The UUID override preserves CommonJS compatibility.

## Security Review

Application logging uses controlled messages; it does not emit session state,
cookies, authentication headers, browser console output, raw HTML, or raw
Playwright errors. Workbook construction does not receive authentication state.
Authentication is checked before and after screenshot capture, and image bytes
are not persisted after a detected redirect. TLS validation remains enabled.

Git-ignore verification passed for authentication state, generated workbooks,
temporary screenshots, and local validation artifacts. Generated sample
workbooks are explicitly labelled fixture evidence and must not be used for
release sign-off. Real screenshots may contain confidential application data;
the utility does not alter or redact page contents.

## Remaining Boundary

Local implementation and offline validation: PASS.

Corporate SSO, deployed Kiali selectors, actual container labels, and screenshot
layout with real workloads: NOT YET VERIFIED. No claim of live feature parity or
production release acceptance is made.

Run the following manually, using npm.cmd in this PowerShell environment:

```sh
npm run login
npm run tvt -- --release "Test-Release" --service "kafka-ui" --headed --keep-temp
```

Review the limited run and adjust selectors/layout from its actual results
before attempting the full service list. Microsoft Excel itself was not used;
workbook structure and image payloads were verified programmatically with
ExcelJS.