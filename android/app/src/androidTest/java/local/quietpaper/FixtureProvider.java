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

/** Real Android ContentResolver fixture; excluded from the production APK. */
public final class FixtureProvider extends ContentProvider {
    private boolean available = true;
    @Override public boolean onCreate() { return true; }
    @Override public Bundle call(String method, String arg, Bundle extras) {
        try {
            if (method.equals("availability")) available = Boolean.parseBoolean(arg);
            if (method.equals("set")) {
                File file = new File(getContext().getFilesDir(), extras.getString("name"));
                try (FileOutputStream stream = new FileOutputStream(file)) {
                    stream.write(extras.getString("text").getBytes(StandardCharsets.UTF_8)); stream.getFD().sync();
                }
            }
            return Bundle.EMPTY;
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!available) throw new FileNotFoundException("fixture-source-offline");
        String name = uri.getLastPathSegment();
        if (!"fixture.md".equals(name) && !"fixture.tex".equals(name)) throw new FileNotFoundException();
        File file = new File(getContext().getFilesDir(), name);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    }
    @Override public String getType(Uri uri) { return "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME});
        cursor.addRow(new Object[] {uri.getLastPathSegment()}); return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
