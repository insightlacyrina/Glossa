package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * New bridge-direction acceptance on the real packaged homepage. This deliberately
 * does not replay the source engine's conflict, recovery or format test matrix.
 */
public final class NativeAppBridgeScenarios {
    private static final String ORIGIN = "https://appassets.quietpaper.local";
    private static final Uri SOURCE = Uri.parse("content://local.quietpaper.test.source/fixture.md");
    private static final String BEFORE = "\uFEFF---\r\ntitle: 笺注桥接 📝\r\n---\r\n\r\n# 推导\r\n\r\n$x+1$ % 保留中文注释与空白  \r\n";
    private static final String AFTER = BEFORE.replace("$x+1$", "$x+2$");
    private final Instrumentation runner;
    private final ContentResolver resolver;
    private final StringBuilder evidence = new StringBuilder();
    private final String token = UUID.randomUUID().toString();
    private final String stateKey = "__glossaAppBridge_" + token.replace("-", "");
    private MainActivity activity;
    private WebView web;
    private int assertions;
    private String lastWindow = "not observed";

    private NativeAppBridgeScenarios(Instrumentation runner) {
        this.runner = runner;
        resolver = runner.getTargetContext().getContentResolver();
    }

    /** Invoke from the registered runner's app-bridge mode. */
    public static void run(Instrumentation runner) {
        NativeAppBridgeScenarios scenario = new NativeAppBridgeScenarios(runner);
        Bundle result = new Bundle();
        int code = Activity.RESULT_OK;
        String outcome;
        long started = SystemClock.uptimeMillis();
        try {
            scenario.bridge();
            outcome = "PASS real packaged homepage native bridge; assertions=" + scenario.assertions;
        } catch (Throwable failure) {
            code = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            outcome = "FAIL real packaged homepage native bridge\n" + trace;
        }
        if (scenario.activity != null) {
            try { scenario.onMain(() -> { scenario.activity.finish(); return null; }); }
            catch (Throwable cleanup) { scenario.evidence.append("Activity cleanup warning: ").append(cleanup).append('\n'); }
        }
        result.putString("stream", "\n" + outcome + "; pid=" + Process.myPid()
            + "; elapsedMs=" + (SystemClock.uptimeMillis() - started) + "\n" + scenario.evidence
            + "Last native window state: " + scenario.lastWindow + "\n"
            + "Scope: actual packaged homepage, JavaScript interface calls, native DOM callbacks and one real provider write. "
            + "No SAF picker, persistent grant, complete source matrix or interactive editor acceptance is claimed.\n");
        runner.finish(code, result);
    }

    private void bridge() throws Exception {
        // These controls and bytes belong only to the separate instrumentation provider.
        resolver.call(SOURCE, "availability", "true", null);
        resolver.call(SOURCE, "writeFailure", "false", null);
        resolver.call(SOURCE, "queryFailure", "false", null);
        Bundle source = new Bundle(); source.putString("name", "fixture.md");
        source.putByteArray("bytes", BEFORE.getBytes(StandardCharsets.UTF_8));
        resolver.call(SOURCE, "setBytes", null, source);

        activity = (MainActivity) runner.startActivitySync(
            new Intent(runner.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        onMain(() -> {
            web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            evidence.append("WebView provider: ").append(provider == null ? "unavailable" : provider.packageName
                + " version=" + provider.versionName + " code="
                + (Build.VERSION.SDK_INT >= 28 ? provider.getLongVersionCode() : provider.versionCode)).append('\n');
            evidence.append("Android sdk=").append(Build.VERSION.SDK_INT).append(" model=").append(Build.MODEL).append('\n');
            return null;
        });

        long homepageDeadline = SystemClock.uptimeMillis() + 45000;
        JSONObject homepage = null;
        while (SystemClock.uptimeMillis() < homepageDeadline) {
            int progress = windowProgress();
            if (progress == 100) {
                homepage = evaluateJson("(function(){var root=document.getElementById('root');return {"
                    + "ready:document.readyState==='complete'&&!!document.querySelector('#root .app-shell'),"
                    + "href:location.href,title:document.title,"
                    + "scripts:Array.from(document.scripts).map(function(s){return s.src}),"
                    + "rootText:root?(root.textContent||'').slice(0,300):''};})()", homepageDeadline);
                if (homepage.optBoolean("ready")) break;
            }
            Thread.sleep(100);
        }
        if (homepage == null || !homepage.optBoolean("ready"))
            throw new AssertionError("real homepage did not become ready within 45 seconds: " + homepage);
        evidence.append("Homepage: ").append(homepage).append('\n');
        boolean packagedScript = false;
        for (int i = 0; i < homepage.getJSONArray("scripts").length(); i++) {
            String url = homepage.getJSONArray("scripts").getString(i);
            if (url.startsWith(ORIGIN + "/assets/") && url.endsWith(".js")) packagedScript = true;
        }
        require((ORIGIN + "/index.html").equals(homepage.optString("href")) && packagedScript,
            "real packaged homepage and production JavaScript are loaded without replacement navigation");

        JSONObject identity = evaluateJson("({platform:QuietPaperNative.getPlatform(),role:QuietPaperNative.getRole(),"
            + "deviceId:QuietPaperNative.getDeviceId()})", SystemClock.uptimeMillis() + 8000);
        require("android".equals(identity.optString("platform")), "homepage JavaScript synchronously calls native getPlatform");
        require("tablet".equals(identity.optString("role")), "homepage JavaScript receives the native tablet role required for writing");
        require(identity.optString("deviceId").matches("android-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"),
            "homepage JavaScript receives the native installation identity from getDeviceId");
        evidence.append("Identity: ").append(identity).append('\n');

        String readId = "app-bridge-read-" + token, saveId = "app-bridge-save-" + token;
        String key = quote(stateKey), uri = quote(SOURCE.toString());
        evaluateJson("(function(){var state={results:{},counts:{}};window[" + key + "]=state;"
            + "window.addEventListener('quietpaper-native',function(event){var r=event.detail;"
            + "if(r&&(r.requestId===" + quote(readId) + "||r.requestId===" + quote(saveId) + ")){"
            + "state.results[r.requestId]=r;state.counts[r.requestId]=(state.counts[r.requestId]||0)+1;}});"
            + "QuietPaperNative.readDocument(" + quote(readId) + "," + uri + ");return {started:true};})()",
            SystemClock.uptimeMillis() + 8000);
        JSONObject read = awaitReply(readId);
        require(read.optBoolean("ok") && "read".equals(read.optString("type"))
            && readId.equals(read.optString("requestId")) && SOURCE.toString().equals(read.optString("uri")),
            "JavaScript readDocument reaches the real native store and returns through its matching DOM event");
        require(BEFORE.equals(read.optString("text")) && sha(BEFORE).equals(read.optString("sha256")),
            "native read event preserves UTF-8 BOM, CRLF, Chinese, emoji, formula and trailing spaces");

        evaluateJson("(function(){if(!window[" + key + "])throw new Error('original homepage session lost');"
            + "QuietPaperNative.saveDocumentVersioned(" + quote(saveId) + "," + uri + "," + quote(AFTER)
            + "," + quote(read.getString("sha256")) + ",'');return {started:true};})()",
            SystemClock.uptimeMillis() + 8000);
        JSONObject saved = awaitReply(saveId);
        require(saved.optBoolean("ok") && !saved.optBoolean("pending") && "save".equals(saved.optString("type"))
            && saveId.equals(saved.optString("requestId")) && SOURCE.toString().equals(saved.optString("uri"))
            && sha(AFTER).equals(saved.optString("sha256")),
            "JavaScript versioned save returns a confirmed native write through the matching DOM event");
        require(Arrays.equals(AFTER.getBytes(StandardCharsets.UTF_8), readSource()),
            "ContentResolver reopens the actual saved bytes with BOM and CRLF intact");
        JSONObject completion = evaluateJson("(function(){var s=window[" + key + "];"
            + "if(!s)throw new Error('original homepage session lost');return {href:location.href,"
            + "readCount:s.counts[" + quote(readId) + "],saveCount:s.counts[" + quote(saveId) + "]};})()",
            SystemClock.uptimeMillis() + 8000);
        require((ORIGIN + "/index.html").equals(completion.optString("href"))
            && completion.optInt("readCount") == 1 && completion.optInt("saveCount") == 1,
            "both callbacks are observed once in the original real homepage session");
    }

    private JSONObject awaitReply(String id) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        while (SystemClock.uptimeMillis() < deadline) {
            JSONObject result = evaluateJson("(function(){var s=window[" + quote(stateKey) + "];"
                + "if(!s)throw new Error('original homepage session lost');return {reply:s.results["
                + quote(id) + "]||null};})()", deadline);
            if (!result.isNull("reply")) {
                JSONObject reply = result.getJSONObject("reply");
                evidence.append("DOM callback: ").append(reply).append('\n');
                return reply;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("native DOM callback timed out after 15 seconds: " + id);
    }

    private JSONObject evaluateJson(String expression, long deadline) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch callback = new CountDownLatch(1);
        onMain(() -> {
            assertUsableWeb();
            web.evaluateJavascript("JSON.stringify((function(){try{return (" + expression
                + ");}catch(e){return {__scenarioError:String(e&&e.stack||e)};}})())",
                result -> { value.set(result); callback.countDown(); });
            return null;
        });
        long callbackDeadline = Math.min(deadline, SystemClock.uptimeMillis() + 8000);
        while (!callback.await(100, TimeUnit.MILLISECONDS)) {
            windowProgress(); // Renderer recovery or a detached window ends the scenario immediately.
            if (SystemClock.uptimeMillis() >= callbackDeadline)
                throw new AssertionError("evaluateJavascript callback timed out; no retry on a destroyed/replaced WebView");
        }
        windowProgress();
        if (value.get() == null) throw new AssertionError("missing JavaScript evaluation result");
        Object decoded = new JSONTokener(value.get()).nextValue();
        if (!(decoded instanceof String)) throw new AssertionError("unexpected JavaScript result: " + value.get());
        JSONObject result = new JSONObject((String) decoded);
        if (result.has("__scenarioError")) throw new AssertionError(result.getString("__scenarioError"));
        return result;
    }

    private int windowProgress() throws Exception {
        return onMain(() -> {
            assertUsableWeb();
            lastWindow = "url=" + web.getUrl() + " progress=" + web.getProgress()
                + " attached=" + web.isAttachedToWindow();
            return web.getProgress();
        });
    }
    /** UI-thread only. Preserve the production WebViewClient and its renderer recovery. */
    private void assertUsableWeb() {
        if (activity == null || activity.isDestroyed() || activity.isFinishing())
            throw new AssertionError("MainActivity is destroyed or finishing");
        View decor = activity.getWindow().getDecorView();
        if (decor.findViewWithTag("quietpaper-native-recovery") != null)
            throw new AssertionError("production renderer-gone recovery is displayed; stop using the old WebView");
        WebView current = decor.findViewWithTag("quietpaper-web");
        if (web == null || current != web || web.getParent() == null || !web.isAttachedToWindow()
                || !decor.isAttachedToWindow())
            throw new AssertionError("production WebView/window is missing, replaced or detached");
    }

    /** A stalled Android main looper must not turn a finite probe into an endless wait. */
    private <T> T onMain(Callable<T> task) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return task.call();
        AtomicReference<T> value = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicBoolean expired = new AtomicBoolean();
        CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            if (expired.get()) { done.countDown(); return; }
            try { value.set(task.call()); }
            catch (Throwable error) { failure.set(error); }
            finally { done.countDown(); }
        });
        if (!done.await(5, TimeUnit.SECONDS)) {
            expired.set(true);
            throw new AssertionError("Android main looper did not respond within 5 seconds");
        }
        Throwable error = failure.get();
        if (error instanceof Exception) throw (Exception) error;
        if (error instanceof Error) throw (Error) error;
        if (error != null) throw new AssertionError(error);
        return value.get();
    }
    private byte[] readSource() throws Exception {
        try (InputStream input = resolver.openInputStream(SOURCE); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new AssertionError("test provider did not return a source stream");
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
    private void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        assertions++; evidence.append("PASS ").append(message).append('\n');
    }
    private static String quote(String value) {
        return JSONObject.quote(value).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
    private static String sha(String text) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte part : MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))
            result.append(String.format(Locale.ROOT, "%02x", part & 255));
        return result.toString();
    }
}
