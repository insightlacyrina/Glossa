import { createServer } from 'vite';
import { spawn } from 'node:child_process';
const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.QP_BROWSER_PORT ?? 5189),
    strictPort: true,
    hmr: false,
    watch: null,
  },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const scripts = [
  'storage',
  'structure',
  'workspace',
  'source',
  'block-manager',
  'paper-first',
  'ink',
  'app',
  'export',
];
try {
  for (const name of scripts) {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', `tests/${name}.browser.mjs`], {
        stdio: 'inherit',
        env: { ...process.env, QP_TEST_URL: base, QUIET_PAPER_TEST_URL: base, QP_TEST_SERVE: '0' },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    if (status !== 0) throw new Error(`Browser acceptance failed: ${name} (exit ${status})`);
  }
  console.log(`Browser acceptance: all ${scripts.length} scripts passed.`);
} finally {
  await server.close();
}
