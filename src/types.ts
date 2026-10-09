export interface AppConfig {
  environment: string;
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
}

export type CaptureStatus = 'CAPTURED' | 'FAILED' | 'NOT ATTEMPTED';
export type ResultStatus = 'PASS' | 'PASS WITH WARNING' | 'FAILED';

export interface ServiceResult extends Service {
  sheetName: string;
  overviewStatus: CaptureStatus;
  logsStatus: CaptureStatus;
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