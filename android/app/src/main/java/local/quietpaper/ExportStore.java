package local.quietpaper;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.UUID;

/** A durable, bounded-memory export staging area. No document-size cap. */
public final class ExportStore {
    public static final int MAX_CHUNK_BYTES = 256 * 1024;
    private final File root;
    public ExportStore(File root) { this.root = root; root.mkdirs(); }
    public static final class Session {
        public String id, name, mime, sha256;
        public long bytes;
        public int sequence;
        public boolean complete;
        public File file;
    }
    public Session begin(String name, String mime) throws Exception {
        Session session = new Session(); session.id = UUID.randomUUID().toString();
        session.name = name; session.mime = mime; session.file = part(session.id);
        try (FileOutputStream stream = new FileOutputStream(session.file)) { stream.getFD().sync(); }
        persist(session); return session;
    }
    public Session append(String id, int sequence, byte[] data) throws Exception {
        Session session = read(id);
        if (session.complete) throw new IllegalStateException("export-already-complete");
        if (sequence != session.sequence) throw new IllegalStateException("export-chunk-sequence");
        if (data.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("export-chunk-too-large");
        // If a process stopped between data fsync and manifest fsync, retain the
        // last committed offset and allow the same chunk to be retried once.
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(session.file, "rw")) {
            if (file.length() < session.bytes) throw new IllegalStateException("export-staging-truncated");
            file.setLength(session.bytes); file.seek(session.bytes); file.write(data); file.getFD().sync();
        }
        session.bytes += data.length; session.sequence++; persist(session); return session;
    }
    public Session complete(String id) throws Exception {
        Session session = read(id);
        if (session.file.length() != session.bytes) throw new IllegalStateException("export-staging-length");
        session.sha256 = digest(new FileInputStream(session.file));
        session.complete = true; persist(session); return session;
    }
    public Session read(String id) throws Exception {
        if (!id.matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("invalid-export-session");
        Properties props = new Properties();
        try (FileInputStream stream = new FileInputStream(manifest(id))) { props.load(stream); }
        Session session = new Session(); session.id = id;
        session.name = props.getProperty("name"); session.mime = props.getProperty("mime");
        session.bytes = Long.parseLong(props.getProperty("bytes")); session.sequence = Integer.parseInt(props.getProperty("sequence"));
        session.complete = Boolean.parseBoolean(props.getProperty("complete")); session.sha256 = props.getProperty("sha256");
        session.file = part(id); return session;
    }
    public List<Session> pending() throws Exception {
        List<Session> result = new ArrayList<>(); File[] files = root.listFiles();
        if (files != null) for (File file : files) if (file.getName().endsWith(".properties")) result.add(read(file.getName().replace(".properties", "")));
        return result;
    }
    public void discard(String id) throws Exception {
        Session session = read(id);
        if (!session.file.delete() && session.file.exists()) throw new IllegalStateException("export-staging-remove-failed");
        if (!manifest(id).delete()) throw new IllegalStateException("export-manifest-remove-failed");
    }
    private File part(String id) { return new File(root, id + ".part"); }
    private File manifest(String id) { return new File(root, id + ".properties"); }
    private void persist(Session session) throws Exception {
        Properties props = new Properties(); props.setProperty("name", session.name); props.setProperty("mime", session.mime);
        props.setProperty("bytes", Long.toString(session.bytes)); props.setProperty("sequence", Integer.toString(session.sequence));
        props.setProperty("complete", Boolean.toString(session.complete));
        if (session.sha256 != null) props.setProperty("sha256", session.sha256);
        File temporary = new File(root, session.id + ".tmp");
        try (FileOutputStream stream = new FileOutputStream(temporary)) { props.store(stream, null); stream.getFD().sync(); }
        Files.move(temporary.toPath(), manifest(session.id).toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
    public static String digest(InputStream source) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = source) {
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : hash.digest()) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
