import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NotebookEngine } from '../src/domain.ts';

/**
 * Real packaged-Android UI helper. The caller owns the dedicated test AVD and
 * supplies its existing adb/raw/openNote helpers. This file never starts ADB,
 * builds, seeds a project, calls a native bridge method or injects a picker result.
 *
 * adb(...args) must execute `adb -s <serial> ...args` synchronously and return text.
 * raw() observes every key in the production workspace IndexedDB store.
 * await verifyProjectPackage({ page, adb, raw, openNote, noteId, out, pass });
 *
 * Device execution is required before any assertion below can be reported passed.
 */
export async function verifyProjectPackage({ page, adb, raw, openNote, noteId, out, pass }) {
  assert.ok(
    page && adb && raw && openNote && noteId && out,
    'Missing Android package helper inputs',
  );
  mkdirSync(out, { recursive: true });
  const stem = `Glossa-package-${randomUUID()}`;
  const requestedName = `${stem}.glossa`;
  const steps = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check, message, timeout = 25000) {
    const deadline = Date.now() + timeout;
    let error;
    while (Date.now() < deadline) {
      try {
        const value = await check();
        if (value) return value;
      } catch (e) {
        error = e;
      }
      await sleep(160);
    }
    throw new Error(message + (error ? `: ${error.message || error}` : ''));
  }
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  function xmlNodes() {
    adb('shell', `uiautomator dump /sdcard/${stem}-window.xml`);
    const xml = adb('shell', `cat /sdcard/${stem}-window.xml`);
    return [...xml.matchAll(/<node\b([^>]+)\/?\s*>/g)].map((match) =>
      Object.fromEntries(
        [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [
          attr[1],
          attr[2]
            .replaceAll('&quot;', '"')
            .replaceAll('&apos;', "'")
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&amp;', '&'),
        ]),
      ),
    );
  }
  function tap(node) {
    const bounds = node?.bounds?.match(/\d+/g)?.map(Number);
    assert.equal(bounds?.length, 4, 'System UI node has no valid bounds');
    adb(
      'shell',
      `input tap ${Math.round((bounds[0] + bounds[2]) / 2)} ${Math.round((bounds[1] + bounds[3]) / 2)}`,
    );
  }
  const isDocumentsUI = (node) => /documentsui/.test(node.package || '');
  async function documentWindow() {
    return until(() => {
      const nodes = xmlNodes();
      return nodes.some(isDocumentsUI) && nodes;
    }, 'Genuine Android DocumentsUI did not open');
  }
  async function downloadsRoot() {
    let nodes = await documentWindow();
    let root = nodes.find(
      (node) =>
        isDocumentsUI(node) &&
        /^(Downloads|Download|下载|下載)$/.test(node.text || '') &&
        /(?:android:id\/title|:id\/title)$/.test(node['resource-id'] || ''),
    );
    if (!root) {
      const menu = nodes.find(
        (node) =>
          isDocumentsUI(node) &&
          /Show roots|显示根目录|打开导航抽屉|Open navigation drawer/.test(
            node['content-desc'] || '',
          ),
      );
      if (menu) {
        tap(menu);
        await sleep(250);
        nodes = xmlNodes();
      }
      root =
        nodes.find(
          (node) =>
            isDocumentsUI(node) &&
            /^(Downloads|Download|下载|下載)$/.test(node.text || '') &&
            /(?:android:id\/title|:id\/title)$/.test(node['resource-id'] || ''),
        ) ||
        nodes.find(
          (node) =>
            isDocumentsUI(node) &&
            /^(Downloads|Download|下载|下載)$/.test(node.text || '') &&
            node.clickable === 'true',
        );
    }
    if (root) {
      tap(root);
      await sleep(250);
      return xmlNodes();
    }
    // An already selected Downloads directory can have a toolbar title but no
    // open drawer. Accept it only when a genuine DocumentsUI title says so.
    assert.ok(
      nodes.some(
        (node) => isDocumentsUI(node) && /^(Downloads|Download|下载|下載)$/.test(node.text || ''),
      ),
      'Downloads root missing from system picker',
    );
    return nodes;
  }
  async function createInDownloads() {
    await downloadsRoot();
    let nodes = await until(() => {
      const values = xmlNodes();
      return (
        values.some((node) => isDocumentsUI(node) && node.class === 'android.widget.EditText') &&
        values
      );
    }, 'System create-document filename editor missing');
    const field =
      nodes.find(
        (node) =>
          isDocumentsUI(node) &&
          node.class === 'android.widget.EditText' &&
          /(?:title|filename|file_name)$/.test(node['resource-id'] || ''),
      ) || nodes.find((node) => isDocumentsUI(node) && node.class === 'android.widget.EditText');
    tap(field);
    // Real key events edit only this owned picker filename. MOVE_END collapses
    // a preselected suggestion before deleting its known number of characters.
    adb('shell', 'input keyevent KEYCODE_MOVE_END');
    adb(
      'shell',
      'input keyevent ' +
        Array.from(
          { length: Math.max(1, (field.text || '').length + 10) },
          () => 'KEYCODE_DEL',
        ).join(' '),
    );
    adb('shell', `input text ${quote(requestedName)}`);
    // Hardware-keyboard AVDs may show no IME: blindly pressing Back would
    // cancel the picker. Dismiss only an actually visible soft keyboard.
    const ime = adb('shell', 'dumpsys input_method');
    if (/mInputShown=true|mIsInputViewShown=true|mIsImeWindowVisible=true/.test(ime))
      adb('shell', 'input keyevent KEYCODE_BACK');
    nodes = xmlNodes();
    const updated = nodes.find(
      (node) => isDocumentsUI(node) && node.class === 'android.widget.EditText',
    );
    assert.equal(
      updated?.text,
      requestedName,
      'System filename editor did not retain the owned unique filename',
    );
    const save =
      nodes.find(
        (node) =>
          isDocumentsUI(node) &&
          /^(Save|SAVE|保存|儲存)$/.test(node.text || '') &&
          node.enabled !== 'false',
      ) ||
      nodes.find(
        (node) =>
          isDocumentsUI(node) &&
          /:id\/(?:button_save|save|button1)$/.test(node['resource-id'] || '') &&
          node.enabled !== 'false',
      );
    assert.ok(save, 'System create-document Save button missing');
    tap(save);
  }
  async function chooseExportedFile(displayName) {
    await downloadsRoot();
    const nodes = await until(() => {
      const values = xmlNodes();
      return (
        values.some(
          (node) =>
            isDocumentsUI(node) &&
            (node.text === displayName || node['content-desc'] === displayName),
        ) && values
      );
    }, `Exported owned file ${displayName} missing from system Downloads picker`);
    tap(
      nodes.find(
        (node) =>
          isDocumentsUI(node) &&
          (node.text === displayName || node['content-desc'] === displayName),
      ),
    );
  }
  async function exportDialog() {
    await page.getByRole('button', { name: '导出与恢复', exact: true }).click();
    await page.getByRole('dialog', { name: '导出与恢复', exact: true }).waitFor();
  }
  function record(name, detail) {
    steps.push({ name, detail });
    pass?.(name, detail);
  }
  const canonical = (value) =>
    JSON.stringify(value, (_key, item) => {
      if (item && !Array.isArray(item) && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      return item;
    });
  const sameProject = (one, two) => canonical(one) === canonical(two);
  try {
    await openNote();
    // Observe production export completion; never call bridge methods directly.
    await page.evaluate(() => {
      window.__glossaPackageObservedExports = [];
      window.addEventListener('quietpaper-native', (event) => {
        if (event.detail?.type === 'export')
          window.__glossaPackageObservedExports.push(event.detail);
      });
    });
    let baseline = (await raw()).current;
    await until(async () => {
      await sleep(450);
      const next = (await raw()).current;
      if (sameProject(baseline.project, next.project)) {
        baseline = next;
        return true;
      }
      baseline = next;
      return false;
    }, 'Workspace was not stable before package export');
    const beforeEngine = new NotebookEngine(baseline.project);
    const beforeNote = beforeEngine.getNote(noteId);
    assert.ok(beforeNote, 'Owned product note is missing before package export');
    const strokes = beforeNote.pages
      .flatMap((p) => p.objects)
      .filter((object) => object.kind === 'stroke' && !object.deleted);
    assert.ok(
      strokes.length,
      'Package verification requires at least one already UI-created stroke',
    );
    const sourceEntries = Object.entries(beforeEngine.state.settings).filter(
      ([, value]) => value?.noteId === noteId && value?.document && value?.link,
    );
    assert.ok(
      sourceEntries.length >= 2,
      'Package verification expects the UI-created Markdown and LaTeX source associations',
    );
    await exportDialog();
    await page
      .getByRole('dialog', { name: '导出与恢复', exact: true })
      .getByRole('button', { name: '完整原生工程包', exact: true })
      .click();
    await createInDownloads();
    const nativeExport = await until(
      () =>
        page.evaluate(() =>
          window.__glossaPackageObservedExports.find(
            (reply) =>
              reply.ok &&
              reply.uri &&
              Number.isSafeInteger(reply.bytes) &&
              typeof reply.sha256 === 'string',
          ),
        ),
      'Production native export did not finish with byte/SHA confirmation',
      45000,
    );
    const deviceFile = await until(() => {
      const paths = adb(
        'shell',
        `find /sdcard/Download -maxdepth 1 -type f -name ${quote(stem + '*')}`,
      )
        .split(/\r?\n/)
        .filter(Boolean);
      assert.ok(paths.length <= 1, 'More than one owned package output found');
      return paths[0];
    }, 'Owned package output did not appear in Android Downloads');
    const displayName = basename(deviceFile);
    assert.ok(displayName.startsWith(stem), 'Unexpected package output filename');
    const localFile = join(out, displayName);
    adb('pull', deviceFile, localFile);
    const bytes = readFileSync(localFile);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bytes.length, nativeExport.bytes);
    assert.equal(digest, nativeExport.sha256);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const pkg = JSON.parse(text);
    assert.equal(pkg.format, 'quiet-paper-project');
    const exportedProject = NotebookEngine.importProject(text); // observation/validation only
    const exported = new NotebookEngine(exportedProject);
    assert.deepEqual(exported.getNote(noteId), beforeNote);
    for (const [key, source] of sourceEntries)
      assert.deepEqual(exported.state.settings[key], source);
    for (const operation of baseline.project.operations)
      assert.ok(
        exportedProject.operations.some((candidate) => sameProject(candidate, operation)),
        `Export lost operation ${operation.id}`,
      );
    record(
      'Android real UI package export through system create-document preserves operations, raw strokes and complete source associations',
      {
        displayName,
        deviceFile,
        bytes: bytes.length,
        sha256: digest,
        noteId,
        strokes: strokes.length,
        sources: sourceEntries.length,
      },
    );
    await page.screenshot({ path: join(out, 'package-exported.png'), fullPage: false });

    // Change the owned test note using its normal UI, proving import restores the
    // exported earlier version while retaining the later current as a recovery.
    await page.getByRole('button', { name: '归档', exact: true }).click();
    const archive = page.getByRole('dialog', { name: '笔记归档', exact: true });
    const changedTitle = `${beforeNote.title} / after-package-export`;
    await archive.getByLabel('标题', { exact: true }).fill(changedTitle);
    await archive.getByRole('button', { name: '保存', exact: true }).click();
    await until(
      async () =>
        new NotebookEngine((await raw()).current.project).getNote(noteId).title === changedTitle,
      'Owned note rename was not committed before import',
    );
    const beforeImport = await raw();
    assert.ok(
      beforeImport.current.project.operations.length > exportedProject.operations.length,
      'Import needs a real post-export UI mutation',
    );
    await exportDialog();
    await page
      .getByRole('dialog', { name: '导出与恢复', exact: true })
      .getByRole('button', { name: '导入工程包', exact: true })
      .click();
    await chooseExportedFile(displayName);
    const confirmation = page.getByRole('dialog', { name: '恢复此工程？', exact: true });
    await confirmation.waitFor();
    assert.ok((await confirmation.innerText()).includes(displayName));
    await confirmation.getByRole('button', { name: '确认恢复', exact: true }).click();
    const restored = await until(async () => {
      const value = await raw();
      return (
        value.current.epoch !== beforeImport.current.epoch &&
        sameProject(value.current.project, exportedProject) &&
        value
      );
    }, 'Real UI import did not replace current with the exported project');
    const recovery = Object.entries(restored).find(
      ([key, value]) =>
        key.startsWith('recovery:') &&
        !Object.hasOwn(beforeImport, key) &&
        value?.reason === 'before-restore' &&
        value.workspace?.epoch === beforeImport.current.epoch &&
        value.workspace?.project.id === beforeImport.current.project.id,
    );
    assert.ok(
      recovery,
      'Prior current was not preserved as a new complete before-restore snapshot',
    );
    const kept = recovery[1].workspace.project;
    const prior = beforeImport.current.project;
    assert.equal(kept.schemaVersion, prior.schemaVersion);
    assert.deepEqual(kept.metadata, prior.metadata);
    const priorOps = new Map(prior.operations.map((op) => [op.id, op]));
    const keptOps = new Map(kept.operations.map((op) => [op.id, op]));
    assert.equal(
      keptOps.size,
      kept.operations.length,
      'Recovery contains duplicate operation identities',
    );
    for (const [id, op] of priorOps)
      assert.ok(sameProject(op, keptOps.get(id)), `Recovery lost/changed prior operation ${id}`);
    const background = kept.operations.filter((op) => !priorOps.has(op.id));
    assert.ok(
      background.every((op) => op.type === 'setting.set' && op.payload.key.startsWith('source:')),
      'Unexpected object/note/B mutation during import must be investigated',
    );
    const priorEngine = new NotebookEngine(prior),
      keptEngine = new NotebookEngine(kept);
    assert.deepEqual(
      keptEngine.state.notes,
      priorEngine.state.notes,
      'Recovery lost A/B or a note change',
    );
    const stableSource = (value) => {
      const copy = structuredClone(value);
      if (copy?.link) delete copy.link.lastSourceContact;
      return copy;
    };
    for (const [key, value] of Object.entries(priorEngine.state.settings)) {
      assert.ok(
        sameProject(
          key.startsWith('source:') ? stableSource(value) : value,
          key.startsWith('source:')
            ? stableSource(keptEngine.state.settings[key])
            : keptEngine.state.settings[key],
        ),
        `Recovery changed source content/history/queue or other setting ${key}`,
      );
    }
    writeFileSync(
      join(out, 'package-recovery-delta.json'),
      JSON.stringify(
        {
          priorOperations: prior.operations.length,
          keptOperations: kept.operations.length,
          background: background.map((op) => ({ id: op.id, type: op.type, key: op.payload.key })),
          verified:
            'All prior immutable operations, full A/B notes, source records except contact timestamp, schema, metadata and epoch',
        },
        null,
        2,
      ),
    );
    const restoredEngine = new NotebookEngine(restored.current.project);
    assert.deepEqual(restoredEngine.getNote(noteId), exported.getNote(noteId));
    assert.deepEqual(restoredEngine.state.settings, exported.state.settings);
    assert.equal(restoredEngine.getNote(noteId).title, beforeNote.title);
    record(
      'Android real UI import via system file picker restores exported A/B/source history and retains later current recovery copy',
      {
        projectId: exportedProject.id,
        operationCount: exportedProject.operations.length,
        recoveryKey: recovery[0],
        originalTitle: beforeNote.title,
        preservedLaterTitle: changedTitle,
      },
    );
    await openNote();
    await page.locator('.paper-sheet').waitFor();
    await exportDialog();
    await page
      .getByRole('dialog', { name: '导出与恢复', exact: true })
      .getByRole('button', { name: '本地恢复副本', exact: true })
      .click();
    const recoveryDialog = page.getByRole('dialog', { name: '本地恢复副本', exact: true });
    await recoveryDialog.waitFor();
    await until(
      async () => (await recoveryDialog.innerText()).includes(changedTitle),
      'Preserved current recovery is not visible in real RecoveryManager UI',
    );
    await page.screenshot({ path: join(out, 'package-import-recovery.png'), fullPage: false });
    await recoveryDialog.getByRole('button', { name: '关闭恢复副本', exact: true }).click();
    const result = {
      passed: true,
      requestedName,
      displayName,
      deviceFile,
      localFile,
      bytes: bytes.length,
      sha256: digest,
      nativeExport,
      steps,
      scope:
        'Packaged Android app UI plus genuine system create/open-document pickers, owned Downloads file, host parsing solely for observation; no host project seed or picker result injection.',
    };
    writeFileSync(join(out, 'package-result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    writeFileSync(
      join(out, 'package-result.json'),
      JSON.stringify(
        {
          passed: false,
          requestedName,
          steps,
          error: String(error.stack || error),
          scope:
            'Only successfully completed steps above are evidence; unexecuted steps remain unverified.',
        },
        null,
        2,
      ),
    );
    try {
      await page.screenshot({ path: join(out, 'package-failure.png'), fullPage: false });
    } catch {}
    throw error;
  }
}
