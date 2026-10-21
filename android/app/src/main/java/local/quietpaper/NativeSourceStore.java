package local.quietpaper;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.system.Os;
import android.system.OsConstants;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

/** Production ContentResolver source engine. It does not create or depend on a WebView.
 * Callers handle platform permissions and dispatch results; every instance shares the
 * same process lock so Activity recreation cannot race a durable source journal. */
public final class NativeSourceStore {
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    private static final Object LOCK = new Object();
    private final ContentResolver resolver;
    private final File files;

    public NativeSourceStore(Context context) {
        Context app = context.getApplicationContext();
        Context owner = app == null ? context : app;
        resolver = owner.getContentResolver();
        files = owner.getFilesDir();
    }

    public JSONObject readDocument(String requestId, String uri) {
        synchronized (LOCK) { return read(requestId, uri, "read", null); }
    }
    public JSONObject openDocument(String requestId, String uri, boolean persistentPermission) {
        synchronized (LOCK) { return read(requestId, uri, "open", persistentPermission); }
    }
    private JSONObject read(String requestId, String rawUri, String type, Boolean retained) {
        boolean sourceReachable = false;
        try {
            Uri uri = contentUri(rawUri);
            String text = readSource(uri);
            sourceReachable = true;
            snapshot(rawUri, text);
            JSONObject result = reply(requestId, type, rawUri).put("ok", true).put("sourceReachable", true)
                .put("text", text).put("sha256", sha(text));
            try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                int column = cursor == null ? -1 : cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                result.put("name", cursor != null && column >= 0 && cursor.moveToFirst() ? cursor.getString(column) : "document");
            } catch (Exception metadataFailure) {
                // The document was actually read. Metadata failure is not source unavailability.
                result.put("name", "document").put("metadataWarning", "source-name-unavailable");
            }
            if (retained != null) result.put("persistentPermission", retained);
            return result;
        } catch (Exception error) { return failure(requestId, type, rawUri, error, sourceReachable); }
    }

    public JSONObject saveDocument(String requestId, String uri, String text, String expectedSourceSha) {
        synchronized (LOCK) { return save(requestId, uri, text, expectedSourceSha, null, false); }
    }
    public JSONObject saveDocumentVersioned(String requestId, String uri, String text,
            String expectedSourceSha, String expectedPendingSha) {
        synchronized (LOCK) { return save(requestId, uri, text, expectedSourceSha, expectedPendingSha, true); }
    }
    public JSONObject retryPendingWrite(String requestId, String uri) {
        synchronized (LOCK) {
            try {
                JSONObject pending = readPending(uri);
                if (pending == null) throw new IllegalStateException("no-pending-write");
                return save(requestId, uri, pending.getString("text"), pending.getString("sha256"), null, false);
            } catch (Exception error) { return failure(requestId, "save", uri, error); }
        }
    }
    /** A source SHA alone cannot authorize replacing a newer pending version. */
    public JSONObject resolveSourceConflict(String requestId, String uri, String text, String sourceSha) {
        synchronized (LOCK) {
            return failure(requestId, "save", uri, new IllegalStateException("versioned-resolution-required"));
        }
    }

    private JSONObject save(String requestId, String rawUri, String text, String expected,
            String expectedPending, boolean versioned) {
        boolean staged = false, existingPending = false, sourceReachable = false;
        String previousSha = null;
        try {
            if (text == null || expected == null) throw new IllegalArgumentException("source-version-required");
            if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new IllegalArgumentException("document-too-large");
            Uri uri = contentUri(rawUri);
            existingPending = pendingFile(rawUri).exists();
            JSONObject previous = readPending(rawUri);
            previousSha = previous == null ? null : previous.getString("sha256");
            String base = SourceWritePolicy.base(previous == null ? null : previous.getString("text"), previousSha,
                previous == null ? null : previous.getString("baseSha256"), text, expected, expectedPending, versioned);
            JSONObject pending = new JSONObject().put("uri", rawUri).put("text", text).put("sha256", sha(text))
                .put("baseSha256", base).put("queuedAt", System.currentTimeMillis());
            if (previous != null) durable(new File(sourceDirectory(rawUri), "pending-" + UUID.randomUUID() + ".json"), previous.toString());
            // A rename may commit before directory fsync reports an error. Never
            // report an empty queue once staging has begun; recovery re-reads it.
            staged = true;
            durable(pendingFile(rawUri), pending.toString());
            String source = readSource(uri);
            sourceReachable = true;
            String current = sha(source);
            if (current.equals(sha(text))) {
                snapshot(rawUri, source);
                removePending(rawUri);
                return reply(requestId, "save", rawUri).put("ok", true).put("sourceReachable", true).put("sha256", current).put("pending", false);
            }
            if (!current.equals(base)) {
                return reply(requestId, "save", rawUri).put("ok", false).put("sourceReachable", true).put("error", "source-conflict")
                    .put("sourceText", source).put("sourceSha256", current).put("pending", true).put("sha256", sha(text));
            }
            snapshot(rawUri, source);
            writeSource(uri, text);
            String verified = readSource(uri);
            if (!sha(verified).equals(sha(text))) throw new IllegalStateException("write-verification-failed");
            snapshot(rawUri, verified);
            removePending(rawUri);
            return reply(requestId, "save", rawUri).put("ok", true).put("sourceReachable", true).put("sha256", sha(text)).put("pending", false);
        } catch (Exception error) {
            JSONObject result = failure(requestId, "save", rawUri, error, sourceReachable);
            try {
                return result.put("pending", staged || existingPending).put("sha256", staged ? sha(text) : previousSha);
            } catch (Exception envelopeFailure) { return result; }
        }
    }

    public JSONObject getPendingSource(String requestId, String uri) {
        synchronized (LOCK) {
            try {
                JSONObject pending = readPending(uri);
                JSONObject result = reply(requestId, "source-pending", uri).put("ok", true).put("pending", pending != null);
                if (pending != null) result.put("text", pending.getString("text")).put("sha256", pending.getString("sha256"))
                    .put("baseSha256", pending.getString("baseSha256"));
                return result;
            } catch (Exception error) { return failure(requestId, "source-pending", uri, error); }
        }
    }
    public JSONObject getPendingWrites(String requestId) {
        synchronized (LOCK) {
            try {
                JSONArray entries = new JSONArray(), diagnostics = new JSONArray();
                File[] pending = directory(new File(files, "native-pending")).listFiles();
                if (pending == null) throw new StoreFailure("local-journal-failed");
                for (File file : pending) {
                    // Atomic-write .tmp files are uncommitted remnants, not queue entries.
                    if (!file.isFile() || !file.getName().endsWith(".json")) continue;
                    try {
                        JSONObject item = readCommittedPending(file, null);
                        item.remove("text"); entries.put(item);
                    } catch (Exception damaged) {
                        diagnostics.put(new JSONObject().put("file", file.getName()).put("error", "pending-journal-invalid"));
                    }
                }
                JSONObject result = reply(requestId, "pending", null).put("ok", true).put("entries", entries);
                if (diagnostics.length() > 0) result.put("diagnostics", diagnostics).put("needsRecovery", true);
                return result;
            } catch (Exception error) { return failure(requestId, "pending", null, error); }
        }
    }
    public JSONObject getSourceSnapshot(String requestId, String uri) {
        synchronized (LOCK) {
            try {
                JSONObject pending = readPending(uri);
                String text = pending == null ? readLocalText(new File(sourceDirectory(uri), "latest.txt")) : pending.getString("text");
                return reply(requestId, "snapshot", uri).put("ok", true).put("text", text).put("sha256", sha(text))
                    .put("pending", pending != null);
            } catch (Exception error) { return failure(requestId, "snapshot", uri, error); }
        }
    }

    private Uri contentUri(String rawUri) {
        if (rawUri == null) throw new IllegalArgumentException("content-uri-required");
        Uri uri = Uri.parse(rawUri);
        if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException("content-uri-required");
        return uri;
    }
    private String readSource(Uri uri) throws Exception {
        byte[] bytes;
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) throw new SourceAccessFailure();
            bytes = readBytes(input, MAX_BYTES, "document-too-large");
        } catch (IOException | SecurityException inaccessible) {
            throw new SourceAccessFailure();
        } catch (StoreFailure contentFailure) {
            throw new StoreFailure(contentFailure.getMessage(), true);
        }
        try { return decode(bytes); }
        catch (StoreFailure invalidUtf8) { throw new StoreFailure(invalidUtf8.getMessage(), true); }
    }
    private void writeSource(Uri uri, String text) throws Exception {
        try (OutputStream output = resolver.openOutputStream(uri, "rwt")) {
            if (output == null) throw new StoreFailure("source-write-failed");
            output.write(text.getBytes(StandardCharsets.UTF_8)); output.flush();
        } catch (IOException | SecurityException writeFailure) {
            // Read-only or write-denied does not prove that a readable source is offline.
            throw new StoreFailure("source-write-failed");
        }
    }
    private String readLocalText(File file) throws Exception {
        try (InputStream input = new FileInputStream(file)) { return decode(readBytes(input, MAX_BYTES, "document-too-large")); }
        catch (IOException localFailure) { throw new StoreFailure("local-journal-failed"); }
    }
    private static byte[] readBytes(InputStream input, int maximum, String tooLarge) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (bytes.size() + count > maximum) throw new StoreFailure(tooLarge);
            bytes.write(buffer, 0, count);
        }
        return bytes.toByteArray();
    }
    private static String decode(byte[] bytes) throws StoreFailure {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) { throw new StoreFailure("invalid-utf8"); }
    }
    private File directory(File directory) throws StoreFailure {
        if (!directory.exists()) {
            File parent = directory.getParentFile();
            if (parent != null && !parent.isDirectory()) directory(parent);
            if (!directory.mkdir() && !directory.isDirectory()) throw new StoreFailure("local-journal-failed");
            if (parent != null) syncDirectory(parent);
        }
        if (!directory.isDirectory()) throw new StoreFailure("local-journal-failed");
        return directory;
    }
    private File pendingFile(String uri) throws Exception { return new File(directory(new File(files, "native-pending")), sha(uri) + ".json"); }
    private File sourceDirectory(String uri) throws Exception { return directory(new File(files, "native-sources/" + sha(uri))); }
    private JSONObject readPending(String uri) throws Exception {
        File file = pendingFile(uri);
        return file.exists() ? readCommittedPending(file, uri) : null;
    }
    private JSONObject readCommittedPending(File file, String expectedUri) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            JSONObject item = new JSONObject(decode(readBytes(input, MAX_BYTES * 8, "journal-too-large")));
            String uri = item.getString("uri"), text = item.getString("text"), checksum = item.getString("sha256");
            item.getString("baseSha256");
            contentUri(uri);
            if ((expectedUri != null && !uri.equals(expectedUri)) || !file.getName().equals(sha(uri) + ".json") || !sha(text).equals(checksum)) {
                throw new StoreFailure("pending-journal-invalid");
            }
            return item;
        } catch (Exception invalid) { throw new StoreFailure("pending-journal-invalid"); }
    }
    private void removePending(String uri) throws Exception {
        File pending = pendingFile(uri);
        if (!pending.delete()) throw new StoreFailure("pending-journal-remove-failed");
        syncDirectory(pending.getParentFile());
    }
    private void snapshot(String uri, String text) throws Exception {
        File directory = sourceDirectory(uri);
        File version = new File(directory, sha(text) + ".txt");
        if (!version.exists()) durable(version, text);
        durable(new File(directory, "latest.txt"), text);
        durable(new File(directory, "source-uri.txt"), uri);
    }
    private void durable(File destination, String text) throws StoreFailure {
        File temporary = new File(destination.getPath() + ".tmp");
        try (FileOutputStream stream = new FileOutputStream(temporary)) {
            stream.write(text.getBytes(StandardCharsets.UTF_8)); stream.flush(); stream.getFD().sync();
        } catch (Exception failed) { throw new StoreFailure("local-journal-failed"); }
        try { Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (Exception failed) { throw new StoreFailure("local-journal-failed"); }
        syncDirectory(destination.getParentFile());
    }
    private static void syncDirectory(File directory) throws StoreFailure {
        try {
            FileDescriptor descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_CLOEXEC, 0);
            try {
                if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) throw new StoreFailure("local-journal-failed");
                Os.fsync(descriptor);
            }
            finally { Os.close(descriptor); }
        } catch (Exception failed) { throw new StoreFailure("local-journal-failed"); }
    }
    private static String sha(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder();
        for (byte b : digest) output.append(String.format(Locale.ROOT, "%02x", b & 255));
        return output.toString();
    }
    private static JSONObject reply(String requestId, String type, String uri) throws Exception {
        return new JSONObject().put("requestId", requestId).put("type", type).put("uri", uri);
    }
    private static JSONObject failure(String requestId, String type, String uri, Exception error) {
        return failure(requestId, type, uri, error, false);
    }
    private static JSONObject failure(String requestId, String type, String uri, Exception error, boolean sourceReachable) {
        try {
            String code = error instanceof SourceAccessFailure ? "source-unavailable" : error.getMessage();
            if (code == null || code.isEmpty()) code = error.getClass().getSimpleName();
            JSONObject result = reply(requestId, type, uri).put("ok", false).put("error", code)
                .put("unavailable", error instanceof SourceAccessFailure);
            if (!(error instanceof SourceAccessFailure) && (sourceReachable || (error instanceof StoreFailure && ((StoreFailure) error).sourceReachable))) {
                result.put("sourceReachable", true);
            }
            return result;
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
    private static class StoreFailure extends Exception {
        final boolean sourceReachable;
        StoreFailure(String code) { this(code, false); }
        StoreFailure(String code, boolean reachable) { super(code); sourceReachable = reachable; }
    }
    private static final class SourceAccessFailure extends Exception { SourceAccessFailure() { super("source-unavailable"); } }
}
