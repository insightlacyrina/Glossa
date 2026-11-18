export const GOOGLE_AI_STUDIO = 'https://generativelanguage.googleapis.com/v1beta';

export type ModelKind = 'vision' | 'embedding';
export type VisionPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type CatalogModel = { id: string; name: string; kind: ModelKind };
export type ModelStatus = {
  loading: boolean;
  models: CatalogModel[];
  selected: Partial<Record<ModelKind, string>>;
  error?: string;
};

export function modelEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入完整的 API 地址');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('API 地址应使用 HTTPS 或本机 HTTP，并且只填写服务地址');
  url.pathname =
    url.pathname.replace(/\/(?:chat\/completions|embeddings|models)\/?$/, '').replace(/\/+$/, '') ||
    '/';
  return url;
}

class ModelRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number,
    readonly providerLimit: boolean,
  ) {
    super(status === 429 ? '外部模型暂时达到调用限额' : `外部模型请求失败（${status}）`);
  }
}

const REFRESH_MS = 5 * 60_000;
const DEFAULT_COOLDOWN = 60_000;
const MAX_RESPONSE_BYTES = 6_000_000;

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES)
    throw new Error('外部模型响应过大或缺失');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('外部模型响应过大');
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function modelPriority(id: string, kind: ModelKind) {
  const key = id.toLowerCase();
  const version = /(?:gemini-embedding-|gemini-|text-embedding-)(\d+)(?:\.(\d+))?/.exec(key);
  const generation = Math.min(99, Number(version?.[1] ?? 0) * 10 + Number(version?.[2] ?? 0));
  const experimental = /preview|experimental|(?:^|[-_])exp(?:[-_]|$)/.test(key);
  const serviceClass =
    kind === 'embedding'
      ? /small/.test(key)
        ? 3
        : /large/.test(key)
          ? 1
          : 2
      : /flash-lite|mini|nano|small/.test(key)
        ? 2
        : /flash/.test(key)
          ? 3
          : 1;
  return (experimental ? 0 : 1000) + serviceClass * 100 + generation;
}

function catalogModels(value: unknown, google: boolean): CatalogModel[] {
  const result: CatalogModel[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = google ? String(entry.name ?? '').replace(/^models\//, '') : String(entry.id ?? '');
    if (!/^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(id) || id.includes('..')) continue;
    const name = typeof entry.displayName === 'string' ? entry.displayName.slice(0, 120) : id;
    const methods = Array.isArray(entry.supportedGenerationMethods)
      ? entry.supportedGenerationMethods
      : [];
    const capabilities = entry.capabilities ?? {};
    const modalities = entry.modalities?.input ?? entry.input_modalities ?? [];
    const embedding = google
      ? methods.includes('embedContent') || methods.includes('batchEmbedContents')
      : capabilities.embeddings === true || /(?:embedding|text-embed|embed-)/i.test(id);
    const imageOutput =
      /image-generation|(?:^|[-/])imagen|flash-image|pro-image|image-preview|nano-banana/i.test(id);
    const vision =
      !imageOutput &&
      (google
        ? methods.includes('generateContent') &&
          /^gemini-\d/i.test(id) &&
          !/(?:tts|audio|live|robotics)/i.test(id)
        : capabilities.vision === true ||
          (Array.isArray(modalities) && modalities.includes('image')) ||
          /(?:gpt-(?:4o|4\.1|5)|(?:^|[-/])vision|qwen.*(?:vl|vision)|claude-(?:3|4)|gemini-\d)/i.test(
            id,
          ));
    if (embedding) result.push({ id, name, kind: 'embedding' });
    else if (vision) result.push({ id, name, kind: 'vision' });
  }
  return result;
}

function rateLimit(response: Response, payload: unknown) {
  const now = Date.now();
  const retryAfter = response.headers.get('Retry-After');
  const headerTime = retryAfter
    ? /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? now + Number(retryAfter) * 1000
      : Date.parse(retryAfter)
    : 0;
  const details = JSON.stringify(payload ?? {}).slice(0, 24_000);
  const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(details);
  const providerLimit =
    response.status === 429 &&
    /spend[- _]?based|project[- _]wide|account[- _]wide|all models|credit balance|billing hard limit|insufficient_quota/i.test(
      details,
    );
  const delayTime = retryDelay ? now + Number(retryDelay[1]) * 1000 : 0;
  return new ModelRequestError(
    response.status,
    Math.max(
      now + 1000,
      Number.isFinite(headerTime) ? headerTime : 0,
      delayTime,
      headerTime || delayTime ? 0 : now + DEFAULT_COOLDOWN,
    ),
    providerLimit,
  );
}

export class AutoModelRouter {
  private readonly base: string;
  private readonly google: boolean;
  private readonly session = new AbortController();
  private readonly listeners = new Set<(status: ModelStatus) => void>();
  private readonly cooling = new Map<string, number>();
  private nextRefresh = 0;
  private providerReadyAt = 0;
  private catalogRequest?: Promise<void>;
  private current: ModelStatus = { loading: false, models: [], selected: {} };

  constructor(
    endpoint: string,
    private readonly key: string,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const url = modelEndpoint(endpoint || GOOGLE_AI_STUDIO);
    if (!key.trim()) throw new Error('请输入 API 密钥');
    this.google = url.hostname === 'generativelanguage.googleapis.com';
    this.base = this.google ? GOOGLE_AI_STUDIO : url.href.replace(/\/$/, '');
  }

  subscribe(listener: (status: ModelStatus) => void) {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(change: Partial<ModelStatus>) {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener(this.current);
  }

  dispose() {
    this.session.abort();
    this.listeners.clear();
  }

  private async json(path: string, signal: AbortSignal, body?: object): Promise<any> {
    const combined = AbortSignal.any([signal, this.session.signal, AbortSignal.timeout(45_000)]);
    combined.throwIfAborted();
    const response = await this.request(this.base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.google ? { 'x-goog-api-key': this.key } : { Authorization: `Bearer ${this.key}` }),
      },
      redirect: 'error',
      signal: combined,
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await readResponse(response, combined).catch(() => null);
      combined.throwIfAborted();
      throw rateLimit(response, payload);
    }
    const payload = await readResponse(response, combined);
    combined.throwIfAborted();
    return payload;
  }

  async refresh(force = false): Promise<void> {
    this.session.signal.throwIfAborted();
    if (this.catalogRequest) return this.catalogRequest;
    if (Date.now() < this.providerReadyAt || (!force && Date.now() < this.nextRefresh)) return;
    this.update({ loading: true, error: undefined });
    this.catalogRequest = (async () => {
      try {
        const results = new Map<string, CatalogModel>();
        const tokens = new Set<string>();
        let token = '';
        for (let page = 0; page < 8; page++) {
          const parameters = token ? `?pageToken=${encodeURIComponent(token)}` : '';
          const result = await this.json(`/models${parameters}`, this.session.signal);
          for (const model of catalogModels(
            this.google ? result?.models : result?.data,
            this.google,
          ))
            results.set(model.id, model);
          token =
            this.google && typeof result?.nextPageToken === 'string' ? result.nextPageToken : '';
          if (!token || tokens.has(token)) break;
          tokens.add(token);
        }
        const models = [...results.values()].sort(
          (a, b) =>
            modelPriority(b.id, b.kind) - modelPriority(a.id, a.kind) || a.id.localeCompare(b.id),
        );
        this.nextRefresh = Date.now() + REFRESH_MS;
        this.update({
          models,
          error: models.length ? undefined : '当前地址未返回可用于识别或搜索的模型',
        });
      } catch (error) {
        if (this.session.signal.aborted) return;
        if (error instanceof ModelRequestError && error.status === 429)
          this.providerReadyAt = Math.max(this.providerReadyAt, error.retryAt);
        this.nextRefresh = Date.now() + DEFAULT_COOLDOWN;
        this.update({
          ...(error instanceof ModelRequestError && [401, 403].includes(error.status)
            ? { models: [], selected: {} }
            : {}),
          error: error instanceof ModelRequestError ? error.message : '暂时无法更新模型列表',
        });
      } finally {
        this.catalogRequest = undefined;
        if (!this.session.signal.aborted) this.update({ loading: false });
      }
    })();
    return this.catalogRequest;
  }

  private async run<T>(
    kind: ModelKind,
    signal: AbortSignal,
    task: (id: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    this.session.signal.throwIfAborted();
    if (Date.now() < this.providerReadyAt) throw new Error('外部模型暂时达到调用限额');
    await this.refresh();
    const attempted = new Set<string>();
    let last: ModelRequestError | undefined;
    let refreshed = false;
    while (attempted.size < 3) {
      signal.throwIfAborted();
      this.session.signal.throwIfAborted();
      if (Date.now() < this.providerReadyAt) throw new Error('外部模型暂时达到调用限额');
      const model = this.current.models.find(
        (entry) =>
          entry.kind === kind &&
          !attempted.has(entry.id) &&
          Date.now() >= (this.cooling.get(entry.id) ?? 0),
      );
      if (!model) break;
      attempted.add(model.id);
      try {
        const result = await task(model.id);
        signal.throwIfAborted();
        this.session.signal.throwIfAborted();
        this.update({ selected: { ...this.current.selected, [kind]: model.id } });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        this.session.signal.throwIfAborted();
        if (!(error instanceof ModelRequestError) || ![404, 429, 503].includes(error.status))
          throw error;
        last = error;
        this.cooling.set(model.id, error.retryAt);
        if (error.providerLimit) {
          this.providerReadyAt = Math.max(this.providerReadyAt, error.retryAt);
          throw error;
        }
        if (error.status === 404 && !refreshed) {
          refreshed = true;
          await this.refresh(true);
        }
      }
    }
    throw last ?? new Error(kind === 'embedding' ? '暂无可用的搜索模型' : '暂无可用的识别模型');
  }

  recognizeVision(prompt: string, parts: VisionPart[], signal: AbortSignal): Promise<string> {
    return this.run('vision', signal, async (model) => {
      if (this.google) {
        const content = parts.map((part) => {
          if (part.type === 'text') return { text: part.text };
          const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url) ?? [];
          if (!mimeType || !data) throw new Error('识别图像格式无效');
          return { inlineData: { mimeType, data } };
        });
        const response = await this.json(
          `/models/${encodeURIComponent(model)}:generateContent`,
          signal,
          {
            systemInstruction: { parts: [{ text: prompt }] },
            contents: [{ role: 'user', parts: content }],
            generationConfig: { responseMimeType: 'application/json' },
          },
        );
        const output = response?.candidates?.[0]?.content?.parts;
        return Array.isArray(output)
          ? output
              .filter((part) => !part?.thought && typeof part?.text === 'string')
              .map((part) => part.text)
              .join('')
          : '';
      }
      const response = await this.json('/chat/completions', signal, {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: parts },
        ],
      });
      return response?.choices?.[0]?.message?.content ?? '';
    });
  }

  runEmbedding<T>(
    signal: AbortSignal,
    task: (
      modelId: string,
      embed: (inputs: string[], signal: AbortSignal) => Promise<number[][]>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.run('embedding', signal, (model) =>
      task(model, async (inputs, batchSignal) => {
        const requestSignal = AbortSignal.any([signal, batchSignal]);
        if (this.google) {
          const name = `models/${model}`;
          const response = await this.json(
            `/models/${encodeURIComponent(model)}:batchEmbedContents`,
            requestSignal,
            {
              requests: inputs.map((text) => ({ model: name, content: { parts: [{ text }] } })),
            },
          );
          if (!Array.isArray(response?.embeddings)) throw new Error('搜索模型返回格式无效');
          return response.embeddings.map((entry: { values: number[] }) => entry.values);
        }
        const response = await this.json('/embeddings', requestSignal, { model, input: inputs });
        if (!Array.isArray(response?.data)) throw new Error('搜索模型返回格式无效');
        const result: number[][] = [];
        for (const entry of response.data) {
          if (
            !Number.isInteger(entry?.index) ||
            entry.index < 0 ||
            entry.index >= inputs.length ||
            result[entry.index] ||
            !Array.isArray(entry.embedding)
          )
            throw new Error('搜索模型返回格式无效');
          result[entry.index] = entry.embedding;
        }
        return result;
      }),
    );
  }
}
