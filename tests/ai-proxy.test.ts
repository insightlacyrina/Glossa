import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { webcrypto } from 'node:crypto';
import { createAIProxy, type AIProxyConfiguration } from '../server/ai-proxy.mjs';

const token = 'ai-proxy-authenticated-test-token';
const phrase = '只发送这段选中文字😀，保留不确定项。';
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function fixture(extra: AIProxyConfiguration = {}, providerMode = 'ok') {
  let calls = 0;
  const bodies: string[] = [];
  const provider = createServer(async (req, res) => {
    calls++;
    let text = '';
    for await (const chunk of req) text += chunk;
    bodies.push(text);
    assert.equal(req.headers.authorization, 'Bearer owner-only-model-key');
    if (providerMode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (res.destroyed) return;
    }
    if (providerMode === 'redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/leak' });
      res.end();
      return;
    }
    if (providerMode === '401' || providerMode === '429') {
      res.writeHead(Number(providerMode));
      res.end('{}');
      return;
    }
    if (providerMode === 'bad') {
      res.end('invalid-json');
      return;
    }
    const selected = JSON.parse(JSON.parse(text).messages[1].content).objects;
    const objects = selected.map((object: any) => ({
      id: object.id,
      version: object.version,
      text: object.text ?? '模型标明无法确定的笔迹',
      uncertainty: ['mock result; verify manually'],
    }));
    if (providerMode === 'scope') objects[0].id = 'unselected-object';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ objects }) } }] }));
  });
  const endpoint = (await listen(provider)) + '/v1/chat/completions';
  const proxy = createAIProxy({
    enabled: true,
    endpoint,
    model: 'mock-transcriber',
    apiKey: 'owner-only-model-key',
    ...extra,
  });
  const server = createServer((req, res) => {
    void proxy.handle(req, res, {
      tokenAuthenticated: req.headers.authorization === 'Bearer ' + token,
    });
  });
  const url = await listen(server);
  const request = async (path: string, input?: unknown, auth = token) => {
    const response = await fetch(url + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    proxy,
    request,
    endpoint,
    bodies,
    get calls() {
      return calls;
    },
    cleanup: async () => {
      proxy.close();
      await close(server);
      await close(provider);
    },
  };
}
async function grantAndEnvelope(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString(
    'base64',
  );
  const scope = [{ id: 'selected-object', version: 'android:1:version' }];
  const response = await f.request('/api/ai/grants', {
    consent: true,
    projectId: 'project-test',
    purpose: 'transcribe',
    objects: scope,
    ttlSeconds: 30,
    clientPublicKey: publicKey,
    ...overrides,
  });
  assert.equal(response.status, 201);
  const grant = response.body;
  const peer = await webcrypto.subtle.importKey(
    'raw',
    Buffer.from(grant.serverPublicKey, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    pair.privateKey,
    256,
  );
  const hkdf = await webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Buffer.from(grant.salt, 'base64'),
      info: Buffer.from('glossa-ai-proxy-v1\0' + grant.grantId + '\0' + grant.projectId),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const envelope = async (
    objects: any[] = [{ ...scope[0], kind: 'text', text: phrase }],
    projectId = 'project-test',
  ) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const data = await webcrypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: Buffer.from(
          JSON.stringify(['glossa-ai-proxy-v1', grant.grantId, grant.projectId, 'transcribe']),
        ),
      },
      key,
      Buffer.from(JSON.stringify({ projectId, purpose: 'transcribe', objects })),
    );
    return {
      jobId: 'job-test',
      iv: Buffer.from(iv).toString('base64'),
      data: Buffer.from(data).toString('base64'),
    };
  };
  const decrypt = async (response: any) =>
    JSON.parse(
      Buffer.from(
        await webcrypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: Buffer.from(response.iv, 'base64'),
            additionalData: Buffer.from(
              JSON.stringify([
                'glossa-ai-proxy-v1',
                grant.grantId,
                grant.projectId,
                'candidate',
                response.jobId,
              ]),
            ),
          },
          key,
          Buffer.from(response.data, 'base64'),
        ),
      ).toString('utf8'),
    );
  return { grant, envelope, decrypt };
}

test('AI remains disabled without owner configuration and requires authenticated consent/scope', async () => {
  const disabled = createAIProxy();
  assert.equal(disabled.status().aiProxyAvailable, false);
  assert.equal(disabled.status().aiTemporaryPlaintextAccess, false);
  disabled.close();
  for (const endpoint of [
    'http://remote.example/v1/chat/completions',
    'https://user:key@remote.example/v1/chat/completions',
    'https://remote.example/?url=attack',
  ])
    assert.throws(() => createAIProxy({ enabled: true, endpoint, model: 'm', apiKey: 'k' }));
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/ai/status', undefined, 'wrong')).status, 401);
    assert.equal(
      (await f.request('/api/ai/grants', { projectId: 'p', consent: false })).status,
      400,
    );
    const config = await f.request('/api/ai/status');
    assert.equal(config.body.aiTemporaryPlaintextAccess, true);
    assert.equal(config.body.endpoint, f.endpoint);
    assert.equal(JSON.stringify(config.body).includes('owner-only-model-key'), false);
  } finally {
    await f.cleanup();
  }
});

test('WebCrypto encrypted selected snapshots proxy once, preserve uncertainty, reject collisions and keep metadata-only audit', async () => {
  const f = await fixture();
  try {
    const { grant, envelope, decrypt } = await grantAndEnvelope(f);
    const request = await envelope();
    const first = await f.request(`/api/ai/grants/${grant.grantId}/jobs`, request);
    assert.equal(first.status, 200);
    assert.equal(JSON.stringify(first.body).includes(phrase), false);
    const candidate = await decrypt(first.body);
    assert.equal(candidate.objects[0].text, phrase);
    assert.ok(candidate.objects[0].uncertainty.length >= 2);
    assert.deepEqual(
      (await f.request(`/api/ai/grants/${grant.grantId}/jobs`, request)).body,
      first.body,
    );
    assert.equal(f.calls, 1);
    assert.equal(
      (
        await f.request(`/api/ai/grants/${grant.grantId}/jobs`, {
          ...request,
          jobId: 'another-job',
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request(`/api/ai/grants/${grant.grantId}/jobs`, await envelope())).status,
      409,
    );
    assert.equal(f.bodies[0].includes(phrase), true);
    assert.equal(f.bodies[0].includes('passphrase'), false);
    const audit = JSON.stringify(f.proxy.audit());
    assert.equal(audit.includes(phrase), false);
    assert.equal(audit.includes('owner-only-model-key'), false);
    assert.equal(audit.includes(request.data), false);
    assert.equal((await f.request(`/api/ai/grants/${grant.grantId}/revoke`, {})).status, 200);
    assert.equal(
      (await f.request(`/api/ai/grants/${grant.grantId}/jobs`, request)).body.error,
      'GRANT_REVOKED',
    );
  } finally {
    await f.cleanup();
  }
});

test('Grant rejects out-of-scope revision/project, target injection, tampering and byte/object overflow before provider', async () => {
  const f = await fixture({ maxPlainBytes: 1024, maxObjects: 1 });
  try {
    for (const objects of [
      [{ id: 'selected-object', version: 'wrong', kind: 'text', text: phrase }],
      [{ id: 'other', version: 'android:1:version', kind: 'text', text: phrase }],
    ]) {
      const x = await grantAndEnvelope(f);
      assert.equal(
        (await f.request(`/api/ai/grants/${x.grant.grantId}/jobs`, await x.envelope(objects))).body
          .error,
        'SCOPE_MISMATCH',
      );
    }
    const x = await grantAndEnvelope(f);
    const foreign = await grantAndEnvelope(f);
    assert.equal(
      (
        await f.request(
          `/api/ai/grants/${foreign.grant.grantId}/jobs`,
          await foreign.envelope(undefined, 'foreign-project'),
        )
      ).body.error,
      'SCOPE_MISMATCH',
    );
    assert.equal(
      (
        await f.request('/api/ai/grants', {
          consent: true,
          projectId: 'project-test',
          purpose: 'transcribe',
          ttlSeconds: 30,
          clientPublicKey: x.grant.serverPublicKey,
          objects: [
            { id: 'one', version: 'v1' },
            { id: 'two', version: 'v2' },
          ],
        })
      ).status,
      400,
    );
    const request = await x.envelope();
    request.data = request.data.slice(0, -3) + 'AAA';
    assert.equal((await f.request(`/api/ai/grants/${x.grant.grantId}/jobs`, request)).status, 400);
    const y = await grantAndEnvelope(f);
    assert.equal(
      (
        await f.request(`/api/ai/grants/${y.grant.grantId}/jobs`, {
          ...(await y.envelope()),
          endpoint: 'https://attacker.example',
        })
      ).body.error,
      'INVALID_JOB',
    );
    const z = await grantAndEnvelope(f);
    assert.equal(
      (
        await f.request(
          `/api/ai/grants/${z.grant.grantId}/jobs`,
          await z.envelope([
            {
              id: 'selected-object',
              version: 'android:1:version',
              kind: 'text',
              text: 'a'.repeat(2000),
            },
          ]),
        )
      ).status,
      413,
    );
    assert.equal(f.calls, 0);
  } finally {
    await f.cleanup();
  }
});

test('Revocation and TTL abort in-flight model work and never release late candidates', async () => {
  const f = await fixture({}, 'slow');
  try {
    const x = await grantAndEnvelope(f);
    const pending = f.request(`/api/ai/grants/${x.grant.grantId}/jobs`, await x.envelope());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await f.request(`/api/ai/grants/${x.grant.grantId}/revoke`, {});
    assert.equal((await pending).body.error, 'GRANT_REVOKED');
    const y = await grantAndEnvelope(f, { ttlSeconds: 1 });
    const expired = await f.request(`/api/ai/grants/${y.grant.grantId}/jobs`, await y.envelope());
    assert.equal(expired.body.error, 'GRANT_EXPIRED');
  } finally {
    await f.cleanup();
  }
});

test('Provider authentication, throttling, malformed JSON, redirects, scope and timeout are classified without replacing source', async () => {
  for (const [mode, expected] of [
    ['401', 'PROVIDER_UNAUTHORIZED'],
    ['429', 'PROVIDER_RATE_LIMITED'],
    ['bad', 'PROVIDER_BAD_JSON'],
    ['redirect', 'PROVIDER_REDIRECT'],
    ['scope', 'PROVIDER_SCOPE_MISMATCH'],
    ['slow', 'PROVIDER_TIMEOUT'],
  ]) {
    const f = await fixture({ timeoutMs: mode === 'slow' ? 40 : 1000 }, mode);
    try {
      const x = await grantAndEnvelope(f);
      const request = await x.envelope();
      const response = await f.request(`/api/ai/grants/${x.grant.grantId}/jobs`, request);
      assert.equal(response.body.error, expected);
      assert.equal(
        (await f.request(`/api/ai/grants/${x.grant.grantId}/jobs`, request)).body.error,
        expected,
      );
      assert.equal(f.calls, 1);
    } finally {
      await f.cleanup();
    }
  }
});
