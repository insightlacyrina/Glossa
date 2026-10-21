import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function files(dir, prefix = '') {
  const items = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const item of items) {
    if (item.isDirectory())
      result.push(...(await files(dir + '/' + item.name, prefix + item.name + '/')));
    else if (item.name !== 'sw.js' && !item.name.endsWith('.map')) result.push(prefix + item.name);
  }
  return result;
}
const paths = await files('dist');
const hash = createHash('sha256');
for (const path of paths.sort()) hash.update(await readFile('dist/' + path));
const cache = 'quiet-paper-' + hash.digest('hex').slice(0, 16);
await writeFile(
  'dist/sw.js',
  `const CACHE=${JSON.stringify(cache)},FILES=${JSON.stringify(['/', ...paths.map((p) => '/' + p)])};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('quiet-paper-')&&key!==CACHE).map(key=>caches.delete(key))))]));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/'))return;event.respondWith(fetch(event.request).then(response=>{if(response.ok&&FILES.includes(url.pathname)){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(async()=>await caches.match(event.request,{ignoreVary:true})||((event.request.mode==='navigate')?await caches.match('/'):null)||Response.error()));});
`,
);
console.log('Offline shell: ' + paths.length + ' files, ' + cache);
