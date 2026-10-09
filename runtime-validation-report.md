# Runtime Validation Report

Date: 2026-10-10

Target: local kiali-tvt-automation CLI. No corporate Kiali login or live workload
collection was attempted. No CI/CD or production infrastructure was created.

## Environment

- Windows; Node.js 22.13.1; TypeScript 5.9.3.
- Playwright 1.64.0 with installed Chromium; real browser tests on loopback only.
- Installed Microsoft Edge verified with a fresh, isolated persistent profile and synthetic loopback cookie.
- Vitest 4.1.11; ExcelJS 4.4.0; csv-parse 7.0.3.
- No database, Docker, Azure, or Kubernetes runtime dependency.
- PowerShell execution policy blocks npm.ps1; npm.cmd works without policy changes.

## Final Checks

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| `npm run build` | PASS | 0 | Strict TypeScript compilation with no emit. |
| `npm test` | PASS | 0 | 106 passed, 0 failed, 0 skipped, across seven test files. |
| `npm run login -- --help` | PASS | 0 | Login entry point loads without opening a browser. |
| `npm run tvt -- --help` | PASS | 0 | All documented execution options are available. |
| Dedicated Edge profile round trip | PASS | 0 | Real Edge retained a synthetic loopback cookie after closing and reopening the same temporary profile. No Kiali navigation or existing user profile access. |
| `npm run sample:workbook` | PASS | 0 | Generated and reopened a non-empty XLSX with 3 sheets, 2 service rows, and 4 embedded PNGs. |

The final standalone validation run passed all six assertions. Its local,
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
- Log text, headings, and buttons containing login/authentication/401/403 wording
  do not establish authentication failure. Known login URLs, visible password
  inputs, and stable visible login forms provide the positive evidence.
- A login detection produces a separate masked authentication-check PNG and one
  target-page retry. Only positive evidence remaining after the retry and final
  check skips later services. Recovery continues the run with a warning.
- API 401/403 and ordinary navigation failures remain service-scoped; they do not
  set global authentication failure. Login pages are not embedded as evidence.
- Both authentication modes use one context per run. Unit tests verify the
  dedicated Edge channel/path, storage-state initialization, and cleanup.
- Non-read-only requests are blocked. Cancelled superseded log requests are
  tolerated. Tests isolate KIALI_BASE_URL to their temporary loopback server.
- The full collector-to-workbook flow returns failure status after writing a
  report, honors keep-temp, and removes only verified current-run evidence.

## Fixes Verified

- Removed body-text authentication heuristics and the global API-401 listener.
  Added origin/path-only diagnostic URL logging and confirmed retry handling.
- Added optional `authenticationMode: persistentProfile` using installed Edge
  and `auth/kiali-edge-profile`; `storageState` remains the default. No package
  dependency changes were needed for this authentication update.
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
no known CVEs at the original dependency assessment. Nineteen focused
CSV/workbook checks passed after installation; the current complete suite has
106 passing tests. The UUID override preserves CommonJS compatibility.

## Security Review

Application logging uses controlled messages; it does not emit session state,
cookies, authentication headers, browser console output, raw HTML, or raw
Playwright errors. Workbook construction does not receive authentication state.
Authentication is checked before and after evidence capture. Normal evidence
images are not persisted after a detected login redirect. A separate
`authentication-check.png` masks forms, inputs, editable fields, and image/SVG/
canvas content; it is never embedded in Excel. Diagnostic console URLs contain
only origin and pathname, not URL credentials, queries, or fragments. TLS
validation remains enabled.

Git-ignore verification passed for authentication state, the entire dedicated
Edge profile, authentication diagnostics, generated workbooks, temporary
screenshots, and local validation artifacts. Generated sample
workbooks are explicitly labelled fixture evidence and must not be used for
release sign-off. Real screenshots may contain confidential application data;
the utility does not alter or redact page contents.

## Remaining Boundary

Local implementation and offline validation: PASS.

Corporate SSO, deployed Kiali selectors, actual container labels, and screenshot
layout with real workloads: NOT YET VERIFIED. No claim of live feature parity or
production release acceptance is made.

Run the following manually, using npm.cmd in this PowerShell environment:

```powershell
npm.cmd run login
npm.cmd run tvt -- --release "VDI-Auth-Check" --service "security-movement-out-v1" --headed --keep-temp
```

To test Edge mode, select `authenticationMode: persistentProfile` in the VDI
configuration before running login. Keep the profile and session data in VDI;
do not transfer them to the outside workstation.

Review the limited run and adjust selectors/layout from its actual results
before attempting the full service list. Microsoft Excel itself was not used;
workbook structure and image payloads were verified programmatically with
ExcelJS.