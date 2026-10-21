import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const dataDir = resolve(process.env.GLOSSA_DATA || process.env.QUIET_PAPER_DATA || 'server-data');
const targetDir = resolve(process.argv[2] || `${dataDir}/snapshots`);
mkdirSync(targetDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(dataDir, 'quiet-paper.sqlite'), { readOnly: true });
const target = resolve(
  targetDir,
  `glossa-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
);
await backup(db, target);
db.close();
console.log(target);
