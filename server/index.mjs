import { createSyncServer } from './app.mjs';
import { resolve } from 'node:path';

const port = Number(process.env.PORT || '8787');
const host = process.env.HOST || '127.0.0.1';
const app = createSyncServer({
  dataDir: process.env.QUIET_PAPER_DATA || resolve('server-data'),
  token: process.env.QUIET_PAPER_TOKEN,
  staticDir: process.env.QUIET_PAPER_STATIC || resolve('dist'),
  allowedOrigins: (process.env.QUIET_PAPER_ORIGINS || '').split(',').filter(Boolean),
});
app.server.listen(port, host, () =>
  console.log(
    `Quiet Paper sync listening on http://${host}:${port}; durable operation archive enabled`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    app.close().then(() => process.exit(0));
  });
