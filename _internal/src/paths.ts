import path from 'node:path';

export function projectDirectories(directory: string): { applicationDirectory: string; operatorDirectory: string } {
  const applicationDirectory = path.resolve(directory);
  return {
    applicationDirectory,
    operatorDirectory: path.basename(applicationDirectory).toLowerCase() === '_internal' ? path.dirname(applicationDirectory) : applicationDirectory,
  };
}