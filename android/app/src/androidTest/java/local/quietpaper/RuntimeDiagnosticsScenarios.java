package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Bundle;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;

/** Exercises the production diagnostics store in isolated, test-owned app-private directories. */
public final class RuntimeDiagnosticsScenarios {
    private int assertions;
    private final StringBuilder evidence = new StringBuilder();

    public static void run(Instrumentation runner) {
        RuntimeDiagnosticsScenarios scenario = new RuntimeDiagnosticsScenarios();
        Bundle result = new Bundle();
        try {
            scenario.check(runner.getTargetContext());
            result.putString("stream", "\nPASS runtime diagnostics; assertions=" + scenario.assertions
                + "; pid=" + Process.myPid() + "\n" + scenario.evidence);
            runner.finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            result.putString("stream", "\nFAIL runtime diagnostics; assertions=" + scenario.assertions
                + "\n" + scenario.evidence + trace);
            runner.finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void check(Context target) throws Exception {
        File fixture = new File(target.getCacheDir(), "runtime-diagnostics-test-" + UUID.randomUUID());
        Context isolated = isolated(target, new File(fixture, "history"));
        File committed = new File(isolated.getFilesDir(), "runtime-diagnostics.json");
        NativeRuntimeDiagnostics store = new NativeRuntimeDiagnostics(isolated);
        JSONObject first = store.recordRendererExit(false, 0);
        JSONObject reopened = new NativeRuntimeDiagnostics(isolated).read();
        JSONArray history = reopened.optJSONArray("entries");
        JSONObject disk = new JSONObject(new String(Files.readAllBytes(committed.toPath()), StandardCharsets.UTF_8));
        require(first.optBoolean("ok") && reopened.optBoolean("ok") && history != null && history.length() == 1
            && first.getJSONArray("entries").toString().equals(history.toString()) && metadataOnly(history.getJSONObject(0))
            && disk.length() == 1 && disk.getJSONArray("entries").toString().equals(history.toString()),
            "renderer metadata survives a new store instance and the committed file contains only the allowed non-content fields");

        // Distinct synthetic priority values make retention observable without adding identifiers to the schema.
        boolean writesConfirmed = true;
        for (int i = 1; i < 10; i++) writesConfirmed &= store.recordRendererExit(i % 2 == 1, i).optBoolean("ok");
        JSONObject retained = new NativeRuntimeDiagnostics(isolated).read();
        JSONArray entries = retained.optJSONArray("entries");
        boolean latestEight = entries != null && entries.length() == 8;
        if (latestEight) for (int i = 0; i < 8; i++) {
            JSONObject entry = entries.getJSONObject(i);
            latestEight &= entry.getInt("priority") == i + 2 && entry.getBoolean("didCrash") == ((i + 2) % 2 == 1)
                && metadataOnly(entry);
        }
        require(writesConfirmed && retained.optBoolean("ok") && latestEight,
            "ten committed exits retain the latest eight complete metadata entries in order");

        byte[] corrupt = "{\"entries\":[".getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(committed)) { output.write(corrupt); output.getFD().sync(); }
        JSONObject corruptRead = new NativeRuntimeDiagnostics(isolated).read();
        JSONObject refused = store.recordRendererExit(true, 2);
        require(!corruptRead.optBoolean("ok") && corruptRead.optBoolean("needsRecovery")
            && "runtime-diagnostics-invalid".equals(corruptRead.optString("error")) && !refused.optBoolean("ok")
            && refused.optBoolean("needsRecovery") && "runtime-diagnostics-invalid".equals(refused.optString("error"))
            && Arrays.equals(corrupt, Files.readAllBytes(committed.toPath())),
            "corrupt committed bytes remain unchanged and both read and append report recovery errors");

        Context blocked = isolated(target, new File(fixture, "blocked"));
        File temporary = new File(blocked.getFilesDir(), "runtime-diagnostics.json.tmp");
        if (!temporary.mkdir()) throw new IllegalStateException("cannot create the test-owned temporary-path obstruction");
        NativeRuntimeDiagnostics blockedStore = new NativeRuntimeDiagnostics(blocked);
        JSONObject failed = blockedStore.recordRendererExit(true, 2), empty = new NativeRuntimeDiagnostics(blocked).read();
        require(!failed.optBoolean("ok") && "runtime-diagnostics-write-failed".equals(failed.optString("error"))
            && failed.optBoolean("needsRecovery") && temporary.isDirectory()
            && !new File(blocked.getFilesDir(), "runtime-diagnostics.json").exists()
            && empty.optBoolean("ok") && empty.getJSONArray("entries").length() == 0,
            "a directory blocking the temporary file cannot report a successful write or create committed history");
    }

    private static Context isolated(Context target, File directory) {
        if (!directory.mkdirs() && !directory.isDirectory()) throw new IllegalStateException("cannot create test-owned directory");
        return new ContextWrapper(target) {
            @Override public File getFilesDir() { return directory; }
            @Override public Context getApplicationContext() { return this; }
        };
    }

    private static boolean metadataOnly(JSONObject entry) throws Exception {
        Set<String> allowed = new HashSet<>(Arrays.asList("at", "kind", "didCrash", "priority", "osApi",
            "webViewPackage", "webViewVersion", "appVersion"));
        Iterator<String> keys = entry.keys();
        while (keys.hasNext()) if (!allowed.remove(keys.next())) return false;
        return allowed.isEmpty() && "renderer-exit".equals(entry.getString("kind"))
            && entry.opt("at") instanceof Number && entry.opt("didCrash") instanceof Boolean
            && entry.opt("priority") instanceof Number && entry.getInt("osApi") == android.os.Build.VERSION.SDK_INT
            && entry.opt("webViewPackage") instanceof String && entry.opt("webViewVersion") instanceof String
            && entry.opt("appVersion") instanceof String;
    }

    private void require(boolean valid, String message) {
        if (!valid) throw new AssertionError(message);
        assertions++;
        evidence.append("PASS ").append(message).append('\n');
    }
}
