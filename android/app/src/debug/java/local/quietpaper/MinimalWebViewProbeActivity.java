package local.quietpaper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Debug-only, single-navigation renderer probe. No production UI, document I/O,
 * asset interception, CSP changes, or MainActivity bridge is involved.
 */
public final class MinimalWebViewProbeActivity extends Activity {
    public static final String MARKER = "glossa-minimal-webview-probe-v1";
    private static final String TAG = "GlossaWebProbe";
    private static final String BASE_URL = "https://glossa-probe.invalid/";
    private static final String HTML = "<!doctype html><html><head><meta charset='utf-8'>"
        + "<title>Glossa renderer probe</title></head><body><script>"
        + "window.__glossaProbe={marker:'" + MARKER + "',sum:6*7,"
        + "bridgeEcho:GlossaProbe.echo('inline'),href:location.href};"
        + "console.log('Glossa minimal inline script executed');"
        + "GlossaProbe.report(JSON.stringify(window.__glossaProbe));"
        + "</script></body></html>";

    private final StringBuilder events = new StringBuilder();
    private volatile boolean pageFinished;
    private volatile boolean rendererGone;
    private volatile String mainFrameError = "";
    private volatile String javascriptReport = "";
    private volatile int loads;
    private volatile int reports;
    private volatile int echoes;
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        event("create", "pid=" + Process.myPid() + " sdk=" + Build.VERSION.SDK_INT
            + " model=" + Build.MODEL + " savedState=" + (state != null));
        PackageInfo provider = WebView.getCurrentWebViewPackage();
        event("webview-package", provider == null ? "unavailable before construction"
            : provider.packageName + " version=" + provider.versionName + " code="
                + (Build.VERSION.SDK_INT >= 28 ? provider.getLongVersionCode() : provider.versionCode));
        web = new WebView(this);
        if (provider == null) {
            provider = WebView.getCurrentWebViewPackage();
            event("webview-package-after-construction", provider == null ? "unavailable"
                : provider.packageName + " version=" + provider.versionName + " code="
                    + (Build.VERSION.SDK_INT >= 28 ? provider.getLongVersionCode() : provider.versionCode));
        }
        web.setTag("glossa-minimal-webview-probe");
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new ProbeBridge(), "GlossaProbe");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                event("console", message.messageLevel() + " " + message.sourceId() + ":"
                    + message.lineNumber() + " " + message.message());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                event("page-started", url);
            }
            @Override public void onPageFinished(WebView view, String url) {
                pageFinished = true;
                event("page-finished", url);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request,
                    WebResourceError error) {
                String detail = request.getUrl() + " main=" + request.isForMainFrame()
                    + " code=" + error.getErrorCode() + " " + error.getDescription();
                if (request.isForMainFrame()) mainFrameError = detail;
                event("resource-error", detail);
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request,
                    WebResourceResponse response) {
                String detail = request.getUrl() + " main=" + request.isForMainFrame()
                    + " status=" + response.getStatusCode();
                if (request.isForMainFrame()) mainFrameError = detail;
                event("http-error", detail);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                event("blocked-navigation", request.getUrl().toString());
                return true;
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                rendererGone = true;
                event("renderer-gone", "crash=" + detail.didCrash()
                    + " priorityAtExit=" + detail.rendererPriorityAtExit());
                if (web == view) web = null;
                if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                return true;
            }
        });
        setContentView(web);
        loads++;
        event("load", "count=" + loads + " base=" + BASE_URL + " inline-bytes=" + HTML.length());
        // Exactly one document load: no initial app load and no replacement navigation.
        web.loadDataWithBaseURL(BASE_URL, HTML, "text/html", "UTF-8", null);
    }

    public final class ProbeBridge {
        @JavascriptInterface public synchronized String echo(String value) {
            echoes++;
            event("javascript-echo", "count=" + echoes + " value=" + value
                + " thread=" + Thread.currentThread().getName());
            return "echo:" + value;
        }
        @JavascriptInterface public synchronized void report(String payload) {
            reports++;
            javascriptReport = payload == null ? "" : payload;
            event("javascript-report", "count=" + reports + " payload=" + javascriptReport
                + " thread=" + Thread.currentThread().getName());
        }
    }

    public boolean hasPageFinished() { return pageFinished; }
    public boolean hasRendererGone() { return rendererGone; }
    public String getMainFrameError() { return mainFrameError; }
    public String getJavascriptReport() { return javascriptReport; }
    public int getLoadCount() { return loads; }
    public int getReportCount() { return reports; }
    public int getEchoCount() { return echoes; }
    /** UI-thread only: never retain this after renderer-gone or Activity destruction. */
    public WebView getProbeWebView() { return web; }
    public synchronized String diagnostics() { return events.toString(); }
    private synchronized void event(String kind, String detail) {
        String line = SystemClock.uptimeMillis() + " " + kind + " " + detail;
        events.append(line).append('\n');
        Log.i(TAG, line);
    }
    @Override protected void onDestroy() {
        WebView previous = web;
        web = null;
        if (previous != null) {
            previous.removeJavascriptInterface("GlossaProbe");
            if (previous.getParent() instanceof ViewGroup) ((ViewGroup) previous.getParent()).removeView(previous);
            previous.destroy();
        }
        event("destroy", "rendererGone=" + rendererGone);
        super.onDestroy();
    }
}
