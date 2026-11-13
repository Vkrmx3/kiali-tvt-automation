export interface AppConfig {
  environment: string;
  authenticationMode: 'storageState' | 'persistentProfile';
  kialiBaseUrl: string;
  overviewDurationSeconds: number;
  logsDurationSeconds: number;
  pageTimeoutMilliseconds: number;
  renderWaitMilliseconds: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  defaultHeadless: boolean;
}

export interface Service {
  serviceName: string;
  namespace: string;
  workload: string;
  expectedVersion?: string;
}

export interface EnvironmentProfile {
  id: string;
  label: string;
  kialiBaseUrl: string;
  production: boolean;
}

export interface OperatorInput {
  readonly environmentId: string;
  readonly release: string;
  readonly services: readonly Service[];
}

export type CaptureStatus = 'CAPTURED' | 'FAILED' | 'NOT ATTEMPTED';
export type ResultStatus = 'PASS' | 'PASS WITH WARNING' | 'FAILED';

export interface VersionCheck {
  status: 'MATCHED' | 'MISMATCH' | 'NOT FOUND' | 'AMBIGUOUS';
  deployedVersion: string | undefined;
  message: string | undefined;
}

export interface ServiceResult extends Service {
  sheetName: string;
  overviewStatus: CaptureStatus;
  logsStatus: CaptureStatus;
  versionStatus: VersionCheck['status'] | 'NOT REQUESTED' | 'NOT CHECKED' | 'CHANGED';
  deployedVersion: string | undefined;
  result: ResultStatus;
  remarks: string[];
  captureTimestamp: Date | null;
  overviewScreenshotPath: string | undefined;
  logsScreenshotPath: string | undefined;
  errorScreenshotPath: string | undefined;
  elapsedMilliseconds: number;
}

export interface RunMetadata {
  release: string;
  environment: string;
  kialiBaseUrl: string;
  startedAt: Date;
  completedAt: Date;
  logsDurationSeconds: number;
}

export interface RunOptions {
  release: string;
  configPath: string;
  settingsPath: string;
  minutes: number | undefined;
  headed: boolean;
  service: string | undefined;
  keepTemp: boolean;
  overwrite: boolean;
}