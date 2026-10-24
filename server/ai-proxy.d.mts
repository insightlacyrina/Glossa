import type { IncomingMessage, ServerResponse } from 'node:http';
export type AIProxyConfiguration = {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxTTLSeconds?: number;
  maxPlainBytes?: number;
  maxObjects?: number;
};
export function createAIProxy(config?: AIProxyConfiguration): {
  status(): {
    aiProxyAvailable: boolean;
    aiTemporaryPlaintextAccess: boolean;
    serverCanDecryptE2EE: false;
    endpoint: string | null;
    model: string | null;
    protocol: number;
    limits: { maxObjects: number; maxPlainBytes: number; maxTTLSeconds: number };
    purpose: string;
  };
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    context?: { tokenAuthenticated?: boolean },
  ): Promise<boolean>;
  audit(): Record<string, unknown>[];
  close(): void;
};
