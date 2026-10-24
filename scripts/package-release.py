#!/usr/bin/env python3
"""Package reviewed source and existing Android artifacts without repeating tests."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib, json
from datetime import datetime, timezone

project = Path(__file__).resolve().parents[1]
version = json.loads((project / 'package.json').read_text())['version']
release_date = datetime.now(timezone.utc).date().isoformat()
releases = project / 'releases'
releases.mkdir(exist_ok=True)
archive = releases / f'glossa-{version}-source.zip'
excluded = {'node_modules', 'releases', 'artifacts', 'server-data', 'test-results', 'playwright-report', '.git', '__pycache__', '.gradle', '.tools'}
files = []
for file in project.rglob('*'):
    if not file.is_file() or file.is_symlink():
        continue
    relative = file.relative_to(project)
    if relative.parts[0] == 'swift' and any(part.startswith('.build') or part == '.swiftpm' for part in relative.parts):
        continue
    if any(part in excluded for part in relative.parts):
        continue
    if relative.parts[0] == 'android' and ('build' in relative.parts or relative.as_posix().startswith('android/app/src/main/assets/web/') or file.name == 'local.properties'):
        continue
    if file.name.startswith('test-results-') or file.suffix in {'.pyc', '.keystore', '.jks'} or file.name.startswith('.env'):
        continue
    files.append((relative, file))
with ZipFile(archive, 'w', ZIP_DEFLATED, compresslevel=9) as bundle:
    for relative, file in sorted(files):
        bundle.write(file, 'Glossa/' + relative.as_posix())
with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    names = set(bundle.namelist())
    for required in ['package.json', 'package-lock.json', 'README.md', 'src/domain.ts', 'src/App.tsx', 'server/index.mjs', 'android/gradlew', 'dist/index.html', 'docs/DELIVERY.md', 'docs/verification/check.log', 'examples/变化与积累.glossa']:
        assert 'Glossa/' + required in names, required
    assert not any('/node_modules/' in name or '/.gradle/' in name or '/build/' in name or '/server-data/' in name for name in names)
    mode = bundle.getinfo('Glossa/android/gradlew').external_attr >> 16
    assert mode & 0o111, 'gradlew executable bit missing'
records = []
for file in sorted(releases.iterdir()):
    if file.name.startswith(f'glossa-{version}-') and file.suffix in {'.apk', '.zip'}:
        records.append({'file':file.name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(releases / 'SHA256SUMS').write_text(''.join(item['sha256'] + '  ' + item['file'] + '\n' for item in records))
manifest = {'product':'Glossa / 笺注','version':version,'date':release_date,'status':'engineering-validation','sourceFiles':len(files),'artifacts':records}
(releases / 'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
