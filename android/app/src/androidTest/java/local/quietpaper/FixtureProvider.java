package local.quietpaper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Real file-backed Android ContentResolver fixture; only present in the test APK. */
public final class FixtureProvider extends ContentProvider {
    private volatile boolean available = true, writeFailure, queryFailure;
    private final ConcurrentHashMap<String, AtomicInteger> writes = new ConcurrentHashMap<>();
    @Override public boolean onCreate() { return true; }
    private File file(String name) {
        if (!"fixture.md".equals(name) && !"fixture.tex".equals(name) && !"fault.md".equals(name))
            throw new IllegalArgumentException("fixture-name-not-allowed");
        return new File(getContext().getFilesDir(), name);
    }
    @Override public Bundle call(String method, String arg, Bundle extras) {
        try {
            if (method.equals("availability")) available = Boolean.parseBoolean(arg);
            else if (method.equals("writeFailure")) writeFailure = Boolean.parseBoolean(arg);
            else if (method.equals("queryFailure")) queryFailure = Boolean.parseBoolean(arg);
            else if (method.equals("set") || method.equals("setBytes")) {
                File destination = file(extras.getString("name"));
                byte[] content = method.equals("set") ? extras.getString("text").getBytes(StandardCharsets.UTF_8) : extras.getByteArray("bytes");
                if (content == null) throw new IllegalArgumentException("fixture-bytes-required");
                try (FileOutputStream stream = new FileOutputStream(destination)) {
                    stream.write(content); stream.getFD().sync();
                }
            } else if (method.equals("seedLarge")) {
                File destination = file(extras.getString("name"));
                int size = extras.getInt("size");
                if (size < 0 || size > 17 * 1024 * 1024) throw new IllegalArgumentException("fixture-size");
                byte[] chunk = new byte[8192]; Arrays.fill(chunk, (byte) 'a');
                try (FileOutputStream stream = new FileOutputStream(destination)) {
                    for (int offset = 0; offset < size; offset += chunk.length)
                        stream.write(chunk, 0, Math.min(chunk.length, size - offset));
                    stream.getFD().sync();
                }
            } else if (method.equals("stats")) {
                File source = file(arg);
                Bundle result = new Bundle(); result.putLong("bytes", source.length());
                AtomicInteger count = writes.get(arg); result.putInt("writes", count == null ? 0 : count.get());
                return result;
            } else throw new IllegalArgumentException("fixture-method-not-allowed");
            return Bundle.EMPTY;
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!available) throw new FileNotFoundException("fixture-source-offline");
        String name = uri.getLastPathSegment();
        File source = file(name);
        boolean writing = mode.contains("w");
        if (writing && writeFailure) throw new FileNotFoundException("fixture-write-failed");
        ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(source, ParcelFileDescriptor.parseMode(mode));
        if (writing) writes.computeIfAbsent(name, unused -> new AtomicInteger()).incrementAndGet();
        return descriptor;
    }
    @Override public String getType(Uri uri) { file(uri.getLastPathSegment()); return "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        File source = file(uri.getLastPathSegment());
        if (queryFailure) throw new IllegalStateException("fixture-metadata-unavailable");
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[] {uri.getLastPathSegment(), source.length()}); return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
