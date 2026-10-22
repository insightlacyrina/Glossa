package local.quietpaper;

import android.content.Context;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Exact-build, androidTest-only adapter. Never patches WebView or disables its checks. */
public final class NativeAdlerProbe {
    public static final String EXPECTED_ELF_SHA256 =
        "e154b524119b6670b824d3e11a1794bf32e4a497aef18ed5d76fbe6e01d4eded";
    public static final String EXPECTED_BUILD_ID = "68dabd72c6088238cbfc9a5fbfe211f916771df5";
    public static final long EXPECTED_APK_ELF_OFFSET = 0x7428000L;
    public static final long ADLER_OFFSET = 0x3f8f260L;
    private static final String ENTRY = "lib/x86_64/libwebviewchromium.so";
    private static final String LIBRARY = "libglossa_adler_probe.so";
    private static String loadedVia;
    private NativeAdlerProbe() {}

    /** The caller derives loadedElfBias from the exact APK's readable executable map. */
    public static int checkedChecksum(Context testContext, File actualLoadedProviderApk,
                                      long loadedElfBias, ByteBuffer payload, int length) throws Exception {
        prepareCall(testContext, actualLoadedProviderApk, payload, length);
        // JNI independently verifies the in-memory ELF ABI and GNU Build ID before calling the offset.
        return checksum(loadedElfBias, payload, length);
    }

    /** Same original function, rolling seed, calls of at most 32 bytes; no CPU flag changes. */
    public static int checkedChecksumChunked(Context testContext, File actualLoadedProviderApk,
                                             long loadedElfBias, ByteBuffer payload, int length) throws Exception {
        prepareCall(testContext, actualLoadedProviderApk, payload, length);
        return checksumChunked(loadedElfBias, payload, length);
    }

    /** One full APK ELF hash guard for this pair; each JNI entry also checks the mapped Build ID. */
    public static int[] checkedChecksumComparison(Context testContext, File actualLoadedProviderApk,
                                                  long loadedElfBias, ByteBuffer payload, int length) throws Exception {
        prepareCall(testContext, actualLoadedProviderApk, payload, length);
        return new int[] { checksum(loadedElfBias, payload, length),
                           checksumChunked(loadedElfBias, payload, length) };
    }

    private static void prepareCall(Context testContext, File actualLoadedProviderApk,
                                    ByteBuffer payload, int length) throws Exception {
        verifyExactElfInApk(actualLoadedProviderApk);
        if (payload == null || !payload.isDirect() || payload.position() != 0 ||
            length < 0 || length > payload.limit()) {
            throw new IllegalArgumentException("Direct payload buffer must start at position 0 and contain length bytes");
        }
        loadDiagnosticLibrary(testContext);
    }

    public static void verifyExactElfInApk(File apk) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (ZipFile zip = new ZipFile(apk)) {
            ZipEntry entry = zip.getEntry(ENTRY);
            if (entry == null || entry.isDirectory())
                throw new IllegalArgumentException("Exact x86_64 WebView library is absent");
            try (InputStream input = zip.getInputStream(entry)) {
                byte[] bytes = new byte[65536];
                for (int n; (n = input.read(bytes)) != -1;) digest.update(bytes, 0, n);
            }
        }
        String actual = hex(digest.digest());
        if (!EXPECTED_ELF_SHA256.equals(actual))
            throw new IllegalArgumentException("Refused: actual provider ELF SHA256=" + actual
                + "; expected=" + EXPECTED_ELF_SHA256);
    }

    private static synchronized void loadDiagnosticLibrary(Context testContext) {
        if (loadedVia != null) return;
        UnsatisfiedLinkError first;
        try {
            System.loadLibrary("glossa_adler_probe");
            loadedVia = "System.loadLibrary(glossa_adler_probe)";
            return;
        } catch (UnsatisfiedLinkError unavailableInTestClassLoader) {
            first = unavailableInTestClassLoader;
        }
        String nativeDirectory = testContext.getApplicationInfo().nativeLibraryDir;
        if (nativeDirectory != null) {
            File extracted = new File(nativeDirectory, LIBRARY);
            if (extracted.isFile()) {
                try {
                    System.load(extracted.getAbsolutePath());
                    loadedVia = extracted.getAbsolutePath();
                    return;
                } catch (UnsatisfiedLinkError unavailableExtractedLibrary) {
                    first.addSuppressed(unavailableExtractedLibrary);
                }
            }
        }
        // Instrumentation's test ClassLoader may not search its APK's native-library directory.
        // This absolute APK path is supported by Android's linker for aligned uncompressed entries.
        String apkPath = testContext.getApplicationInfo().sourceDir + "!/lib/x86_64/" + LIBRARY;
        try {
            System.load(apkPath);
            loadedVia = apkPath;
        } catch (UnsatisfiedLinkError unavailableApkLibrary) {
            unavailableApkLibrary.addSuppressed(first);
            throw unavailableApkLibrary;
        }
    }

    public static synchronized String loadedVia() { return loadedVia; }

    /** Independent scalar reference using V8's initial Adler value 0. */
    public static int scalarAdler0(byte[] bytes, int offset, int length) {
        if (offset < 0 || length < 0 || offset > bytes.length - length)
            throw new IllegalArgumentException("Invalid payload range");
        int a = 0, b = 0;
        for (int i = offset; i < offset + length; i++) {
            a = (a + (bytes[i] & 255)) % 65521;
            b = (b + a) % 65521;
        }
        return (b << 16) | a;
    }

    public static String hex(byte[] bytes) {
        char[] alphabet = "0123456789abcdef".toCharArray();
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) hex.append(alphabet[(b & 255) >>> 4]).append(alphabet[b & 15]);
        return hex.toString();
    }

    private static native int checksum(long libBase, ByteBuffer directBuffer, int len);
    private static native int checksumChunked(long libBase, ByteBuffer directBuffer, int len);
}
