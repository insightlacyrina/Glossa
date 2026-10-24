import type { ManagedConfig } from './management.mjs';
import type { createSyncServer } from './app.mjs';
export function localServerURL(config: ManagedConfig): string;
export function managedStatus(config: ManagedConfig): Promise<any>;
export function runManagedCommand(
  command: string,
  config: ManagedConfig,
  id?: string,
): Promise<any>;
export function serveManaged(
  config: ManagedConfig,
  options?: { onReady?: (value: unknown) => void },
): Promise<ReturnType<typeof createSyncServer>>;
