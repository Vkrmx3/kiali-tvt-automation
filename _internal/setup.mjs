import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_TIMEOUT = 600000;

export class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function interrupted(signal) {
  if (signal?.aborted) throw new SetupError('INTERRUPTED', 'Setup was cancelled. Double-click Run-TVT.cmd to try again.');
}

async function fileHash(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  await finished(stream, { cleanup: true });
  return hash.digest('hex');
}

async function renameReady(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (attempt === 2 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await delay(150 * (attempt + 1));
    }
  }
}

export async function readSetupManifest(directory = internalDirectory) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'setup-manifest.json'), 'utf8')); }
  catch { throw new SetupError('SETUP_CONFIG', 'Setup metadata is missing or invalid. Ask for the complete TVT folder.'); }
  const runtime = manifest?.runtime;
  if (manifest.schemaVersion !== 1 || !['source', 'compiled'].includes(manifest.mode) ||
      runtime?.platform !== 'win32' || runtime.arch !== 'x64' || !/^22\.\d+\.\d+$/.test(runtime.version ?? '') ||
      runtime.url !== `https://nodejs.org/dist/v${runtime.version}/node-v${runtime.version}-win-x64.zip` ||
      !/^[a-f0-9]{64}$/.test(runtime.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(runtime.executableSha256 ?? '')) {
    throw new SetupError('SETUP_CONFIG', 'Setup metadata does not identify an approved, pinned Windows x64 runtime.');
  }
  return manifest;
}

export async function acquireSetupLock(directory) {
  const identity = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\kiali-tvt-setup-${identity}` : `\0kiali-tvt-setup-${identity}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new SetupError('SETUP_BUSY', 'This TVT folder is already in use. Finish the other setup or TVT window first.')));
    server.listen({ path: address, readableAll: false, writableAll: false }, resolve);
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise((resolve) => server.close(resolve));
  };
}

export async function runProcess(executable, args, options = {}) {
  interrupted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure;
    child.stdout?.on('data', (data) => { stdout = (stdout + data.toString()).slice(-65536); });
    child.stderr?.on('data', (data) => { stderr = (stderr + data.toString()).slice(-65536); });
    const stop = (error) => {
      if (failure) return;
      failure = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else child.kill('SIGTERM');
    };
    const cancel = () => stop(new SetupError('INTERRUPTED', 'Setup was cancelled. Double-click Run-TVT.cmd to try again.'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = options.timeoutMilliseconds ? setTimeout(() => stop(new SetupError('SETUP_TIMEOUT', 'Setup took too long. Check network access and try again.')), options.timeoutMilliseconds) : undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
    child.once('error', () => { cleanup(); reject(new SetupError('SETUP_PROCESS', 'A required setup program could not start. Check the TVT folder and machine policy.')); });
    child.once('close', (exitCode) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    if (options.signal?.aborted) cancel();
  });
}

async function downloadArchive(url, destination, options = {}) {
  interrupted(options.signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, INSTALL_TIMEOUT);
  try {
    await new Promise((resolve, reject) => {
      const request = get(url, { signal: controller.signal }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new SetupError('RUNTIME_DOWNLOAD', 'The approved Node download was unavailable. Check network access and try again.')); return; }
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 128 * 1024 * 1024 ? new SetupError('RUNTIME_DOWNLOAD', 'The runtime download exceeded the approved size limit.') : null, chunk);
        } });
        pipeline(response, limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 })).then(resolve, reject);
      });
      request.once('error', reject);
    });
  } catch (error) {
    interrupted(options.signal);
    if (error instanceof SetupError) throw error;
    throw new SetupError('RUNTIME_DOWNLOAD', 'Unable to download the approved Node runtime. Check approved network and certificate settings; certificate verification remains enabled.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export async function prepareRuntime(directory = internalDirectory, options = {}) {
  interrupted(options.signal);
  const manifest = await readSetupManifest(directory);
  if (process.platform !== manifest.runtime.platform || process.arch !== manifest.runtime.arch) {
    throw new SetupError('PLATFORM', 'This TVT package requires 64-bit Windows. Ask for the approved package for your machine.');
  }
  const release = await acquireSetupLock(directory);
  let staged;
  const report = options.report ?? console.log;
  const run = options.run ?? runProcess;
  const runtimeDirectory = path.join(directory, 'runtime');
  const nodePath = path.join(runtimeDirectory, 'node.exe');
  const npmCliPath = path.join(runtimeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    if (await exists(nodePath) && await exists(npmCliPath) && await exists(path.join(runtimeDirectory, 'LICENSE')) &&
        await fileHash(nodePath) === manifest.runtime.executableSha256) {
      return { nodePath, npmCliPath, installed: false };
    }
    if (path.resolve(process.execPath).toLowerCase() === path.resolve(nodePath).toLowerCase()) {
      throw new SetupError('RUNTIME_INCOMPLETE', 'The bundled runtime is incomplete. Ask the maintainer to restore the complete TVT folder.');
    }
    report('Preparing the verified portable Node runtime...');
    await mkdir(directory, { recursive: true });
    staged = await mkdtemp(path.join(directory, '.runtime-'));
    const archive = path.join(staged, 'node.zip');
    if (options.archivePath) await copyFile(path.resolve(options.archivePath), archive);
    else await (options.download ?? downloadArchive)(manifest.runtime.url, archive, { signal: options.signal });
    interrupted(options.signal);
    if (await fileHash(archive) !== manifest.runtime.sha256) throw new SetupError('RUNTIME_CHECKSUM', 'Runtime archive checksum did not match. Nothing was installed.');
    const extractedRoot = path.join(staged, 'extracted');
    await mkdir(extractedRoot);
    if (options.extract) await options.extract(archive, extractedRoot);
    else {
      const result = await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', extractedRoot], { timeoutMilliseconds: INSTALL_TIMEOUT, signal: options.signal });
      if (result.exitCode !== 0) throw new SetupError('RUNTIME_EXTRACT', 'The verified runtime archive could not be extracted. Check disk space and Windows archive support.');
    }
    interrupted(options.signal);
    const extracted = path.join(extractedRoot, `node-v${manifest.runtime.version}-win-x64`);
    const candidate = path.join(extracted, 'node.exe');
    if (await fileHash(candidate) !== manifest.runtime.executableSha256) throw new SetupError('RUNTIME_CHECKSUM', 'Runtime executable checksum did not match. Nothing was installed.');
    if (!await exists(path.join(extracted, 'node_modules', 'npm', 'bin', 'npm-cli.js')) || !await exists(path.join(extracted, 'LICENSE'))) {
      throw new SetupError('RUNTIME_INCOMPLETE', 'The verified runtime archive is incomplete. Nothing was installed.');
    }
    const version = await run(candidate, ['--version'], { timeoutMilliseconds: 30000, signal: options.signal });
    if (version.exitCode !== 0 || version.stdout.trim() !== `v${manifest.runtime.version}`) throw new SetupError('RUNTIME_VERSION', 'The extracted runtime version did not match the approved version.');
    interrupted(options.signal);
    const previous = path.join(staged, 'previous-runtime');
    const replacing = await exists(runtimeDirectory);
    if (replacing) await renameReady(runtimeDirectory, previous);
    try { await renameReady(extracted, runtimeDirectory); }
    catch (error) { if (replacing) await renameReady(previous, runtimeDirectory); throw error; }
    report('Portable runtime verified and ready.');
    return { nodePath, npmCliPath, installed: true };
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }
}

function installationFailure(result, component) {
  const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(diagnostic)) {
    return new SetupError('SETUP_CERTIFICATE', `${component} could not be prepared because of a certificate error. Ask IT to check the approved certificate settings; verification remains enabled.`);
  }
  if (/EACCES|EPERM|Access is denied|permission denied/i.test(diagnostic)) {
    return new SetupError('SETUP_PERMISSION', `${component} could not be prepared because access was denied. Check folder permissions or contact the maintainer.`);
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|proxy|E401|E403/i.test(diagnostic)) {
    return new SetupError('SETUP_NETWORK', `${component} download was blocked or unavailable. Check network access and approved proxy/registry settings, then try again.`);
  }
  return new SetupError('SETUP_INSTALL', `${component} could not be prepared. Check network access, free disk space, and the complete TVT installation, then try again.`);
}

async function dependencyDescription(directory, manifest) {
  let packageText;
  let lockText = '';
  let packageJson;
  let lock;
  try {
    packageText = await readFile(path.join(directory, 'package.json'), 'utf8');
    packageJson = JSON.parse(packageText);
    if (manifest.mode === 'source') {
      lockText = await readFile(path.join(directory, 'package-lock.json'), 'utf8');
      lock = JSON.parse(lockText);
      if (!lock.packages || lock.lockfileVersion < 2) throw new Error('Missing package inventory');
    }
  } catch { throw new SetupError('SETUP_FILES', 'Application installation metadata is missing or invalid. Ask for the complete TVT folder.'); }
  const names = manifest.mode === 'source' ? [...new Set([...Object.keys(packageJson.dependencies ?? {}), 'tsx'])] : Object.keys(manifest.dependencies ?? {});
  if (!names.length) throw new SetupError('SETUP_FILES', 'The compiled TVT dependency inventory is missing. Ask for a complete package.');
  const expected = new Map();
  for (const name of names) {
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-][a-z0-9._-]*$/i.test(name)) throw new SetupError('SETUP_FILES', 'An application dependency name is invalid.');
    const version = manifest.mode === 'source' ? lock.packages[`node_modules/${name}`]?.version : manifest.dependencies[name];
    if (typeof version !== 'string' || !version) throw new SetupError('SETUP_FILES', 'An application dependency is missing its locked version.');
    expected.set(name, version);
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).update(packageText).update(lockText).digest('hex');
  return { expected, fingerprint };
}

async function dependenciesPresent(directory, expected) {
  const require = createRequire(path.join(directory, 'package.json'));
  for (const [name, version] of expected) {
    try {
      const installed = JSON.parse(await readFile(path.join(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version || !await exists(require.resolve(name))) return false;
    } catch { return false; }
  }
  return true;
}

function childEnvironment(nodePath) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${path.dirname(nodePath)}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}

async function configuredBrowser(directory, mode, env) {
  if (mode === 'persistentProfile') {
    for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      const executablePath = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (await exists(executablePath)) return { kind: 'edge', identity: `edge:${executablePath}`, executablePath };
    }
    throw new SetupError('EDGE_MISSING', 'Microsoft Edge is required by this TVT configuration. Ask IT to provide the approved Edge installation; setup will not change browsers.');
  }
  const require = createRequire(path.join(directory, 'package.json'));
  const { chromium } = require('playwright');
  const version = JSON.parse(await readFile(path.join(directory, 'node_modules', 'playwright', 'package.json'), 'utf8')).version;
  const executablePath = chromium.executablePath();
  return {
    kind: 'chromium', identity: `${version}:${executablePath}`, executablePath,
    smoke: async ({ signal } = {}) => {
      interrupted(signal);
      const server = await chromium.launchServer({ headless: true, env, timeout: 30000 });
      const cancel = () => { void server.kill().catch(() => undefined); };
      signal?.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; cancel(); }, 30000);
      try {
        interrupted(signal);
        return [executablePath, server.process().spawnfile];
      } finally {
        try { await server.close(); }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
        interrupted(signal);
        if (timedOut) throw new SetupError('BROWSER_CHECK', 'The browser verification did not finish in time.');
      }
    },
  };
}

export async function ensureSetup(directory = internalDirectory, options = {}) {
  const started = performance.now();
  interrupted(options.signal);
  const manifest = await readSetupManifest(directory);
  if (process.platform !== manifest.runtime.platform || process.arch !== manifest.runtime.arch) throw new SetupError('PLATFORM', 'This TVT folder requires 64-bit Windows.');
  const nodePath = path.join(directory, 'runtime', 'node.exe');
  const npmCliPath = path.join(directory, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!await exists(nodePath)) throw new SetupError('RUNTIME_MISSING', 'The portable runtime is missing. Ask for the complete TVT folder; no system installation is needed.');
  const release = await acquireSetupLock(directory);
  const report = options.report ?? console.log;
  const run = options.run ?? runProcess;
  const statePath = path.join(directory, '.setup-state.json');
  const env = childEnvironment(nodePath);
  let dependenciesInstalled = false;
  let browserInstalled = false;
  let dirty = false;
  try {
    report('Checking TVT prerequisites...');
    let config;
    try { config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')); }
    catch { throw new SetupError('SETUP_CONFIG', 'Application settings are missing or invalid. Ask the maintainer to check the TVT folder.'); }
    const mode = config.authenticationMode ?? 'storageState';
    if (!['storageState', 'persistentProfile'].includes(mode)) throw new SetupError('SETUP_CONFIG', 'The configured authentication mode is invalid.');
    const description = await dependencyDescription(directory, manifest);
    const entry = path.join(directory, manifest.mode === 'source' ? 'src' : 'app', manifest.mode === 'source' ? 'operator.ts' : 'operator.js');
    if (!await exists(entry)) throw new SetupError('SETUP_FILES', 'The TVT application is incomplete. Ask for the complete folder.');
    const entryArguments = manifest.mode === 'source' ? ['--import', 'tsx', entry] : [entry];
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = undefined; }
    const runInstall = async (args, component) => {
      interrupted(options.signal);
      await rm(statePath, { force: true });
      dirty = true;
      report(`Preparing ${component}. This is needed only when components are missing or changed...`);
      const progress = setInterval(() => report(`Still preparing ${component}...`), 30000);
      try {
        const result = await run(nodePath, args, { cwd: directory, env, signal: options.signal, timeoutMilliseconds: INSTALL_TIMEOUT });
        interrupted(options.signal);
        if (result.exitCode !== 0) throw installationFailure(result, component);
      } finally { clearInterval(progress); }
    };
    const installDependencies = async () => {
      if (manifest.mode !== 'source') throw new SetupError('SETUP_FILES', 'The packaged TVT application is incomplete. Ask for the complete folder; development packages will not be installed.');
      if (!await exists(npmCliPath)) throw new SetupError('RUNTIME_INCOMPLETE', 'The portable npm runtime is incomplete. Ask for the complete TVT folder.');
      await runInstall([npmCliPath, 'ci', '--include=dev', '--no-audit', '--no-fund'], 'application dependencies');
      dependenciesInstalled = true;
      if (!await dependenciesPresent(directory, description.expected)) throw new SetupError('SETUP_INSTALL', 'Application dependencies are still incomplete after setup. Ask the maintainer to check the installation.');
    };
    if (!await dependenciesPresent(directory, description.expected) || manifest.mode === 'source' && state && state.fingerprint !== description.fingerprint) await installDependencies();
    if (!state || state.fingerprint !== description.fingerprint || dependenciesInstalled) {
      const probe = await run(nodePath, [...entryArguments, '--help'], { cwd: directory, env, signal: options.signal, timeoutMilliseconds: 60000 });
      if (probe.exitCode !== 0) {
        if (manifest.mode === 'compiled') throw new SetupError('SETUP_FILES', 'The packaged application is incomplete or could not load. Ask for a complete verified folder.');
        if (!dependenciesInstalled) await installDependencies();
        const retry = await run(nodePath, [...entryArguments, '--help'], { cwd: directory, env, signal: options.signal, timeoutMilliseconds: 60000 });
        if (retry.exitCode !== 0) throw installationFailure(retry, 'application');
      }
      dirty = true;
    }
    interrupted(options.signal);
    const browser = await (options.browserProvider ?? configuredBrowser)(directory, mode, env);
    let browserFiles = state?.browser?.identity === browser.identity ? state.browser.files : undefined;
    let browserReady = Array.isArray(browserFiles) && browserFiles.length > 0;
    if (browserReady) for (const file of browserFiles) if (typeof file !== 'string' || !await exists(file)) browserReady = false;
    if (!await exists(browser.executablePath)) browserReady = false;
    if (!browserReady) {
      dirty = true;
      await rm(statePath, { force: true });
      if (browser.kind === 'edge') {
        if (!await exists(browser.executablePath)) throw new SetupError('EDGE_MISSING', 'Microsoft Edge is required. Ask IT to restore the approved Edge installation.');
        browserFiles = [browser.executablePath];
      } else {
        const installBrowser = async () => {
          const cli = path.join(directory, 'node_modules', 'playwright', 'cli.js');
          if (!await exists(cli)) throw new SetupError('SETUP_FILES', 'The installed browser setup program is incomplete. Ask for a complete TVT folder.');
          await runInstall([cli, 'install', 'chromium'], 'Chromium browser');
          browserInstalled = true;
        };
        if (!await exists(browser.executablePath) || state?.browser?.identity === browser.identity) await installBrowser();
        try { browserFiles = await browser.smoke({ signal: options.signal }); }
        catch {
          interrupted(options.signal);
          if (!browserInstalled) await installBrowser();
          try { browserFiles = await browser.smoke({ signal: options.signal }); }
          catch { throw new SetupError('BROWSER_CHECK', 'The browser could not start after setup. Check machine policy or contact the maintainer.'); }
        }
        if (!Array.isArray(browserFiles) || !browserFiles.length) throw new SetupError('BROWSER_CHECK', 'The browser installation could not be verified.');
        for (const file of browserFiles) if (!await exists(file)) throw new SetupError('BROWSER_CHECK', 'A required browser executable is missing after setup.');
      }
    }
    interrupted(options.signal);
    if (dirty || !state) {
      const stagedState = path.join(directory, `.setup-state-${randomUUID()}.tmp`);
      try {
        await writeFile(stagedState, JSON.stringify({ fingerprint: description.fingerprint, browser: { identity: browser.identity, files: browserFiles } }), { flag: 'wx', mode: 0o600 });
        await renameReady(stagedState, statePath);
      } finally { await rm(stagedState, { force: true }).catch(() => undefined); }
    }
    const checksMilliseconds = Math.round(performance.now() - started);
    report(`Setup ready (${(checksMilliseconds / 1000).toFixed(2)}s).`);
    let exitCode = 0;
    if (options.launch) {
      interrupted(options.signal);
      const result = await run(nodePath, [...entryArguments, '--data-directory', path.resolve(options.dataDirectory ?? path.dirname(directory))], { cwd: directory, env, inherit: true });
      exitCode = result.exitCode;
    }
    return { nodePath, mode: manifest.mode, dependenciesInstalled, browserInstalled, checksMilliseconds, exitCode };
  } finally { await release(); }
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { values } = parseArgs({ options: {
      'prepare-runtime': { type: 'boolean' }, 'runtime-archive': { type: 'string' },
      'setup-only': { type: 'boolean' }, 'data-directory': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log('TVT automatic setup\n\n--prepare-runtime  Maintainer: prepare the approved portable runtime.\n--runtime-archive  Maintainer: use a local archive with the same pinned checksum.\n--setup-only       Prepare missing components without starting TVT.\n--data-directory   Operator workbook and report directory.');
      return;
    }
    if (values['runtime-archive'] && !values['prepare-runtime']) throw new SetupError('ARGUMENT', '--runtime-archive requires --prepare-runtime.');
    if (values['prepare-runtime']) {
      await prepareRuntime(internalDirectory, { signal: controller.signal, archivePath: values['runtime-archive'] });
      return;
    }
    const result = await ensureSetup(internalDirectory, { signal: controller.signal, launch: !values['setup-only'], dataDirectory: values['data-directory'] });
    process.exitCode = controller.signal.aborted ? 130 : result.exitCode;
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : 'Setup failed. Check folder permissions, disk space, and approved network access.');
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();