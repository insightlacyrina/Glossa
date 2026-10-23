package local.quietpaper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;

/** Test APK control plane only; never grants target UID permission to document URIs. */
public final class SafFixtureControlProvider extends ContentProvider {
    public static final String AUTHORITY = "local.quietpaper.test.safcontrol";
    @Override public boolean onCreate() { return true; }
    @Override public Bundle call(String method, String id, Bundle extras) {
        try {
            File document = SafFixtureDocumentsProvider.document(getContext(), id);
            File offline = SafFixtureDocumentsProvider.offline(getContext(), id);
            Bundle result = new Bundle(); result.putInt("ownerUid", Process.myUid());
            result.putString("uri", android.provider.DocumentsContract.buildDocumentUri(SafFixtureDocumentsProvider.AUTHORITY, id).toString());
            result.putString("name", SafFixtureDocumentsProvider.name(id));
            if ("create".equals(method) || "set".equals(method)) {
                if ("create".equals(method) && document.exists()) throw new IllegalStateException("fixture-already-exists");
                if ("set".equals(method) && !document.exists()) throw new IllegalStateException("fixture-missing");
                if ("create".equals(method) && extras.containsKey("name")) {
                    String name = extras.getString("name");
                    if (name == null || name.length() > 150 || !name.startsWith("Glossa-") || !name.contains(id)
                        || !(name.endsWith(".md") || name.endsWith(".tex")) || name.contains("/") || name.contains("\\"))
                        throw new IllegalArgumentException("fixture-name");
                    try (FileOutputStream out = new FileOutputStream(new File(SafFixtureDocumentsProvider.directory(getContext()), id+".name"))) {
                        out.write(name.getBytes(java.nio.charset.StandardCharsets.UTF_8)); out.getFD().sync();
                    }
                }
                byte[] bytes = extras.getByteArray("bytes");
                if (bytes == null && extras.containsKey("base64")) bytes = android.util.Base64.decode(extras.getString("base64"), android.util.Base64.DEFAULT);
                if (bytes == null && extras.containsKey("text")) bytes = extras.getString("text").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                if (bytes == null || bytes.length > 65536) throw new IllegalArgumentException("fixture-bytes");
                try (FileOutputStream out = new FileOutputStream(document)) { out.write(bytes); out.getFD().sync(); }
                if ("create".equals(method) && extras.getBoolean("readonly"))
                    try (FileOutputStream out = new FileOutputStream(SafFixtureDocumentsProvider.readOnly(getContext(), id))) { out.getFD().sync(); }
            } else if ("offline".equals(method)) {
                if (extras.getBoolean("offline")) { try (FileOutputStream out = new FileOutputStream(offline)) { out.getFD().sync(); } }
                else if (offline.exists() && !offline.delete()) throw new IllegalStateException("fixture-online-failed");
            } else if ("revoke".equals(method)) {
                Uri uri = android.provider.DocumentsContract.buildDocumentUri(SafFixtureDocumentsProvider.AUTHORITY, id);
                // The URI overload removes grants issued by any mechanism, including
                // ACTION_OPEN_DOCUMENT's activity grants. The package overload only
                // targets explicit grantUriPermission calls and leaves those alive.
                getContext().revokeUriPermission(uri,
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } else if ("bytes".equals(method)) {
                byte[] content = Files.readAllBytes(document.toPath());
                result.putByteArray("bytes", content);
                result.putString("text", new String(content, java.nio.charset.StandardCharsets.UTF_8));
                result.putInt("length", content.length);
                byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(content);
                StringBuilder sha256 = new StringBuilder(64);
                for (byte value : digest) {
                    int unsigned = value & 0xff;
                    sha256.append(Character.forDigit(unsigned >>> 4, 16));
                    sha256.append(Character.forDigit(unsigned & 0x0f, 16));
                }
                result.putString("sha256", sha256.toString());
            } else throw new IllegalArgumentException("fixture-method");
            result.putString("name", SafFixtureDocumentsProvider.name(getContext(), id));
            if ("create".equals(method) || "set".equals(method) || "offline".equals(method))
                SafFixtureDocumentsProvider.notifyFixtureChanged(getContext(), id);
            return result;
        } catch (Exception error) { throw new IllegalStateException(error); }
    }
    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) { throw new UnsupportedOperationException(); }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
