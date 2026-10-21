# Runtime Validation Report

Date: 2026-10-21

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
| `npm test` | PASS | 0 | 134 passed, 0 failed, 0 skipped, across seven test files. |
| `npm run login -- --help` | PASS | 0 | Login entry point loads without opening a browser. |
| `npm run tvt -- --help` | PASS | 0 | All documented execution options are available. |
| Dedicated Edge profile round trip | PASS | 0 | Real Edge retained a synthetic loopback cookie after closing and reopening the same temporary profile. No Kiali navigation or existing user profile access. |
| `npm run sample:workbook` | PASS | 0 | Generated and reopened a non-empty XLSX with 3 sheets, 2 service rows, and 4 embedded PNGs. |

The final standalone validation run passed all six assertions. Its local,
Git-ignored machine-readable result is
[.tsupgrader/runtime-validation/standalone-result.json](.tsupgrader/runtime-validation/standalone-result.json).

The first local full-suite run exceeded its 240-second validation budget, and
the Edge smoke check exceeded 90 seconds. The validation-only limits were raised
to 480 and 180 seconds; the unchanged assertions passed on rerun. Application
page timeouts and individual test assertions were not relaxed.

## Performance Results

Measured on this Windows workstation using the same three sequential loopback
services, 24-hour custom window, 1920x1080 viewport, 1000 ms render budget,
80-entry fixture data, All lines, application-only containers, and six PNGs.
These are synthetic fixture results, not measurements inside VDI. No target
Kiali URL was accessed. Screenshot quality and evidence checks were unchanged.

| Measurement | Baseline | Optimized |
| --- | --- | --- |
| Collection, 3 services | 13.526 s | 10.093 s |
| First service | 5.637 s | 5.861 s |
| Second service | 3.989 s | 2.171 s |
| Third service | 3.885 s | 2.041 s |
| Render-settle stage, cumulative | 6.238 s | 1.450 s |
| Log requests | 9 | 9 |
| Captured images | 6 | 6 |
| Workbook creation and verified read-back | Not measured in initial baseline | 0.859 s |

Collection improved by approximately 25.4% (1.34x). The 2x end-to-end aspiration
was not met. Warm-service mean improved from 3.937 s to 2.106 s (about 46.5%),
while first-service timing did not improve in this single comparison. The fixture
is much smaller than a real day's production logs; cold-start variance, backend
latency, and larger payloads can dominate the VDI result.

Preserved, Git-ignored evidence:
- [temp/performance-baseline-profiled.json](temp/performance-baseline-profiled.json)
- [temp/performance-optimized-standalone.json](temp/performance-optimized-standalone.json)

The full suite also runs the benchmark, but its warm-process result was not used
to replace the standalone comparison. This optimization does not reduce the number
of log requests: it removes serial waiting between UI changes before the final
view is requested. No requests or log data are silently discarded.

Implemented improvements:
- Bounded DOM/font settling replaces unconditional sleeps; pending Kiali data
  requests and loading indicators are still awaited, including slow Overview data.
- Password/form observations and log-control/scroll/banner observations are batched.
- Log readiness returns booleans instead of copying whole log text to Node.
- A healthy page is reused; failed services get a replacement page. All pages and
  the shared authenticated context are still closed reliably.
- `--profile` reports CLI bootstrap and cumulative stage durations for browser
  startup/cleanup, navigation, readiness, controls, reloads, capture, file writes,
  and workbook image/layout/write/verification stages.

Caching was audited: Playwright routing disables HTTP caching. The existing
mutation-blocking interceptor was retained; no undocumented cache override,
manual authenticated-response cache, or weakened read-only policy was introduced.
Full SPA navigation, PNG encoding, Excel compression, and workbook verification
remain unchanged because the evidence did not justify a riskier change. No
service concurrency was introduced.

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
- Custom Logs URLs with exact from/to millisecond bounds; the default interval
  is 24 elapsed hours. The same bounds are used across services and retries,
  independently of Overview duration and daylight-saving offsets.
- Explicit proxy deselection, numeric-valued All lines options, asynchronous
  log reloads, pausing restored refresh, and top-left log-pane positioning.
- Nested and wrapping log scroll viewports are reset to their actual top-left
  positions, without scrolling unrelated panels. Normal Logs PNG capture passes,
  and later movement of the internal scroll pane is rejected before capture.
- The actual tsx execution path runs in a subprocess against the local fixture
  server. ReactVirtualized grid tests reproduce zero-height layout wrappers and
  delayed first-row mounting, and verify saved PNGs after both offsets reach zero.
- The Spring Boot startup banner must be visible in both the pane and viewport.
  Missing/off-screen banners fail Logs while preserving Overview and continuing
  to later services. Pre-capture checks reject changed proxy/line settings,
  moved scroll positions, and shifted time bounds.
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
- Performance profiling, delayed chart data, delayed DOM rendering, intermediate
  log fetches, healthy-page reuse, and fresh-page failure recovery are covered.

## Fixes Verified

- The earlier 1000 ms render setting is retained as a maximum settle budget;
  a quiet DOM can now finish earlier. All readiness, authentication, range,
  container, scroll, and banner checks remain enabled. End-to-end VDI runtime
  has not been benchmarked by this agent.
- Reproduced `ReferenceError: __name is not defined` in the scroll callback under
  tsx. Its injected function-name helper was absent in the browser, although
  Vitest's transform passed the earlier tests. Removed the local named callback
  and added same-runtime regression coverage.
- The inspected `#logsText [role="grid"][aria-label="grid"]` now takes precedence
  over wrapper-based discovery. A visible grid works even below a zero-height
  wrapper. Top-row rendering is verified with a bounded wait, and unexpected
  scroll-stage errors receive a controlled diagnostic message.
- Reproduced the reported banner failure with a scrollbar on an inner div or a
  wrapper around the log text. The old helper reset only the first content
  element. Scrolling, offset checks, and banner visibility now share the resolved
  log viewport. Configuration and authentication handling were not changed.
- Replaced reliance on preset time-range menu options with the user-provided
  Custom URL format. The collector pins one end time, defaults to a one-day
  interval, and verifies unchanged from/to bounds through capture and retries.
- Logs evidence now requires All lines, proxy exclusion, top-left positioning,
  and a visible Spring Boot banner. Fixture tests expose the banner only after
  selecting All lines and deliberately auto-scroll new data to the bottom.
  The utility changes display controls and scroll position, never log contents.
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
134 passing tests. The UUID override preserves CommonJS compatibility.

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

For the performance update, sync these changed source files to VDI:
`src/collect.ts`, `src/kiali.ts`, `src/logger.ts`, `src/run-tvt.ts`,
`src/screenshots.ts`, `src/types.ts`, and `src/workbook.ts`.
No dependency installation or configuration/authentication/CSV changes are needed.
Preserve the VDI's environment and session/profile data.

Run the following manually inside VDI, comparing the same service, browser mode,
and retained log data before and after:

```powershell
npm.cmd run build
npm.cmd run tvt -- --release "VDI-Performance-Check" --service "batchfile-transformer-v1" --minutes 1440 --keep-temp --profile
```

To test Edge mode, select `authenticationMode: persistentProfile` in the VDI
configuration before running login. Keep the profile and session data in VDI;
do not transfer them to the outside workstation.

Review the limited run and adjust selectors/layout from its actual results
before attempting the full service list. Microsoft Excel itself was not used;
workbook structure and image payloads were verified programmatically with
ExcelJS.

The banner must actually exist in retained logs inside the selected window.
Non-Spring services, disabled banners, rotated logs, or startup outside the
window cannot meet this startup-evidence requirement; the utility reports that
limitation instead of inventing a banner or silently widening the interval.