package local.quietpaper;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.UUID;

/** Test-APK-only owner of real documents; target app requires system SAF URI grants. */
public final class SafFixtureDocumentsProvider extends DocumentsProvider {
    public static final String AUTHORITY = "local.quietpaper.test.documents";
    public static final String ROOT = "glossa-test-root";
    public static final String ROOT_LABEL = "Glossa test files";
    static final String[] DOC_COLUMNS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };
    static File directory(android.content.Context context) {
        File directory = new File(context.getFilesDir(), "saf-fault-fixtures");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("fixture-directory");
        return directory;
    }
    static File document(android.content.Context context, String id) {
        UUID.fromString(id);
        return new File(directory(context), id + ".md");
    }
    static String name(String id) { return "Glossa-faults-" + id + ".md"; }
    static String name(android.content.Context context, String id) {
        File metadata = new File(directory(context), id + ".name");
        if (!metadata.isFile()) return name(id);
        try { return new String(java.nio.file.Files.readAllBytes(metadata.toPath()), java.nio.charset.StandardCharsets.UTF_8); }
        catch (java.io.IOException failure) { throw new IllegalStateException("fixture-name", failure); }
    }
    static File readOnly(android.content.Context context, String id) { return new File(directory(context), id + ".readonly"); }
    static File offline(android.content.Context context, String id) { return new File(directory(context), id + ".offline"); }
    @Override public boolean onCreate() { return true; }
    @Override public Cursor queryRoots(String[] projection) {
        String[] columns = projection != null ? projection : new String[] {Root.COLUMN_ROOT_ID, Root.COLUMN_TITLE,
            Root.COLUMN_DOCUMENT_ID, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES, Root.COLUMN_AVAILABLE_BYTES};
        MatrixCursor cursor = new MatrixCursor(columns);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            Object value = null;
            if (Root.COLUMN_ROOT_ID.equals(column) || Root.COLUMN_DOCUMENT_ID.equals(column)) value = ROOT;
            else if (Root.COLUMN_TITLE.equals(column)) value = ROOT_LABEL;
            else if (Root.COLUMN_FLAGS.equals(column)) value = 0;
            else if (Root.COLUMN_MIME_TYPES.equals(column)) value = "text/markdown\ntext/plain\ntext/x-tex";
            else if (Root.COLUMN_AVAILABLE_BYTES.equals(column)) value = directory(getContext()).getUsableSpace();
            row.add(column, value);
        }
        cursor.setNotificationUri(getContext().getContentResolver(), DocumentsContract.buildRootsUri(AUTHORITY));
        return cursor;
    }
    @Override public Cursor queryDocument(String id, String[] projection) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DOC_COLUMNS);
        include(cursor, id);
        cursor.setNotificationUri(getContext().getContentResolver(), DocumentsContract.buildDocumentUri(AUTHORITY, id));
        return cursor;
    }
    @Override public Cursor queryChildDocuments(String parent, String[] projection, String sortOrder) throws FileNotFoundException {
        if (!ROOT.equals(parent)) throw new FileNotFoundException("not-root");
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DOC_COLUMNS);
        File[] files = directory(getContext()).listFiles(file -> file.getName().endsWith(".md"));
        if (files != null) {
            // DocumentsUI can reuse its sorting state across picker sessions. Honor
            // the requested order and default to newest fixture first when omitted.
            java.util.Comparator<File> order;
            if (sortOrder != null && sortOrder.contains(Document.COLUMN_DISPLAY_NAME)) {
                order = java.util.Comparator.comparing(file ->
                    name(getContext(), file.getName().substring(0, file.getName().length()-3)));
                if (sortOrder.toUpperCase(java.util.Locale.ROOT).contains("DESC")) order = order.reversed();
            } else {
                order = java.util.Comparator.comparingLong(File::lastModified);
                if (sortOrder == null || !sortOrder.toUpperCase(java.util.Locale.ROOT).contains("ASC")) order = order.reversed();
            }
            java.util.Arrays.sort(files, order.thenComparing(File::getName));
            for (File file : files) include(cursor, file.getName().substring(0, file.getName().length() - 3));
        }
        cursor.setNotificationUri(getContext().getContentResolver(), DocumentsContract.buildChildDocumentsUri(AUTHORITY, parent));
        return cursor;
    }
    static void notifyFixtureChanged(android.content.Context context, String id) {
        android.content.ContentResolver resolver = context.getContentResolver();
        resolver.notifyChange(DocumentsContract.buildDocumentUri(AUTHORITY, id), null);
        resolver.notifyChange(DocumentsContract.buildChildDocumentsUri(AUTHORITY, ROOT), null);
        // Roots are observed through this well-known URI by DocumentsUI.
        resolver.notifyChange(DocumentsContract.buildRootsUri(AUTHORITY), null);
    }
    private void include(MatrixCursor cursor, String id) throws FileNotFoundException {
        boolean root = ROOT.equals(id); File file = root ? directory(getContext()) : document(getContext(), id);
        if (!file.exists()) throw new FileNotFoundException("fixture-missing");
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : cursor.getColumnNames()) {
            Object value = null;
            if (Document.COLUMN_DOCUMENT_ID.equals(column)) value = id;
            else if (Document.COLUMN_DISPLAY_NAME.equals(column)) value = root ? ROOT_LABEL : name(getContext(), id);
            else if (Document.COLUMN_MIME_TYPE.equals(column)) value = root ? Document.MIME_TYPE_DIR : (name(getContext(),id).endsWith(".tex") ? "text/x-tex" : "text/markdown");
            else if (Document.COLUMN_FLAGS.equals(column)) value = root || readOnly(getContext(), id).exists() ? 0 : Document.FLAG_SUPPORTS_WRITE;
            else if (Document.COLUMN_SIZE.equals(column)) value = root ? 0L : file.length();
            else if (Document.COLUMN_LAST_MODIFIED.equals(column)) value = file.lastModified();
            row.add(column, value);
        }
    }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        if (offline(getContext(), id).exists()) throw new FileNotFoundException("fixture-source-temporarily-offline");
        if (mode.contains("w") && readOnly(getContext(), id).exists()) throw new FileNotFoundException("fixture-read-only");
        File file = document(getContext(), id);
        if (!file.isFile()) throw new FileNotFoundException("fixture-missing");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    }
}
