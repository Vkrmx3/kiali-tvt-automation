import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { projectDirectories } from '../src/paths.js';

interface LockedPackage {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const guide = [
  'KIALI TVT - START HERE',
  '',
  '1. Open services.xlsx. On Run Settings, choose the environment and enter the release name.',
  '2. On Services, enter Namespace, Service Name, and Expected Version for every service.',
  '3. Save the workbook, then double-click Run-TVT.cmd.',
  '4. Check the target and confirm. Complete SSO/MFA in the browser only when requested.',
  '5. Review the report that opens in Excel. Saved reports are in the output folder.',
  '',
  'All populated service rows run, including hidden or filtered rows.',
  'The tool uses saved values only. It never guesses the intended release version.',
  'Press Enter without a confirmation to cancel. Do not enter credentials in the launcher.',
  '',
  'The _internal folder contains application files. Do not edit, remove, or move it separately.',
  'Copy the whole TVT folder when moving the tool, including _internal.',
  'Saved login sessions remain private to your Windows account and are not included here.',
  '',
  'Portable Node.js is included. The first run prepares missing components automatically.',
  'Setup downloads may take several minutes. Later runs reuse the installed components.',
  'Internet access is needed for missing downloads; corporate certificate and access policies remain enabled.',
  'If setup fails, correct the reported network/access issue and double-click Run-TVT.cmd again.',
  'Desktop Excel is used to open completed reports. If it cannot open, the report remains saved.',
  'Contact the maintainer for setup, missing-file, environment, or permission errors.',
  '',
].join('\r\n');

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function compileApplication(root: string, output: string): void {
  const configPath = path.join(root, 'tsconfig.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  const sourceDirectory = path.join(root, 'src');
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, {
    noEmit: false, noEmitOnError: true, declaration: false, declarationMap: false,
    emitDeclarationOnly: false, sourceMap: false, inlineSourceMap: false,
    incremental: false, composite: false, rootDir: sourceDirectory, outDir: output,
  }, configPath);
  const sources = parsed.fileNames.filter((file) => !path.relative(sourceDirectory, file).startsWith('..') && !path.isAbsolute(path.relative(sourceDirectory, file)));
  if (!sources.length) throw new Error('No application source files were found.');
  const program = ts.createProgram(sources, parsed.options);
  const diagnostics = [...(loaded.error ? [loaded.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
  }
  const result = program.emit();
  if (result.emitSkipped || result.diagnostics.length) throw new Error('Application compilation did not complete.');
}

export async function packageOperator(sourceDirectory = projectRoot, outputDirectory = path.join(sourceDirectory, 'dist', 'TVT')): Promise<{ directory: string; runtimePackages: number }> {
  const { applicationDirectory: root, operatorDirectory } = projectDirectories(sourceDirectory);
  const destination = path.resolve(outputDirectory);
  if (await exists(destination)) throw new Error('The operator folder already exists. Choose a new destination; existing input and reports will not be overwritten.');
  await mkdir(path.dirname(destination), { recursive: true });
  const staged = await mkdtemp(path.join(path.dirname(destination), '.tvt-package-'));
  let runtimePackages = 0;
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string; engines?: Record<string, string>; dependencies?: Record<string, string> };
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages?: Record<string, LockedPackage> };
    if (lock.lockfileVersion < 2 || !lock.packages) throw new Error('A current npm package-lock.json is required to select the runtime dependencies.');
    const internal = path.join(staged, '_internal');
    await mkdir(path.join(internal, 'node_modules'), { recursive: true });
    for (const [location, metadata] of Object.entries(lock.packages)) {
      if (!location.startsWith('node_modules/') || metadata.dev) continue;
      if (location.split('/').some((part) => part === '..' || part === '.') || path.isAbsolute(location) || metadata.link) {
        throw new Error('Linked or unsafe dependency locations are not supported in operator packages.');
      }
      const source = path.join(root, location);
      if (!await exists(source)) {
        if (metadata.optional) continue;
        throw new Error(`Missing runtime dependency: ${location}. Complete the maintainer dependency installation first.`);
      }
      if ((await lstat(source)).isSymbolicLink()) throw new Error(`Linked runtime dependency cannot be packaged: ${location}.`);
      const installed = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as { version: string };
      if (installed.version !== metadata.version) throw new Error(`Installed dependency does not match the lockfile: ${location}.`);
      await cp(source, path.join(internal, location), {
        recursive: true,
        filter: async (candidate) => {
          if (path.relative(source, candidate).split(path.sep).includes('node_modules')) return false;
          if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`Symbolic links are not supported inside runtime dependency ${location}.`);
          return true;
        },
      });
      runtimePackages++;
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!await exists(path.join(internal, 'node_modules', name, 'package.json'))) throw new Error(`The package is missing required runtime dependency ${name}.`);
    }
    compileApplication(root, path.join(internal, 'app'));
    if (!await exists(path.join(internal, 'app', 'operator.js'))) throw new Error('The compiled operator entry point is missing.');
    const setup = await import(new URL('../setup.mjs', import.meta.url).href);
    const portable = await setup.prepareRuntime(root);
    const setupManifest = await setup.readSetupManifest(root);
    await cp(path.dirname(portable.nodePath), path.join(internal, 'runtime'), { recursive: true });
    await copyFile(path.join(root, 'setup.mjs'), path.join(internal, 'setup.mjs'));
    const dependencies = Object.fromEntries(Object.keys(manifest.dependencies ?? {}).map((name) => [name, lock.packages![`node_modules/${name}`]!.version]));
    await writeFile(path.join(internal, 'setup-manifest.json'), JSON.stringify({ ...setupManifest, mode: 'compiled', dependencies }, null, 2) + '\n');
    await writeFile(path.join(internal, 'package.json'), JSON.stringify({
      name: `${manifest.name}-operator`, version: manifest.version, private: true, type: 'module', engines: manifest.engines,
    }, null, 2) + '\n');
    for (const file of ['config.json', 'environments.json', 'LICENSE']) await copyFile(path.join(root, file), path.join(internal, file));
    await copyFile(path.join(operatorDirectory, 'services.xlsx'), path.join(staged, 'services.xlsx'));
    await mkdir(path.join(staged, 'output'));
    await copyFile(path.join(operatorDirectory, 'Run-TVT.cmd'), path.join(staged, 'Run-TVT.cmd'));
    await writeFile(path.join(staged, 'START-HERE.txt'), guide);
    if (await exists(destination)) throw new Error('The operator folder already exists. The new package was not published.');
    await rename(staged, destination);
    return { directory: destination, runtimePackages };
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/package-operator.ts [new-output-directory]');
    const result = await packageOperator(projectRoot, process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'dist', 'TVT'));
    console.log(`Operator folder: ${result.directory}`);
    console.log(`Packaged portable Node and ${result.runtimePackages} runtime dependencies. No saved sessions, screenshots, old reports, tests, or development tools were included.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Operator packaging failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void main();