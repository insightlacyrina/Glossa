import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
export function createSyncServer(options: {
  dataDir: string;
  token: string;
  staticDir?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  maxPullBytes?: number;
}): { server: Server; db: DatabaseSync; close(): Promise<void> };
