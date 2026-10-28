/// <reference types="vite/client" />
interface Window {
  glossaNavigateBack?: () => boolean;
  QuietPaperNative?: {
    getRole(): 'tablet' | 'phone';
    getDeviceId(): string;
    getPlatform(): 'android';
    openDocument(id: string): void;
    readDocument(id: string, uri: string): void;
    saveDocument(id: string, uri: string, text: string, hash: string): void;
    saveDocumentVersioned(
      id: string,
      uri: string,
      text: string,
      sourceHash: string,
      pendingHash: string,
    ): void;
    getPendingSource(id: string, uri: string): void;
    exportDocument(id: string, name: string, mime: string, text: string): void;
    beginExport(id: string, name: string, mime: string): void;
    appendExportChunk(id: string, sessionId: string, sequence: string, base64: string): void;
    completeExport(id: string, sessionId: string): void;
    getPendingExports(id: string): void;
    discardExport(id: string, sessionId: string): void;
    getPendingWrites(id: string): void;
    getRuntimeDiagnostics?(id: string): void;
    getRecognitionStatus?(id: string, language: string): void;
    downloadRecognitionModel?(id: string, language: string): void;
    recognizeInk?(id: string, json: string): void;
    recognizeImage?(id: string, json: string): void;
    getSourceSnapshot(id: string, uri: string): void;
    retryPendingWrite(id: string, uri: string): void;
    resolveSourceConflict(id: string, uri: string, text: string, sourceHash: string): void;
  };
}
