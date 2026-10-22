package local.quietpaper;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Local renderer metadata only. Call on the I/O queue; no note or device identity is recorded.
 * Methods return a fixed error code rather than propagating storage failures to the caller. */
public final class NativeRuntimeDiagnostics {
    private static final Object LOCK = new Object();
    private static final int MAX_ENTRIES = 8, MAX_BYTES = 64 * 1024;
    private final Context context;

    public NativeRuntimeDiagnostics(Context context) {
        Context owner = context;
        try {
            Context application = context.getApplicationContext();
            if (application != null) owner = application;
        } catch (RuntimeException unavailable) { /* Report context failures from the I/O method. */ }
        this.context = owner;
    }

    public JSONObject recordRendererExit(boolean didCrash, int priority) {
        synchronized (LOCK) {
            try {
                File destination = destination();
                JSONArray previous = load(destination), entries = new JSONArray();
                for (int i = Math.max(0, previous.length() - MAX_ENTRIES + 1); i < previous.length(); i++)
                    entries.put(previous.getJSONObject(i));
                PackageInfo provider = null, application = null;
                try { provider = WebView.getCurrentWebViewPackage(); }
                catch (RuntimeException | LinkageError unavailable) { /* No provider initialization or retry. */ }
                try { application = context.getPackageManager().getPackageInfo(context.getPackageName(), 0); }
                catch (Exception unavailable) { /* An absent version must not prevent recording the exit. */ }
                entries.put(new JSONObject().put("at", System.currentTimeMillis()).put("kind", "renderer-exit")
                    .put("didCrash", didCrash).put("priority", priority).put("osApi", Build.VERSION.SDK_INT)
                    .put("webViewPackage", metadata(provider == null ? null : provider.packageName))
                    .put("webViewVersion", metadata(provider == null ? null : provider.versionName))
                    .put("appVersion", metadata(application == null ? null : application.versionName)));
                durable(destination, new JSONObject().put("entries", entries).toString());
                return new JSONObject().put("ok", true).put("entries", entries);
            } catch (InvalidDiagnostics invalid) { return failure("runtime-diagnostics-invalid"); }
            catch (Exception unavailable) { return failure("runtime-diagnostics-write-failed"); }
        }
    }

    public JSONObject read() {
        synchronized (LOCK) {
            try { return new JSONObject().put("ok", true).put("entries", load(destination())); }
            catch (InvalidDiagnostics invalid) { return failure("runtime-diagnostics-invalid"); }
            catch (Exception unavailable) { return failure("runtime-diagnostics-read-failed"); }
        }
    }

    private File destination() throws IOException {
        File directory = context.getFilesDir();
        if (directory == null || !directory.isDirectory()) throw new IOException();
        return new File(directory, "runtime-diagnostics.json");
    }

    private static JSONArray load(File file) throws Exception {
        if (!file.exists()) return new JSONArray();
        if (!file.isFile()) throw new InvalidDiagnostics();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > MAX_BYTES) throw new InvalidDiagnostics();
                bytes.write(buffer, 0, count);
            }
        }
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
            JSONTokener parser = new JSONTokener(text);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject) || parser.nextClean() != 0) throw new InvalidDiagnostics();
            JSONObject document = (JSONObject) value;
            if (document.length() != 1 || !(document.opt("entries") instanceof JSONArray)) throw new InvalidDiagnostics();
            JSONArray entries = document.getJSONArray("entries");
            if (entries.length() > MAX_ENTRIES) throw new InvalidDiagnostics();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                if (entry.length() != 8 || !"renderer-exit".equals(entry.opt("kind"))
                        || !(entry.opt("didCrash") instanceof Boolean) || !integer(entry.opt("at"))
                        || entry.getLong("at") < 0 || !integer(entry.opt("priority"))
                        || entry.getLong("priority") != entry.getInt("priority") || !integer(entry.opt("osApi"))
                        || entry.getLong("osApi") <= 0 || entry.getLong("osApi") > Integer.MAX_VALUE
                        || !validMetadata(entry.opt("webViewPackage")) || !validMetadata(entry.opt("webViewVersion"))
                        || !validMetadata(entry.opt("appVersion"))) throw new InvalidDiagnostics();
            }
            return entries;
        } catch (Exception malformed) { throw new InvalidDiagnostics(); }
    }

    private static boolean integer(Object value) { return value instanceof Integer || value instanceof Long; }
    private static boolean validMetadata(Object value) {
        return value instanceof String && !((String) value).isEmpty() && ((String) value).length() <= 256;
    }
    private static String metadata(String value) { return validMetadata(value) ? value : "unknown"; }

    private static void durable(File destination, String text) throws Exception {
        File temporary = new File(destination.getPath() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(text.getBytes(StandardCharsets.UTF_8)); output.flush(); output.getFD().sync();
        }
        Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        FileDescriptor directory = Os.open(destination.getParentFile().getAbsolutePath(),
            OsConstants.O_RDONLY | OsConstants.O_CLOEXEC, 0);
        try {
            if (!OsConstants.S_ISDIR(Os.fstat(directory).st_mode)) throw new IOException();
            Os.fsync(directory);
        } finally { Os.close(directory); }
    }

    private static JSONObject failure(String code) {
        JSONObject result = new JSONObject();
        try { result.put("ok", false).put("error", code).put("needsRecovery", true); }
        catch (Exception impossible) { /* Fixed JSON primitives; never expose an exception or private path. */ }
        return result;
    }
    private static final class InvalidDiagnostics extends Exception { }
}
