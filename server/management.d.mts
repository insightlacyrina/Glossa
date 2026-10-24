import type { DatabaseSync } from 'node:sqlite';
export class ManagementError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export interface ManagedConfig {
  version: 1;
  instanceId: string;
  host: string;
  port: number;
  token: string;
  adminToken: string;
  dataDir: string;
  backupDir: string;
  staticDir?: string;
  allowedOrigins: string[];
  backupIntervalHours: number;
  retentionCount: number;
  ai: { enabled: boolean; endpoint: string; model: string; apiKey: string };
}
export type BackupRecord = {
  id: string;
  createdAt: string | null;
  bytes?: number;
  sha256?: string;
  verified: boolean;
  projects?: number;
  operations?: number;
  instanceId?: string;
  reason?: string;
  error?: string;
};
export const databaseName: string;
export function validateManagedConfig(input: unknown): ManagedConfig;
export function readManagedConfig(path: string): ManagedConfig;
export function atomicJSON(path: string, value: unknown): void;
export function fsyncFile(path: string): void;
export function fsyncDirectory(path: string): void;
export function acquireDatabaseLease(dataDir: string): { release(): void };
export function leaseIsHeld(dataDir: string): boolean;
export function archiveProjects(
  db: DatabaseSync,
): { id: string; mode: string; operations: number; lastReceivedAt: string | null }[];
export function verifyDatabase(path: string): { projects: number; operations: number };
export function verifyBackup(backupDir: string, id: string): Promise<BackupRecord>;
export function listBackups(backupDir: string): Promise<BackupRecord[]>;
export class ArchiveManager {
  constructor(options: {
    db: DatabaseSync;
    dataDir: string;
    backupDir: string;
    instanceId: string;
    backupIntervalHours?: number;
    retentionCount?: number;
    intervalMs?: number;
    now?: () => number;
    fault?: (point: string) => void;
  });
  start(): Promise<void>;
  status(): {
    lastAt: string | null;
    nextAt: string | null;
    lastError: string | null;
    intervalHours: number;
    retentionCount: number;
  };
  create(reason?: string, options?: { retain?: boolean }): Promise<BackupRecord>;
  close(): Promise<void>;
}
export function restoreArchive(
  config: ManagedConfig,
  id: string,
  options?: { fault?: (point: string) => void },
): Promise<{ id: string; safetyBackupId: string | null; at: string }>;
