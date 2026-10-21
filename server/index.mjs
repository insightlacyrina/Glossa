import { createSyncServer } from './app.mjs';
import { resolve } from 'node:path';

const port = Number(process.env.PORT || '8787');
const host = process.env.HOST || '127.0.0.1';
const app = createSyncServer({
  dataDir: process.env.GLOSSA_DATA || process.env.QUIET_PAPER_DATA || resolve('server-data'),
  token: process.env.GLOSSA_TOKEN || process.env.QUIET_PAPER_TOKEN,
  staticDir: process.env.GLOSSA_STATIC || process.env.QUIET_PAPER_STATIC || resolve('dist'),
  allowedOrigins: (process.env.GLOSSA_ORIGINS || process.env.QUIET_PAPER_ORIGINS || '')
    .split(',')
    .filter(Boolean),
});
app.server.listen(port, host, () =>
  console.log(`Glossa sync listening on http://${host}:${port}; durable operation archive enabled`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    app.close().then(() => process.exit(0));
  });
