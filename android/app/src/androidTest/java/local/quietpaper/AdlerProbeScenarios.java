package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Reports an exact-build Adler comparison. It is not an application acceptance test. */
public final class AdlerProbeScenarios {
    private static final String SNAPSHOT = "assets/snapshot_blob_64.bin";
    private static final int MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
    private final Instrumentation runner;
    private final StringBuilder evidence = new StringBuilder();
    private MainActivity activity;
    private long comparisonStartedAt;
    private AdlerProbeScenarios(Instrumentation runner) { this.runner = runner; }

    public static void run(Instrumentation runner) {
        AdlerProbeScenarios scenario = new AdlerProbeScenarios(runner);
        Bundle result = new Bundle();
        int resultCode = Activity.RESULT_OK;
        String outcome;
        try {
            scenario.compare();
            scenario.observeRendererExitIfPresent();
            outcome = "DIAGNOSTIC complete; comparison results follow, no product acceptance claimed";
        } catch (Throwable failure) {
            resultCode = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            outcome = "DIAGNOSTIC refused or incomplete\n" + trace;
        }
        if (scenario.activity != null) {
            try { runner.runOnMainSync(() -> scenario.activity.finish()); }
            catch (Throwable cleanup) { scenario.evidence.append("activityCleanup=").append(cleanup).append('\n'); }
        }
        result.putString("stream", "\n" + outcome + "; pid=" + Process.myPid() + "\n" + scenario.evidence
            + "Scope: androidTest-only checksum observation in the instrumented application/browser process. "
            + "MainActivity starts solely to load the active WebView provider. No JavaScript, page callback or renderer result is awaited. "
            + "The payload is copied from the guarded provider APK into a direct buffer; this does not inspect the sandboxed renderer's actual snapshot mapping. "
            + "The chunk32 comparison calls the original function with a rolling Adler seed and at most 32 bytes per call. "
            + "An optional observation waits up to 60 seconds for a naturally occurring, persisted renderer-exit record since this comparison began; absence does not fail the diagnostic. "
            + "A checksum mismatch is a diagnostic result, not an application pass. "
            + "This does not verify WebView UI, the A/B model, source round trips or SAF picker behavior. "
            + "No WebView bytes, CPU feature flags or snapshot verification settings are changed.\n");
        runner.finish(resultCode, result);
    }

    private void compare() throws Exception {
        comparisonStartedAt = System.currentTimeMillis();
        record("comparisonStartedAt=" + comparisonStartedAt);
        activity = (MainActivity) runner.startActivitySync(
            new Intent(runner.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        record("MainActivity created to load WebView; proceeding without any JavaScript readiness dependency");
        PackageInfo provider = WebView.getCurrentWebViewPackage();
        if (provider == null) throw new IllegalStateException("No active loaded WebView provider");
        ApplicationInfo application = runner.getTargetContext().getPackageManager()
            .getApplicationInfo(provider.packageName, 0);
        File apk = new File(application.sourceDir).getCanonicalFile();
        record("provider=" + provider.packageName + "; version=" + provider.versionName + "; apk=" + apk);
        record("testApk=" + runner.getContext().getApplicationInfo().sourceDir);
        long base = findExactMappedElf(apk);
        record("elfBias=0x" + Long.toHexString(base) + "; APK library offset=0x"
            + Long.toHexString(NativeAdlerProbe.EXPECTED_APK_ELF_OFFSET)
            + "; bundledAdlerOffset=0x" + Long.toHexString(NativeAdlerProbe.ADLER_OFFSET));
        byte[] snapshot = readSnapshot(apk);
        int expected = littleEndianInt(snapshot, 8);
        int scalar = NativeAdlerProbe.scalarAdler0(snapshot, 12, snapshot.length - 12);
        record("snapshot=" + SNAPSHOT + "; bytes=" + snapshot.length + "; payloadBytes=" + (snapshot.length - 12)
            + "; sha256=" + NativeAdlerProbe.hex(MessageDigest.getInstance("SHA-256").digest(snapshot)));
        record("header=" + uintHex(expected) + "; scalarSeed0=" + uintHex(scalar)
            + "; headerEqualsScalar=" + (expected == scalar) + "; knownHostHeaderReference=0x882b7eae");
        ByteBuffer payload = ByteBuffer.allocateDirect(snapshot.length - 12);
        payload.put(snapshot, 12, snapshot.length - 12).flip();
        record("Starting one exact-ELF SHA256 guard and two individually BuildId-guarded bundled Adler paths: whole payload and <=32-byte chunks");
        int[] comparison = NativeAdlerProbe.checkedChecksumComparison(runner.getContext(), apk, base, payload, snapshot.length - 12);
        int bundled = comparison[0], chunked = comparison[1];
        record("exactElfSha256=" + NativeAdlerProbe.EXPECTED_ELF_SHA256
            + "; mappedBuildId=" + NativeAdlerProbe.EXPECTED_BUILD_ID + "; both guards accepted");
        record("diagnosticJniLoadedVia=" + NativeAdlerProbe.loadedVia());
        record("bundledSeed0=" + uintHex(bundled) + "; scalarSeed0=" + uintHex(scalar)
            + "; bundledEqualsScalar=" + (bundled == scalar) + "; bundledEqualsHeader=" + (bundled == expected));
        record("bundledChunk32Seed0=" + uintHex(chunked) + "; chunkCalls=" + ((snapshot.length - 12 + 31) / 32)
            + "; chunk32EqualsScalar=" + (chunked == scalar) + "; chunk32EqualsHeader=" + (chunked == expected)
            + "; chunk32EqualsWholePayload=" + (chunked == bundled));
    }

    private void observeRendererExitIfPresent() {
        final String[] allowed = { "at", "kind", "didCrash", "priority", "osApi",
            "webViewPackage", "webViewVersion", "appVersion" };
        long began = SystemClock.uptimeMillis(), deadline = began + 60000;
        String lastReadError = null;
        record("Optional runtime observation begins; only naturally occurring persisted exits are read; maxWaitMs=60000");
        while (true) {
            try {
                // Reopen the durable store on each poll: do not use a cached callback or in-memory event.
                JSONObject state = new NativeRuntimeDiagnostics(runner.getTargetContext()).read();
                if (state.optBoolean("ok")) {
                    JSONArray entries = state.optJSONArray("entries");
                    boolean observed = false;
                    if (entries != null) for (int i = 0; i < entries.length(); i++) {
                        JSONObject entry = entries.optJSONObject(i);
                        if (entry == null || entry.optLong("at", -1) < comparisonStartedAt) continue;
                        JSONObject metadata = new JSONObject();
                        for (String key : allowed) metadata.put(key, entry.get(key));
                        record("runtimeRendererExitMetadata=" + metadata);
                        observed = true;
                    }
                    if (observed) {
                        record("runtimeRendererExitObserved=true; observationElapsedMs=" + (SystemClock.uptimeMillis() - began)
                            + "; diagnostic observation only, no product acceptance claimed");
                        return;
                    }
                } else lastReadError = state.optString("error", "runtime-diagnostics-read-failed");
            } catch (Exception unavailableObservation) {
                // Optional evidence must not turn a completed checksum observation into a product verdict.
                lastReadError = unavailableObservation.getClass().getSimpleName();
            }
            long remaining = deadline - SystemClock.uptimeMillis();
            if (remaining <= 0) {
                record("runtimeRendererExitObserved=false; observationElapsedMs=" + (SystemClock.uptimeMillis() - began)
                    + "; no matching persisted record observed; optionalReadError=" + lastReadError);
                return;
            }
            try { Thread.sleep(Math.min(200, remaining)); }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                record("runtimeRendererExitObserved=false; optional observation interrupted; checksum results retained");
                return;
            }
        }
    }

    private long findExactMappedElf(File apk) throws Exception {
        long result = -1;
        try (BufferedReader maps = new BufferedReader(new FileReader("/proc/self/maps"))) {
            for (String line; (line = maps.readLine()) != null;) {
                String[] fields = line.trim().split("\\s+", 6);
                if (fields.length != 6 || !"r-xp".equals(fields[1])
                    || !fields[5].startsWith("/") || fields[5].endsWith(" (deleted)")) continue;
                if (!apk.equals(new File(fields[5]).getCanonicalFile())) continue;
                long offset = Long.parseLong(fields[2], 16);
                if (offset != NativeAdlerProbe.EXPECTED_APK_ELF_OFFSET) continue;
                String[] range = fields[0].split("-", 2);
                if (range.length != 2) throw new IllegalStateException("Malformed executable map: " + line);
                long start = Long.parseLong(range[0], 16), end = Long.parseLong(range[1], 16);
                // This exact ELF has PT_LOAD vaddr=0, offset=0 in its first RX segment.
                long bias = start - (offset - NativeAdlerProbe.EXPECTED_APK_ELF_OFFSET);
                long entry = bias + NativeAdlerProbe.ADLER_OFFSET;
                if (start <= 0 || end <= start || (bias & 4095) != 0 || entry < start || entry >= end)
                    throw new IllegalStateException("Target Adler address is not inside the guarded readable/executable mapping");
                if (result != -1) throw new IllegalStateException("Multiple exact provider executable maps; refusing ambiguous base");
                result = bias;
                record("exactExecutableMap=" + line);
            }
        }
        if (result == -1) throw new IllegalStateException(
            "Exact provider r-xp map at APK offset 0x7428000 not found; refusing to guess an ELF base");
        return result;
    }

    private byte[] readSnapshot(File apk) throws Exception {
        try (ZipFile zip = new ZipFile(apk)) {
            ZipEntry entry = zip.getEntry(SNAPSHOT);
            if (entry == null || entry.isDirectory() || entry.getSize() > MAX_SNAPSHOT_BYTES)
                throw new IllegalStateException("Expected bounded original snapshot64 asset is absent");
            record("additionalContextAssetPresent=" + (zip.getEntry("assets/v8_context_snapshot_64.bin") != null));
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = zip.getInputStream(entry)) {
                byte[] buffer = new byte[8192];
                for (int n; (n = input.read(buffer)) != -1;) {
                    if (bytes.size() > MAX_SNAPSHOT_BYTES - n) throw new IllegalStateException("Snapshot exceeds diagnostic bound");
                    bytes.write(buffer, 0, n);
                }
            }
            byte[] result = bytes.toByteArray();
            if (result.length <= 80) throw new IllegalStateException("Snapshot lacks the known V8 header");
            return result;
        }
    }

    private static int littleEndianInt(byte[] bytes, int offset) {
        return (bytes[offset] & 255) | ((bytes[offset + 1] & 255) << 8)
            | ((bytes[offset + 2] & 255) << 16) | ((bytes[offset + 3] & 255) << 24);
    }
    private static String uintHex(int value) { return String.format(Locale.ROOT, "0x%08x", value); }
    private void record(String message) {
        evidence.append(message).append('\n');
        Log.i("GlossaAdlerProbe", message);
    }
}
