package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import android.view.ViewGroup;
import android.util.Log;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Framework-only Android integration tests; no desktop mocks and no network AI. */
public final class NativeRoundTripInstrumentation extends RendererRecoveryInstrumentation {
    private MainActivity activity;
    private WebView web;
    private final StringBuilder evidence = new StringBuilder();
    private boolean rendererRecovery;
    private String nativeSourcePhase;
    private boolean webViewProbe;
    private boolean appBridge;
    private boolean adlerProbe;
    private boolean runtimeDiagnostics;
    private String safPhase;
    @Override public void onCreate(Bundle arguments) {
        rendererRecovery = arguments != null && "renderer-recovery".equals(arguments.getString("mode"));
        String mode = arguments == null ? null : arguments.getString("mode");
        webViewProbe = "webview-probe".equals(mode);
        appBridge = "app-bridge".equals(mode);
        adlerProbe = "adler-probe".equals(mode);
        runtimeDiagnostics = "runtime-diagnostics".equals(mode);
        if (mode != null && mode.startsWith("saf-")) safPhase = mode.substring(4);
        if (mode != null && mode.startsWith("native-source-")) nativeSourcePhase = mode.substring("native-source-".length());
        super.onCreate(arguments);
    }
    @Override public void onStart() {
        if (webViewProbe) { WebViewProbeScenarios.run(this); return; }
        if (appBridge) { NativeAppBridgeScenarios.run(this); return; }
        if (adlerProbe) { AdlerProbeScenarios.run(this); return; }
        if (runtimeDiagnostics) { RuntimeDiagnosticsScenarios.run(this); return; }
        if (safPhase != null) { SafPickerScenarios.run(this, safPhase); return; }
        if (nativeSourcePhase != null) { NativeSourceScenarios.run(this, nativeSourcePhase); return; }
        if (rendererRecovery) { super.onStart(); return; }
        Bundle results = new Bundle();
        try {
            Log.i("GlossaTest", "Starting native bridge instrumentation");
            activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            runOnMainSync(() -> {
                web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
                web.stopLoading();
                web.loadDataWithBaseURL("https://appassets.quietpaper.local/", "<html><body>native integration fixture<script>window.__nativeFixtureReady=true;</script></body></html>", "text/html", "UTF-8", null);
            });
            waitUntil("window.__nativeFixtureReady===true && document.readyState==='complete'");
            Log.i("GlossaTest", "Dedicated WebView fixture ready");
            evaluate("window.__results=[];window.addEventListener('quietpaper-native',e=>window.__results.push(e.detail));true");
            MainActivity.NativeBridge bridge = activity.new NativeBridge();
            require(bridge.getRole().equals("tablet"), "physical-tablet-role");
            roundTrip(bridge, "fixture.md", "---\ntitle: 原生往返\n---\n\n# 推导\n\n$E=mc^2$\n", "---\ntitle: 原生往返\n---\n\n# 推导\n\n$E=mc^3$\n");
            roundTrip(bridge, "fixture.tex", "\\documentclass{article}\n% 保留注释\n\\begin{document}\n$x+1$\n\\end{document}\n", "\\documentclass{article}\n% 保留注释\n\\begin{document}\n$x+2$\n\\end{document}\n");
            results.putString("stream", "\nPASS native UTF-8 Markdown/LaTeX read-modify-write-reopen, source conflict, offline journal retry\n" + evidence);
            finish(Activity.RESULT_OK, results);
        } catch (Throwable error) {
            results.putString("stream", "\nFAIL " + error + "\n" + evidence);
            finish(Activity.RESULT_CANCELED, results);
        }
    }
    private void roundTrip(MainActivity.NativeBridge bridge, String name, String before, String after) throws Exception {
        Uri uri = Uri.parse("content://local.quietpaper.test.source/" + name);
        getTargetContext().getContentResolver().call(uri, "availability", "true", null);
        setSource(name, before);
        bridge.readDocument("read-" + name, uri.toString());
        waitResult("read-" + name, "e.ok && e.text===" + JSONObject.quote(before));
        bridge.saveDocument("save-" + name, uri.toString(), after, sha(before));
        waitResult("save-" + name, "e.ok && !e.pending");
        require(readSource(uri).equals(after), name + " exact reopen including comments, front matter, whitespace and formulas");
        bridge.saveDocument("same-target-" + name, uri.toString(), after, sha(before));
        waitResult("same-target-" + name, "e.ok && !e.pending");
        require(readSource(uri).equals(after), name + " exact target already present is acknowledged without stale-base overwrite");
        String external = after + "% external\n";
        setSource(name, external);
        bridge.saveDocument("conflict-" + name, uri.toString(), after + "local", sha(after));
        waitResult("conflict-" + name, "!e.ok && e.error==='source-conflict' && e.pending");
        require(readSource(uri).equals(external), name + " source conflict never overwrites external content");
        String resolved = external + "% resolved\n";
        bridge.saveDocumentVersioned("resolve-" + name, uri.toString(), resolved, sha(external), sha(after + "local"));
        waitResult("resolve-" + name, "e.ok && !e.pending");
        require(readSource(uri).equals(resolved), name + " explicit conflict resolution");
        getTargetContext().getContentResolver().call(uri, "availability", "false", null);
        String offline = resolved + "% offline edit\n";
        bridge.saveDocument("offline-" + name, uri.toString(), offline, sha(resolved));
        waitResult("offline-" + name, "!e.ok && e.pending");
        bridge.saveDocument("offline-identical-" + name, uri.toString(), offline, sha(resolved));
        waitResult("offline-identical-" + name, "!e.ok && e.pending && e.error!=='pending-content-changed'");
        bridge.getPendingSource("pending-" + name, uri.toString());
        waitResult("pending-" + name, "e.ok && e.pending && e.text===" + JSONObject.quote(offline) + " && e.baseSha256===" + JSONObject.quote(sha(resolved)));
        bridge.saveDocumentVersioned("stale-pending-" + name, uri.toString(), offline + "% must not replace\n", sha(resolved), "");
        waitResult("stale-pending-" + name, "!e.ok && e.pending && e.error==='pending-content-changed'");
        bridge.getSourceSnapshot("snapshot-" + name, uri.toString());
        waitResult("snapshot-" + name, "e.ok && e.pending && e.text===" + JSONObject.quote(offline));
        bridge.saveDocumentVersioned("known-pending-" + name, uri.toString(), offline, sha(resolved), sha(offline));
        waitResult("known-pending-" + name, "!e.ok && e.pending && e.error!=='pending-content-changed'");
        getTargetContext().getContentResolver().call(uri, "availability", "true", null);
        bridge.retryPendingWrite("retry-" + name, uri.toString());
        waitResult("retry-" + name, "e.ok && !e.pending");
        require(readSource(uri).equals(offline), name + " durable pending journal retries after provider becomes available");
        bridge.saveDocumentVersioned("removed-pending-" + name, uri.toString(), offline + "% stale\n", sha(offline), sha(offline));
        waitResult("removed-pending-" + name, "!e.ok && e.error==='pending-content-changed'");
        require(readSource(uri).equals(offline), name + " disappeared pending CAS does not overwrite source");
    }
    private void setSource(String name, String text) {
        Bundle extras = new Bundle(); extras.putString("name", name); extras.putString("text", text);
        getTargetContext().getContentResolver().call(Uri.parse("content://local.quietpaper.test.source/" + name), "set", null, extras);
    }
    private String readSource(Uri uri) throws Exception {
        try (java.io.InputStream input = getTargetContext().getContentResolver().openInputStream(uri)) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    private void waitResult(String id, String check) throws Exception {
        waitUntil("window.__results.some(e=>e.requestId===" + JSONObject.quote(id) + " && (" + check + "))");
    }
    private void waitUntil(String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 120000;
        while (System.currentTimeMillis() < deadline) {
            try { if (evaluate(expression).equals("true")) return; }
            catch (EvaluationTimeout navigation) {
                // Chromium may cancel an evaluation callback when loadData
                // replaces the prior application document. Retry in the new
                // document rather than interpreting a canceled callback as a
                // source-write failure.
                Log.i("GlossaTest", "Evaluation interrupted during fixture navigation; retrying");
            }
            Thread.sleep(100);
        }
        throw new IllegalStateException("Timed out: " + expression + " results=" + evaluate("JSON.stringify(window.__results)"));
    }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>(); CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Throwable> unavailable = new AtomicReference<>();
        runOnMainSync(() -> {
            if (web == null || !web.isAttachedToWindow() || activity.isDestroyed()) {
                unavailable.set(new IllegalStateException("WebView window unavailable; recovery="
                    + (activity.getWindow().getDecorView().findViewWithTag("quietpaper-native-recovery") != null)));
                latch.countDown();
                return;
            }
            try { web.evaluateJavascript(script, result -> { value.set(result); latch.countDown(); }); }
            catch (Throwable failure) { unavailable.set(failure); latch.countDown(); }
        });
        if (!latch.await(15, TimeUnit.SECONDS)) throw new EvaluationTimeout();
        if (unavailable.get() != null) throw new IllegalStateException("WebView evaluation unavailable", unavailable.get());
        return value.get();
    }
    private static final class EvaluationTimeout extends Exception { EvaluationTimeout() { super("WebView evaluation timeout"); } }
    private void require(boolean valid, String label) { if (!valid) throw new AssertionError(label); evidence.append("PASS ").append(label).append('\n'); Log.i("GlossaTest", "PASS " + label); }
    private static String sha(String value) throws Exception {
        StringBuilder output = new StringBuilder();
        for (byte item : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) output.append(String.format(Locale.ROOT, "%02x", item & 255));
        return output.toString();
    }
}
