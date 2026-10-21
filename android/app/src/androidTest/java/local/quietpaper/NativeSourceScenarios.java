package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;

/** Real Android source I/O acceptance. No Activity, WebView, JS evaluator or mocked source engine. */
public final class NativeSourceScenarios {
    private static final String AUTHORITY = "content://local.quietpaper.test.source/";
    private final Context context;
    private final ContentResolver resolver;
    private final NativeSourceStore store;
    private final StringBuilder evidence = new StringBuilder();
    private int assertions;
    private NativeSourceScenarios(Instrumentation runner) {
        context = runner.getTargetContext(); resolver = context.getContentResolver();
        store = new NativeSourceStore(context);
    }
    public static void run(Instrumentation runner, String phase) {
        NativeSourceScenarios scenario = new NativeSourceScenarios(runner);
        Bundle result = new Bundle();
        try {
            if ("prepare".equals(phase)) scenario.prepare();
            else if ("resume".equals(phase)) scenario.resume();
            else if ("faults".equals(phase)) scenario.faults();
            else throw new IllegalArgumentException("Unknown native source phase: " + phase);
            result.putString("stream", "\nPASS native source " + phase + "; assertions=" + scenario.assertions
                + "; pid=" + Process.myPid() + "\n" + scenario.evidence);
            runner.finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            result.putString("stream", "\nFAIL native source " + phase + "; pid=" + Process.myPid()
                + "\n" + scenario.evidence + trace);
            runner.finish(Activity.RESULT_CANCELED, result);
        }
    }
    private void prepare() throws Exception {
        resetProvider();
        File proof = proof();
        if (proof.exists()) require(!"prepared".equals(new JSONObject(read(proof)).optString("phase")),
            "an earlier queued restart proof must be resumed before preparing another");
        JSONArray documents = new JSONArray();
        documents.put(prepareDocument("fixture.md", "\uFEFF---\r\ntitle: 原生 📝\r\n---\r\n\r\n# 推导\r\n\r\n过程 $E=mc^2$，保留全部空白。  \r\n", "mc^2", "mc^3"));
        documents.put(prepareDocument("fixture.tex", "\uFEFF\\documentclass{article}\r\n% 中文与 emoji 🧪 注释\r\n\\begin{document}\r\n$x+1$\\quad 保留推导\r\n\\end{document}\r\n", "x+1", "x+2"));
        JSONArray entries = store.getPendingWrites("prepare-list").getJSONArray("entries");
        for (int i = 0; i < documents.length(); i++)
            require(hasEntry(entries, documents.getJSONObject(i).getString("uri")), "pending list retains " + documents.getJSONObject(i).getString("name"));
        write(proof, new JSONObject().put("phase", "prepared").put("pid", Process.myPid()).put("documents", documents).toString());
        require(proof.isFile(), "restart proof fsynced after both real pending journals were committed");
        evidence.append("READY force-stop local.quietpaper before running native-source-resume\n");
    }
    private JSONObject prepareDocument(String name, String before, String from, String to) throws Exception {
        resetProvider();
        String uri = AUTHORITY + name;
        require(!store.getPendingSource("preexisting-" + name, uri).optBoolean("pending"), name + " fixture has no unacknowledged previous test write");
        set(name, before);
        JSONObject opened = store.openDocument("open-" + name, uri, false);
        require(opened.optBoolean("ok") && before.equals(opened.optString("text")) && !opened.optBoolean("persistentPermission"), name + " actual ContentResolver open preserves all text without claiming a persistent SAF grant");
        JSONObject read = store.readDocument("read-" + name, uri);
        require(read.optBoolean("ok") && before.equals(read.optString("text")) && sha(before).equals(read.optString("sha256")), name + " exact UTF-8/BOM/CRLF read and SHA");
        String after = before.replace(from, to);
        JSONObject saved = store.saveDocumentVersioned("save-" + name, uri, after, sha(before), "");
        require(saved.optBoolean("ok") && !saved.optBoolean("pending"), name + " real source write confirmed");
        require(Arrays.equals(bytes(uri), after.getBytes(StandardCharsets.UTF_8)), name + " reopened bytes preserve BOM, line endings, comments, whitespace and formula edit");
        int writes = writes(name);
        JSONObject repeated = store.saveDocument("exact-target-" + name, uri, after, sha(before));
        require(repeated.optBoolean("ok") && writes(name) == writes, name + " exact target already present is acknowledged without another source write");
        String external = after + "% 外部修改\r\n", local = after + "% 本地候选\r\n";
        set(name, external); writes = writes(name);
        JSONObject conflict = store.saveDocumentVersioned("conflict-" + name, uri, local, sha(after), "");
        require(!conflict.optBoolean("ok") && conflict.optBoolean("pending") && "source-conflict".equals(conflict.optString("error")), name + " changed source becomes a real conflict with pending content");
        require(text(uri).equals(external) && writes(name) == writes, name + " source conflict performs no overwrite");
        JSONObject pending = store.getPendingSource("conflict-pending-" + name, uri);
        require(pending.optBoolean("ok") && local.equals(pending.optString("text")) && sha(after).equals(pending.optString("baseSha256")), name + " conflict retains exact local payload and original base");
        JSONObject unknown = store.saveDocument("unknown-pending-" + name, uri, local + "unknown", sha(external));
        require(!unknown.optBoolean("ok") && local.equals(store.getPendingSource("pending-after-unknown-" + name, uri).optString("text")) && text(uri).equals(external), name + " legacy new text cannot replace an unowned pending write");
        String next = local + "% 已知后继候选\r\n";
        JSONObject newer = store.saveDocumentVersioned("newer-pending-" + name, uri, next, sha(after), sha(local));
        require(!newer.optBoolean("ok") && newer.optBoolean("pending") && next.equals(store.getPendingSource("newer-read-" + name, uri).optString("text")), name + " known pending successor remains queued against externally changed source");
        String resolved = external + "% 用户双版本协调 🖋️\r\n";
        JSONObject legacyResolution = store.resolveSourceConflict("legacy-resolution-" + name, uri, resolved, sha(external));
        require(!legacyResolution.optBoolean("ok") && "versioned-resolution-required".equals(legacyResolution.optString("error")) && next.equals(store.getPendingSource("legacy-resolution-retained-" + name, uri).optString("text")) && text(uri).equals(external), name + " single-SHA legacy resolution cannot replace a newer pending version");
        JSONObject stale = store.saveDocumentVersioned("stale-preview-" + name, uri, resolved, sha(external), sha(local));
        require(!stale.optBoolean("ok") && next.equals(store.getPendingSource("stale-retained-" + name, uri).optString("text")) && text(uri).equals(external), name + " stale pending preview cannot overwrite either current version");
        JSONObject resolution = store.saveDocumentVersioned("resolve-" + name, uri, resolved, sha(external), sha(next));
        require(resolution.optBoolean("ok") && text(uri).equals(resolved) && !store.getPendingSource("resolved-pending-" + name, uri).optBoolean("pending"), name + " explicit source and pending SHA decision writes exact chosen content");
        flag("writeFailure", true);
        String failedWrite = resolved + "% 失败后仍保留的写入\r\n";
        JSONObject failed = store.saveDocumentVersioned("provider-write-failure-" + name, uri, failedWrite, sha(resolved), "");
        require(!failed.optBoolean("ok") && failed.optBoolean("pending") && text(uri).equals(resolved), name + " provider write failure retains source and pending intent");
        flag("writeFailure", false);
        require(store.retryPendingWrite("retry-write-failure-" + name, uri).optBoolean("ok") && text(uri).equals(failedWrite), name + " provider write failure safely retries the same durable payload");
        flag("availability", false);
        String offline = failedWrite + "% 进程停止时待写回：离线 🧠\r\n";
        JSONObject queued = store.saveDocumentVersioned("offline-" + name, uri, offline, sha(failedWrite), "");
        require(!queued.optBoolean("ok") && queued.optBoolean("pending"), name + " source unavailable leaves durable write queued");
        JSONObject stored = store.getPendingSource("offline-pending-" + name, uri);
        require(stored.optBoolean("ok") && offline.equals(stored.optString("text")) && sha(offline).equals(stored.optString("sha256")) && sha(failedWrite).equals(stored.optString("baseSha256")), name + " offline pending contains exact payload, identity and original base SHA");
        JSONObject snapshot = store.getSourceSnapshot("offline-snapshot-" + name, uri);
        require(snapshot.optBoolean("ok") && snapshot.optBoolean("pending") && offline.equals(snapshot.optString("text")), name + " offline source snapshot remains fully readable");
        return new JSONObject().put("name", name).put("uri", uri).put("source", failedWrite).put("sourceSha", sha(failedWrite)).put("offline", offline).put("offlineSha", sha(offline));
    }
    private void resume() throws Exception {
        JSONObject proof = new JSONObject(read(proof()));
        require("prepared".equals(proof.optString("phase")), "a completed prepare phase exists");
        require(proof.getInt("pid") != Process.myPid(), "resume executes in a different real Android process: " + proof.getInt("pid") + " -> " + Process.myPid());
        resetProvider();
        JSONArray documents = proof.getJSONArray("documents");
        for (int i = 0; i < documents.length(); i++) {
            JSONObject document = documents.getJSONObject(i);
            String name = document.getString("name"), uri = document.getString("uri"), offline = document.getString("offline");
            require(uri.equals(AUTHORITY + name) && (name.equals("fixture.md") || name.equals("fixture.tex")), "restart proof references a test-owned source only");
            JSONObject pending = store.getPendingSource("restart-pending-" + name, uri);
            require(pending.optBoolean("ok") && pending.optBoolean("pending") && offline.equals(pending.optString("text")) && document.getString("sourceSha").equals(pending.optString("baseSha256")) && document.getString("offlineSha").equals(pending.optString("sha256")), name + " new process reopens exact durable pending text and base SHA");
            require(text(uri).equals(document.getString("source")), name + " provider source did not silently change while unavailable");
            require(offline.equals(store.getSourceSnapshot("restart-snapshot-" + name, uri).optString("text")), name + " queued snapshot survives process termination");
            JSONObject result = store.retryPendingWrite("restart-retry-" + name, uri);
            require(result.optBoolean("ok") && !result.optBoolean("pending") && Arrays.equals(bytes(uri), offline.getBytes(StandardCharsets.UTF_8)), name + " restored provider receives complete pending bytes and reopens exactly");
            require(!store.getPendingSource("restart-cleared-" + name, uri).optBoolean("pending"), name + " only confirmed write clears its pending journal");
            File history = new File(context.getFilesDir(), "native-sources/" + sha(uri));
            require(read(new File(history, document.getString("sourceSha") + ".txt")).equals(document.getString("source")) && read(new File(history, document.getString("offlineSha") + ".txt")).equals(offline), name + " original and resulting full source versions survive");
        }
        JSONArray entries = store.getPendingWrites("resume-list").getJSONArray("entries");
        for (int i = 0; i < documents.length(); i++) require(!hasEntry(entries, documents.getJSONObject(i).getString("uri")), "confirmed restart write no longer appears in queue");
        proof.put("phase", "resumed").put("resumedPid", Process.myPid()); write(proof(), proof.toString());
    }
    private void faults() throws Exception {
        resetProvider();
        String name = "fault.md", uri = AUTHORITY + name;
        require(!store.getPendingSource("fault-existing", uri).optBoolean("pending"), "fault fixture has no previous unacknowledged write");
        byte[] invalid = {(byte) 0xc3, (byte) 0x28}; setBytes(name, invalid);
        JSONObject invalidRead = store.readDocument("invalid-utf8", uri);
        require(!invalidRead.optBoolean("ok") && !invalidRead.optBoolean("unavailable") && invalidRead.optBoolean("sourceReachable") && "invalid-utf8".equals(invalidRead.optString("error")) && Arrays.equals(bytes(uri), invalid), "invalid UTF-8 is a reachable content error and original bytes remain unchanged");
        Bundle large = new Bundle(); large.putString("name", name); large.putInt("size", 16 * 1024 * 1024 + 1); call("seedLarge", null, large);
        JSONObject oversized = store.readDocument("oversized-source", uri);
        require(!oversized.optBoolean("ok") && !oversized.optBoolean("unavailable") && oversized.optBoolean("sourceReachable") && "document-too-large".equals(oversized.optString("error")) && stats(name).getLong("bytes") == 16 * 1024 * 1024 + 1, "size limit is a reachable content error, not source offline or truncation");
        String source = "\uFEFF# 故障分类\r\n保留正文 🗂️\r\n"; set(name, source);
        flag("queryFailure", true);
        JSONObject metadata = store.readDocument("metadata-failure", uri);
        require(metadata.optBoolean("ok") && source.equals(metadata.optString("text")) && metadata.has("metadataWarning"), "display-name query failure does not hide a readable source");
        flag("queryFailure", false);
        File directory = new File(context.getFilesDir(), "native-sources/" + sha(uri));
        File latest = new File(directory, "latest.txt"), backup = new File(directory, "latest-test-" + UUID.randomUUID() + ".backup");
        Files.move(latest.toPath(), backup.toPath(), StandardCopyOption.ATOMIC_MOVE);
        File obstruction = new File(latest, "test-owned-blocker");
        try {
            if (!latest.mkdir()) throw new IllegalStateException("cannot create local journal fault fixture");
            write(obstruction, "test-owned directory prevents atomic replacement");
            JSONObject diskFailure = store.readDocument("local-journal-failure", uri);
            require(!diskFailure.optBoolean("ok") && !diskFailure.optBoolean("unavailable") && diskFailure.optBoolean("sourceReachable") && "local-journal-failed".equals(diskFailure.optString("error")) && text(uri).equals(source), "local journal failure cannot start source offline timing or alter source content");
        } finally {
            obstruction.delete(); if (latest.isDirectory()) latest.delete();
            Files.move(backup.toPath(), latest.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        }
        flag("availability", false);
        JSONObject unavailable = store.readDocument("genuine-unavailable", uri);
        require(!unavailable.optBoolean("ok") && unavailable.optBoolean("unavailable") && !unavailable.optBoolean("sourceReachable"), "actual provider access failure remains explicitly unavailable");
        String offline = source + "待写回 🛟\r\n";
        JSONObject queued = store.saveDocumentVersioned("fault-queue", uri, offline, sha(source), "");
        require(!queued.optBoolean("ok") && queued.optBoolean("pending"), "fault scenario retains a legitimate committed pending write");
        File pendingDirectory = new File(context.getFilesDir(), "native-pending");
        String unusedIdentity = sha(AUTHORITY + "test-corrupt-" + UUID.randomUUID());
        File corrupt = new File(pendingDirectory, unusedIdentity + ".json"), temporary = new File(pendingDirectory, unusedIdentity + ".json.tmp");
        try {
            write(corrupt, "{"); write(temporary, "uncommitted and incomplete JSON");
            JSONObject list = store.getPendingWrites("fault-list");
            require(list.optBoolean("ok") && list.optBoolean("needsRecovery") && hasEntry(list.getJSONArray("entries"), uri), "corrupt committed JSON cannot hide the legitimate pending queue");
            JSONArray diagnostics = list.getJSONArray("diagnostics");
            boolean reported = false, reportedTemporary = false;
            for (int i = 0; i < diagnostics.length(); i++) {
                JSONObject item = diagnostics.getJSONObject(i);
                if (corrupt.getName().equals(item.optString("file"))) reported = "pending-journal-invalid".equals(item.optString("error"));
                if (temporary.getName().equals(item.optString("file"))) reportedTemporary = true;
            }
            require(reported && !reportedTemporary && read(corrupt).equals("{") && temporary.isFile(), "committed corruption is diagnosed per file; temporary bytes are ignored and neither is deleted");
        } finally { corrupt.delete(); temporary.delete(); }
        File validPending = new File(pendingDirectory, sha(uri) + ".json");
        String originalJournal = read(validPending);
        try {
            JSONObject altered = new JSONObject(originalJournal).put("sha256", sha("not the queued payload")); write(validPending, altered.toString());
            JSONObject refused = store.getPendingSource("invalid-pending-hash", uri);
            require(!refused.optBoolean("ok") && "pending-journal-invalid".equals(refused.optString("error")), "pending payload hash mismatch is not a valid source association");
            JSONObject rejected = store.saveDocumentVersioned("refuse-invalid-journal", uri, "must not replace", sha(source), "");
            require(!rejected.optBoolean("ok") && read(validPending).equals(altered.toString()), "invalid pending journal is preserved instead of silently replaced");
        } finally { write(validPending, originalJournal); }
        resetProvider();
        require(store.retryPendingWrite("fault-cleanup-retry", uri).optBoolean("ok") && text(uri).equals(offline), "valid fault-scenario pending content remains recoverable after diagnostics");
    }
    private File proof() { return new File(context.getFilesDir(), "native-source-restart-proof.json"); }
    private void require(boolean valid, String message) { if (!valid) throw new AssertionError(message); assertions++; evidence.append("PASS ").append(message).append('\n'); }
    private boolean hasEntry(JSONArray entries, String uri) throws Exception { for (int i = 0; i < entries.length(); i++) if (uri.equals(entries.getJSONObject(i).optString("uri"))) return true; return false; }
    private void resetProvider() { flag("availability", true); flag("writeFailure", false); flag("queryFailure", false); }
    private void flag(String method, boolean enabled) { call(method, Boolean.toString(enabled), null); }
    private Bundle call(String method, String argument, Bundle extras) { return resolver.call(Uri.parse(AUTHORITY + "fault.md"), method, argument, extras); }
    private void set(String name, String content) { Bundle extras = new Bundle(); extras.putString("name", name); extras.putString("text", content); call("set", null, extras); }
    private void setBytes(String name, byte[] content) { Bundle extras = new Bundle(); extras.putString("name", name); extras.putByteArray("bytes", content); call("setBytes", null, extras); }
    private Bundle stats(String name) { return call("stats", name, null); }
    private int writes(String name) { return stats(name).getInt("writes"); }
    private byte[] bytes(String uri) throws Exception { try (InputStream input = resolver.openInputStream(Uri.parse(uri)); ByteArrayOutputStream result = new ByteArrayOutputStream()) { if (input == null) throw new IllegalStateException("fixture source missing"); byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) result.write(buffer, 0, count); return result.toByteArray(); } }
    private String text(String uri) throws Exception { return new String(bytes(uri), StandardCharsets.UTF_8); }
    private String read(File file) throws Exception { try (InputStream input = new FileInputStream(file); ByteArrayOutputStream result = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) result.write(buffer, 0, count); return result.toString(StandardCharsets.UTF_8.name()); } }
    private void write(File file, String value) throws Exception { try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(value.getBytes(StandardCharsets.UTF_8)); stream.flush(); stream.getFD().sync(); } }
    private String sha(String text) throws Exception { byte[] value = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)); StringBuilder result = new StringBuilder(); for (byte part : value) result.append(String.format(Locale.ROOT, "%02x", part & 255)); return result.toString(); }
}
