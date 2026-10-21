package local.quietpaper;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;

/** JVM file-system checks for the same staging class shipped in the Android APK. */
public final class ExportStoreTest {
    public static void main(String[] args) throws Exception {
        File directory = Files.createTempDirectory("quiet-paper-export-test-").toFile();
        ExportStore store = new ExportStore(directory);
        ExportStore.Session session = store.begin("完整工程.quietpaper.json", "application/json");
        byte[] chunk = "{\"text\":\"笔迹 ✍️ 𝛼 ∫ x² dx\",\"history\":true}\n".repeat(1024).getBytes(StandardCharsets.UTF_8);
        MessageDigest expected = MessageDigest.getInstance("SHA-256");
        long total = 0; int sequence = 0;
        while (total < 20 * 1024 * 1024) {
            store.append(session.id, sequence++, chunk); expected.update(chunk); total += chunk.length;
        }
        boolean rejected = false;
        try { store.append(session.id, sequence - 1, chunk); } catch (IllegalStateException e) { rejected = true; }
        require(rejected, "duplicate/out-of-order chunk rejected");
        // Simulate a stopped process after bytes reached disk but before the
        // committed manifest offset advanced; reopen must discard that suffix.
        try (FileOutputStream file = new FileOutputStream(session.file, true)) { file.write("incomplete suffix".getBytes(StandardCharsets.UTF_8)); }
        store = new ExportStore(directory);
        store.append(session.id, sequence++, chunk); expected.update(chunk); total += chunk.length;
        session = store.complete(session.id);
        require(session.bytes == total && session.bytes > 16 * 1024 * 1024, "full project export exceeds source-document 16MiB cap");
        require(session.sha256.equals(HexFormat.of().formatHex(expected.digest())), "Unicode byte fidelity and no duplicate tail after restart");
        require(session.sha256.equals(ExportStore.digest(new FileInputStream(session.file))), "reopened staged file SHA-256 matches");
        require(new ExportStore(directory).pending().get(0).complete, "completed export remains recoverable across store restart");
        rejected = false;
        try { store.append(session.id, sequence, chunk); } catch (IllegalStateException e) { rejected = true; }
        require(rejected, "completed exports are immutable");
        store.discard(session.id);
        require(store.pending().isEmpty(), "explicit cleanup removes only the export staging session");
        Files.delete(directory.toPath());
        System.out.println("PASS ExportStore: 7 checks; " + total + " bytes, persisted chunks and restart recovery");
    }
    private static void require(boolean valid, String check) {
        if (!valid) throw new AssertionError(check);
    }
}
