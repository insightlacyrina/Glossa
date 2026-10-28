export type RuntimeDiagnostic = {
  at: number;
  kind: 'renderer-exit';
  didCrash: boolean;
  priority: number;
  osApi: number;
  webViewPackage: string;
  webViewVersion: string;
  appVersion: string;
};
export type NativeReply = {
  requestId: string;
  ok: boolean;
  type: string;
  uri?: string;
  name?: string;
  text?: string;
  sha256?: string;
  baseSha256?: string;
  error?: string;
  sourceText?: string;
  sourceSha256?: string;
  unavailable?: boolean;
  /** Set only after the source provider was actually reached; local errors do not imply offline. */
  sourceReachable?: boolean;
  metadataWarning?: string;
  sessionId?: string;
  bytes?: number;
  sequence?: number;
  pending?: boolean;
  runtime?: RuntimeDiagnostic[];
  available?: boolean;
  downloaded?: boolean;
  language?: string;
  engine?: string;
  candidates?: (string | { text: string })[];
  objectIds?: string[];
};
type NativeMethod =
  | 'openDocument'
  | 'readDocument'
  | 'saveDocument'
  | 'saveDocumentVersioned'
  | 'getPendingSource'
  | 'exportDocument'
  | 'beginExport'
  | 'appendExportChunk'
  | 'completeExport'
  | 'getPendingExports'
  | 'discardExport'
  | 'resolveSourceConflict'
  | 'getPendingWrites'
  | 'getRuntimeDiagnostics'
  | 'getSourceSnapshot'
  | 'retryPendingWrite'
  | 'getRecognitionStatus'
  | 'downloadRecognitionModel'
  | 'recognizeInk'
  | 'recognizeImage';
export function nativeRequest(
  method: NativeMethod,
  args: string[] = [],
  signal?: AbortSignal,
): Promise<NativeReply> {
  const bridge = window.QuietPaperNative as unknown as
    | Record<string, (...args: string[]) => void>
    | undefined;
  if (!bridge?.[method]) return Promise.reject(new Error('此操作需要 Android 原生文件访问'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('操作已取消'));
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('quietpaper-native', listener);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('操作已取消'));
    };
    const listener = (event: Event) => {
      const result = (event as CustomEvent<NativeReply>).detail;
      if (result.requestId !== id) return;
      cleanup();
      if (result.ok) resolve(result);
      else reject(Object.assign(new Error(result.error ?? '原生文件操作失败'), { reply: result }));
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error('原生文件访问仍未完成'));
      },
      method === 'completeExport' || method === 'downloadRecognitionModel' ? 600_000 : 120_000,
    );
    window.addEventListener('quietpaper-native', listener);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      bridge[method](id, ...args);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
export async function exportNativeText(
  name: string,
  text: string,
  mime = 'application/json',
): Promise<NativeReply> {
  if (!window.QuietPaperNative?.beginExport)
    return nativeRequest('exportDocument', [name, mime, text]);
  const begun = await nativeRequest('beginExport', [name, mime]);
  if (!begun.sessionId) throw new Error('导出会话未建立');
  const encoder = new TextEncoder();
  let sequence = 0;
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + 64 * 1024, text.length);
    // Preserve astral symbols when a UTF-16 surrogate pair straddles a chunk.
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    )
      end--;
    const bytes = encoder.encode(text.slice(offset, end));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 4096)
      binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    await nativeRequest('appendExportChunk', [begun.sessionId, String(sequence++), btoa(binary)]);
    offset = end;
  }
  return nativeRequest('completeExport', [begun.sessionId]);
}
export function downloadText(name: string, text: string, mime = 'application/json') {
  if (window.QuietPaperNative) {
    void exportNativeText(name, text, mime).catch((err) =>
      window.dispatchEvent(new CustomEvent('quietpaper-error', { detail: err.message })),
    );
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
