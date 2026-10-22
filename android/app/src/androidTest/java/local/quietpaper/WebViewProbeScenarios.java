package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Isolated renderer diagnostic; this does not verify the production app or file bridge. */
public final class WebViewProbeScenarios {
    private final Instrumentation runner;
    private final StringBuilder evidence = new StringBuilder();
    private MinimalWebViewProbeActivity activity;
    private int assertions;
    private WebViewProbeScenarios(Instrumentation runner) { this.runner = runner; }

    /** Route the existing registered instrumentation mode here; no new runner is needed. */
    public static void run(Instrumentation runner) {
        WebViewProbeScenarios scenario = new WebViewProbeScenarios(runner);
        Bundle result = new Bundle();
        int resultCode = Activity.RESULT_OK;
        String outcome;
        try {
            scenario.probe();
            outcome = "PASS isolated minimal WebView probe; assertions=" + scenario.assertions;
        } catch (Throwable failure) {
            resultCode = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            outcome = "FAIL isolated minimal WebView probe\n" + trace;
        }
        String diagnostics = scenario.activity == null ? "Activity was not created\n" : scenario.activity.diagnostics();
        if (scenario.activity != null) runner.runOnMainSync(() -> scenario.activity.finish());
        result.putString("stream", "\n" + outcome + "; pid=" + Process.myPid() + "\n"
            + scenario.evidence + "Native lifecycle diagnostics:\n" + diagnostics
            + "Scope: standalone debug Activity only; no MainActivity, production assets, native file bridge or SAF picker acceptance.\n");
        runner.finish(resultCode, result);
    }

    private void probe() throws Exception {
        activity = (MinimalWebViewProbeActivity) runner.startActivitySync(
            new Intent(runner.getTargetContext(), MinimalWebViewProbeActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        long deadline = SystemClock.uptimeMillis() + 45000;
        while (!activity.hasPageFinished() || activity.getJavascriptReport().isEmpty()) {
            requireRendererAlive();
            if (!activity.getMainFrameError().isEmpty()) throw new AssertionError(activity.getMainFrameError());
            if (SystemClock.uptimeMillis() >= deadline)
                throw new AssertionError("single-navigation page/report timeout; no JavaScript polling was performed");
            Thread.sleep(100);
        }
        requireRendererAlive();
        require(activity.getLoadCount() == 1, "one minimal document load with no replacement navigation");
        require(activity.hasPageFinished(), "native onPageFinished callback received");
        JSONObject report = new JSONObject(activity.getJavascriptReport());
        require(MinimalWebViewProbeActivity.MARKER.equals(report.optString("marker"))
            && report.optInt("sum") == 42, "inline JavaScript executes and reports through @JavascriptInterface");
        require("echo:inline".equals(report.optString("bridgeEcho")) && activity.getReportCount() == 1,
            "inline JavaScript receives the native interface return value and reports exactly once");

        AtomicReference<String> evaluated = new AtomicReference<>();
        CountDownLatch callback = new CountDownLatch(1);
        runner.runOnMainSync(() -> {
            WebView web = activity.getProbeWebView();
            if (web == null || web.getParent() == null) throw new AssertionError("probe WebView is detached");
            web.evaluateJavascript("GlossaProbe.echo('evaluation')+'|'+window.__glossaProbe.marker+'|'+(6*7)",
                value -> { evaluated.set(value); callback.countDown(); });
        });
        long evaluateDeadline = SystemClock.uptimeMillis() + 15000;
        while (!callback.await(100, TimeUnit.MILLISECONDS)) {
            requireRendererAlive();
            if (SystemClock.uptimeMillis() >= evaluateDeadline)
                throw new AssertionError("single evaluateJavascript callback timeout");
        }
        requireRendererAlive();
        Object decoded = new JSONTokener(evaluated.get()).nextValue();
        require(("echo:evaluation|" + MinimalWebViewProbeActivity.MARKER + "|42").equals(decoded),
            "evaluateJavascript returns the script result through its native callback");
        require(activity.getEchoCount() == 2 && activity.getLoadCount() == 1,
            "evaluation calls the real @JavascriptInterface without another document load");
        evidence.append("evaluationCallback=").append(evaluated.get()).append('\n');
    }
    private void requireRendererAlive() {
        if (activity.hasRendererGone()) throw new AssertionError("renderer-gone; stop using the destroyed WebView immediately");
        if (activity.isDestroyed() || activity.isFinishing()) throw new AssertionError("probe Activity no longer active");
    }
    private void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        assertions++;
        evidence.append("PASS ").append(message).append('\n');
    }
}
