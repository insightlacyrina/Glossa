import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { ArchiveManager } from './management.mjs';
export function createSyncServer(options: {
  dataDir: string;
  token: string;
  staticDir?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  maxPullBytes?: number;
  lease?: { release(): void };
  management?: {
    instanceId: string;
    adminToken: string;
    backupDir: string;
    backupIntervalHours?: number;
    retentionCount?: number;
    url?: string;
    intervalMs?: number;
  };
  ai?: Record<string, unknown>;
  aiProxy?: {
    handle(req: unknown, res: unknown, context: { tokenAuthenticated: true }): Promise<unknown>;
    status(): { aiProxyAvailable: boolean; [key: string]: unknown };
    close(): void;
  };
}): {
  server: Server;
  db: DatabaseSync;
  generation: string;
  management: ArchiveManager | null;
  close(): Promise<void>;
};
