import { mkdir, writeFile } from 'node:fs/promises';
import { seedWorkspace } from '../src/bootstrap';
import { exportReadingHtml } from '../src/export';
const engine = seedWorkspace('bundled-example-author');
await mkdir('examples', { recursive: true });
await writeFile('examples/变化与积累.quietpaper', engine.exportProject());
await writeFile('examples/变化与积累-阅读.html', exportReadingHtml(engine.state.notes[0]));
console.log('Created an editable example project and its self-contained B reading snapshot.');
