# Runtime Validation Report

## Actual Root Reorganization (2026-11-13)

The actual workspace root is now operator-facing: Run-TVT.cmd, services.xlsx,
output/, START-HERE.txt, and _internal/. Git/editor housekeeping remains at the
root and is excluded from the normal VS Code Explorer view. Implementation files
were physically moved; this is not just a filtered view of the old source layout.

Moved 18 internal items, including source, tests, scripts, dependencies, config,
maintainer docs, generated packages, legacy auth, and temporary evidence. Verified
26 source/test/script file hashes after moving. The input workbook hash was
unchanged and the output folder was not moved or cleared. Nothing was committed,
pushed, or reset.

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| Relocated launcher bootstrap | PASS | 0 | Actual tsx entry point loads from _internal; default data directory remains the outer root. |
| Strict TypeScript validation | PASS | 0 | Compiler and project config both resolve under _internal. |
| CLI, input, workbook, and packaging tests | PASS | 0 | 83 focused tests passed from the relocated test root. |
| Browser-backed entry points | PASS | 0 | 5 focused tests passed: actual tsx, prepared run, operator flow, Excel version flow, and legacy CLI collection/report flow. |
| Relocated private-state ignore rules | PASS | 0 | Auth/profile data, temporary evidence, node_modules, and generated packages remain ignored. |

Shared directory resolution keeps configuration/auth/temp inside the application
folder and the editable workbook/final reports outside. Packaging and the sample
workbook script use the same rule. Maintainer npm/node commands now run from
_internal, or use npm --prefix _internal from the outer root.

These are focused relocation checks, not a new full-suite result. No production
Kiali access, login, or desktop Excel launch occurred. Existing live-acceptance
requirements remain unchanged. Earlier sections below retain historical paths
as recorded at the time.

## Operator Handover Package (2026-11-13)

Generated an operator-only folder at `dist/TVT`. Its outer level contains the
launcher, input workbook, empty output folder, short operator guide, and one
required `_internal` folder. Development sources remain in the repository.

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| Packaging, CLI, and input regressions | PASS | 0 | 73 passed across tests/package-operator.test.ts, tests/cli.test.ts, and tests/services.test.ts. |
| Strict TypeScript validation | PASS | 0 | All application, packaging-script, and test types checked with no emit. |
| Actual operator package build | PASS | 0 | Application compiled; 199 installed runtime packages matched the lockfile. |
| Relocated package validation | PASS | 0 | A temporary copy outside the repository, in a path containing spaces, ran its compiled help, fixture input validation, and settings preparation. |

The relocated check disabled NODE_PATH and confirmed that no development checkout
was needed. Its setup backup remained under `_internal/temp`; the top-level file
list stayed unchanged. The real packaged workbook was compared byte-for-byte
before and after the check and was not modified. Temporary fixture copies were removed.

Packaging tests verify that auth state, temporary evidence, old reports, source
tests, and environment-variable files are excluded, development-only dependencies
are omitted, an existing destination is never overwritten, and failed builds do
not leave a partial distribution. Runtime dependencies are copied, not installed
or downloaded. Generated distribution files remain ignored by Git.

This was focused packaging validation, not a rerun of the full browser suite.
Collection, Logs, authentication logic, and evidence generation were unchanged.
No corporate Kiali session or desktop Excel application was opened. Approved
Node.js and the configured browser remain target-machine prerequisites; the
existing manual VDI/SSO/desktop-Excel acceptance boundary still applies.

## Excel-Driven Operator Launcher (2026-11-12)

Implemented the approved Excel-input and double-click Windows workflow. The input
now includes Run Settings with an environment dropdown and release name; all
existing service rows and version values were preserved with a backup. Environment
selection uses explicit DEV/PRD profiles, independent of the CLI URL override.

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| Strict TypeScript compilation | PASS | 0 | `node node_modules/typescript/bin/tsc --noEmit --pretty false` |
| Complete regression suite | PASS | 0 | 212 passed, 0 failed, 0 skipped, across 7 test files; 90-second validation-only test limit. |
| Real launcher entry point | PASS | 0 | `node --import tsx src/operator.ts --help` |
| Actual input workbook preparation | PASS | 0 | `--prepare-input` plus read-back: Run Settings active, DEV/PRD dropdown, 3 service rows retained, text version column. |
| End-to-end operator workflow | PASS | 0 | Local login, confirmed saved input, capture, version outcomes, verified output, and mocked report delivery. |

Final evidence: [temp/operator-launcher-final-tests.json](temp/operator-launcher-final-tests.json).
The first complete run passed 210 tests and timed out in two browser-related tests.
Both passed unchanged when rerun alone. An intermediate rerun was interrupted by
terminal tooling and was not counted. The final uninterrupted run passed all 212
tests without changing assertions, application timeouts, or the test configuration.

Added coverage includes profile/URL consistency, immutable workbook snapshots,
missing settings, preserved input backups, environment-isolated auth directories,
exclusive run locking, saved-session checks, automatic SSO completion detection,
authentication timeouts, HTTP access errors, cancellation, missing prerequisites,
unwritable output folders, verified report delivery, and Excel-opening fallback.
The compact Summary retains count alignment, exact version values, links, and
non-overlapping evidence, and verifies its headers, identities, and totals.

Collection, Kiali selectors, screenshot safeguards, and the Logs implementation
were not changed. No dependencies were added, and no commits or pushes were made.
Environment endpoints were taken from the existing project settings and the
user-provided production endpoint, not discovered through live requests.

Local automated validation: PASS. No corporate SSO or Kiali access was attempted;
the new Excel opener was mocked rather than opening desktop Excel during tests.
A maintainer must verify the configured targets and perform one controlled VDI
acceptance run before handing this workflow to operators, including successful
SSO continuation, visible Run Settings/dropdown behavior, and desktop Excel opening.
The Environment and Release Name cells are intentionally blank for operator input.

## Overview Version Validation (2026-11-04)

Scope: per-service Expected Version input, read-only comparison against the exact
Overview Labels `version=...` label, collection outcomes, and report integrity.
No corporate Kiali session, live workload, or desktop Excel application was opened.
The Logs implementation and deferred speed optimizations were not changed.

| Check | Status | Exit code | Evidence |
| --- | --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit --pretty false` | PASS | 0 | Strict TypeScript validation. |
| Full Vitest run with `--testTimeout=90000` | PASS | 0 | 180 passed, 0 failed, 0 skipped, across 7 files. |
| Default Excel input through collection and output | PASS | 0 | Expected/actual values, failure exit code for a mismatch, success for a selected matching service, retained screenshots, and workbook read-back. |
| Input workbook update | PASS | 0 | Namespace and Service Name preserved; Expected Version added as a text column; missing values rejected before browser startup. |

Machine-readable evidence: [temp/version-validation-tests.json](temp/version-validation-tests.json).
The default 45-second test limit initially timed out both full CLI workflow tests
(178 passed, 2 timed out). A sequential rerun with a validation-only 90-second
per-test limit passed every unchanged assertion; those two workflows completed
in approximately 15.1 and 12.4 seconds. Application timeouts and the repository's
test configuration were not changed. The initially interrupted type-check batch
was rerun independently and passed.

New coverage includes exact matches and mismatches, the separate numeric Version
field, namespaced label keys, hidden text, missing/conflicting labels, multiple
Labels cards, PatternFly card variants, changes during screenshot capture,
confirmed authentication failures, continuation of Logs and later services,
the actual tsx CLI runtime, and saved version-result tampering detection.

Environment: Windows, Node.js 22.23.4, existing Playwright Chromium and Vitest.
The loopback fixture server and browser started successfully in the tests. No
database or container infrastructure is required. Local validation: PASS.

Live Kiali DOM compatibility and deployed versions remain UNVERIFIED. Fill every
Expected Version cell in [services.xlsx](services.xlsx), then validate one service
inside VDI. The input values are deliberately blank; the observed screenshot
version was not assumed to be the desired release target.

## Earlier Validation Record

The following sections retain the previous validation history, not a claim that
the deferred performance changes were reintroduced.

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
| `npm test` | PASS | 0 | 130 passed, 0 failed, 0 skipped, across seven test files. |
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

## Fixes Verified

- Reduced the configured extra render delay from 5000 to 1000 milliseconds per
  tab, removing 8 seconds of fixed waiting from two successful initial captures.
  All readiness, authentication, range, container, scroll, and banner checks stay
  enabled. Console progress now includes Overview, Logs, and service elapsed
  seconds. Actual end-to-end VDI runtime has not been benchmarked by this agent.
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
130 passing tests. The UUID override preserves CommonJS compatibility.

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
npm.cmd run tvt -- --release "VDI-Startup-Check" --service "security-movement-out-v1" --minutes 1440 --headed --keep-temp
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