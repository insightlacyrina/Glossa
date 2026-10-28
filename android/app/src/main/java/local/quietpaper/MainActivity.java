package local.quietpaper;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.RenderProcessGoneDetail;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import android.view.View;
import android.view.ViewGroup;
import android.view.Gravity;
import android.view.WindowInsets;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A local asset host and Storage Access Framework adapter. No note data leaves this
 * process except through the configured web sync client or an explicit document write. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.quietpaper.local";
    private static final int OPEN_SOURCE = 41, EXPORT_SOURCE = 42, OPEN_WEB_FILE = 43;
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    // Serialize durable source/export operations across Activity recreation.
    // Destroying a view must not start a competing file-journal executor.
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView web;
    private NativeSourceStore sources;
    private NativeRuntimeDiagnostics runtimeDiagnostics;
    private NativeRecognition recognition;
    private String role, deviceId, openRequest, exportRequest, exportText, exportSession;
    private ValueCallback<Uri[]> fileCallback;
    private android.window.OnBackInvokedCallback systemBackCallback;
    private final Handler backHandler = new Handler(Looper.getMainLooper());
    private Runnable backTimeout;
    private boolean backPending;
    private int backRequest;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        sources = new NativeSourceStore(this);
        runtimeDiagnostics = new NativeRuntimeDiagnostics(this);
        recognition = new NativeRecognition();
        SharedPreferences prefs = getSharedPreferences("device", MODE_PRIVATE);
        deviceId = prefs.getString("id", null);
        if (deviceId == null) {
            deviceId = "android-" + UUID.randomUUID();
            prefs.edit().putString("id", deviceId).apply();
        }
        // Physical display dimensions avoid granting tablet permissions to a phone
        // merely because its browser viewport has been widened.
        DisplayMetrics display = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(display);
        role = Math.min(display.widthPixels, display.heightPixels) / display.density >= 600 ? "tablet" : "phone";
        web = new WebView(this);
        web.setTag("quietpaper-web");
        web.setBackgroundColor(0xffeeebe5);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        web.addJavascriptInterface(new NativeBridge(), "QuietPaperNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"appassets.quietpaper.local".equals(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                if (path.contains("..") || !"https".equals(uri.getScheme())) return missing();
                try {
                    InputStream stream = getAssets().open("web" + path);
                    return new WebResourceResponse(mime(path), "UTF-8", 200, "OK",
                        Collections.singletonMap("Cache-Control", "no-cache"), stream);
                } catch (Exception e) { return missing(); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith(ORIGIN + "/");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = detail.didCrash();
                int priority = detail.rendererPriorityAtExit();
                io.execute(() -> {
                    JSONObject recorded = runtimeDiagnostics.recordRendererExit(crashed, priority);
                    if (!recorded.optBoolean("ok")) Log.w("GlossaNative", "Renderer diagnostic could not be committed: " + recorded.optString("error"));
                });
                boolean current = web == view;
                if (current) web = null;
                if (current) cancelFileChooser();
                if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                Log.w("GlossaNative", "WebView renderer stopped; crash=" + detail.didCrash() + "; local stores retained; waiting for user reopen");
                if (current && !isFinishing() && !isDestroyed()) showRendererRecovery();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, OPEN_WEB_FILE);
                return true;
            }
        });
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xffeeebe5);
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                frame.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                frame.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        setContentView(frame);
        web.loadUrl(ORIGIN + "/index.html");
        if (Build.VERSION.SDK_INT >= 33) {
            systemBackCallback = this::navigateBack;
            // Default priority leaves the IME's own Back handling ahead of app navigation.
            // A separate system DocumentsUI Activity likewise owns its own Back events.
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, systemBackCallback);
        }
    }

    @Override public void onBackPressed() {
        // Pre-33 dispatch reaches Activity only after the IME has handled Back.
        navigateBack();
    }

    private void navigateBack() {
        if (isFinishing() || isDestroyed() || !hasWindowFocus() || backPending) return;
        WebView target = web;
        if (!canUseWeb()) { leaveActivity(); return; }
        int request = ++backRequest;
        backPending = true;
        backTimeout = () -> {
            if (request != backRequest) return;
            // A slow or stopped renderer is not permission to close a writing window.
            invalidateBackRequest();
            Log.w("GlossaNative", "Back navigation callback timed out; window retained");
        };
        backHandler.postDelayed(backTimeout, 1500);
        try {
            target.evaluateJavascript("(function(){try{"
                + "if(typeof window.glossaNavigateBack!=='function')return false;"
                + "return window.glossaNavigateBack()===true;"
                + "}catch(error){console.error('Glossa back navigation failed',error);return null;}})()", result -> {
                if (request != backRequest) return;
                invalidateBackRequest();
                if (target != web || !canUseWeb() || !hasWindowFocus()) return;
                if ("false".equals(result)) leaveActivity();
                else if (!"true".equals(result))
                    Log.w("GlossaNative", "Back navigation failed; window retained");
            });
        } catch (IllegalStateException unavailableView) {
            invalidateBackRequest();
            Log.w("GlossaNative", "Back navigation unavailable; window retained");
        }
    }

    private void invalidateBackRequest() {
        ++backRequest; backPending = false;
        if (backTimeout != null) backHandler.removeCallbacks(backTimeout);
        backTimeout = null;
    }

    @SuppressWarnings("deprecation")
    private void leaveActivity() {
        // Preserve platform root-task behavior; asset pages have no WebView back stack.
        super.onBackPressed();
    }

    private void showRendererRecovery() {
        LinearLayout recovery = new LinearLayout(this);
        recovery.setTag("quietpaper-native-recovery");
        recovery.setOrientation(LinearLayout.VERTICAL);
        recovery.setGravity(Gravity.CENTER);
        recovery.setBackgroundColor(0xffeeebe5);
        int gap = Math.round(24 * getResources().getDisplayMetrics().density);
        recovery.setPadding(gap, gap, gap, gap);
        TextView title = new TextView(this);
        title.setText("书写窗口已中断"); title.setTextSize(24); title.setTextColor(0xff4d414b);
        title.setTypeface(android.graphics.Typeface.create("serif", android.graphics.Typeface.NORMAL));
        recovery.addView(title);
        Button reopen = new Button(this);
        reopen.setTag("quietpaper-reopen"); reopen.setText("重新打开"); reopen.setTextSize(16); reopen.setAllCaps(false);
        LinearLayout.LayoutParams placement = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        placement.topMargin = gap; recovery.addView(reopen, placement);
        reopen.setOnClickListener(view -> { reopen.setEnabled(false); recreate(); });
        setContentView(recovery);
    }
    private boolean canUseWeb() { return web != null && !isFinishing() && !isDestroyed() && web.getParent() != null; }
    private void cancelFileChooser() {
        ValueCallback<Uri[]> previous = fileCallback; fileCallback = null;
        if (previous != null) {
            try { previous.onReceiveValue(null); }
            catch (RuntimeException unavailableView) { Log.w("GlossaNative", "Discarded file chooser callback for unavailable WebView"); }
        }
    }

    private WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    public final class NativeBridge {
        @JavascriptInterface public String getRole() { return role; }
        @JavascriptInterface public String getDeviceId() { return deviceId; }
        @JavascriptInterface public String getPlatform() { return "android"; }
        @JavascriptInterface public void getRecognitionStatus(String requestId, String language) {
            recognition.status(language, result -> recognitionResult(requestId, "recognition-status", result));
        }
        @JavascriptInterface public void downloadRecognitionModel(String requestId, String language) {
            recognition.downloadModel(language, result -> recognitionResult(requestId, "recognition-model", result));
        }
        @JavascriptInterface public void recognizeInk(String requestId, String json) {
            recognition.recognizeInk(json, result -> recognitionResult(requestId, "recognition-ink", result));
        }
        @JavascriptInterface public void recognizeImage(String requestId, String json) {
            recognition.recognizeImage(json, result -> recognitionResult(requestId, "recognition-image", result));
        }
        @JavascriptInterface public void getRuntimeDiagnostics(String requestId) {
            io.execute(() -> {
                JSONObject result = runtimeDiagnostics.read();
                try {
                    result.put("requestId", requestId).put("type", "runtime-diagnostics");
                    if (result.has("entries")) result.put("runtime", result.remove("entries"));
                    emit(result);
                } catch (Exception failed) { failure(requestId, "runtime-diagnostics", "runtime-diagnostics-read-failed"); }
            });
        }
        @JavascriptInterface public void openDocument(String requestId) {
            runOnUiThread(() -> {
                if (!canUseWeb()) return;
                if (!"tablet".equals(role)) { failure(requestId, "open", "tablet-required"); return; }
                if (openRequest != null) { failure(requestId, "open", "document-picker-busy"); return; }
                openRequest = requestId;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(intent, OPEN_SOURCE);
            });
        }
        @JavascriptInterface public void exportDocument(String requestId, String name, String mime, String text) {
            runOnUiThread(() -> {
                if (!canUseWeb()) return;
                if (exportRequest != null) { failure(requestId, "export", "document-picker-busy"); return; }
                if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) { failure(requestId, "export", "document-too-large"); return; }
                exportRequest = requestId; exportText = text;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime)
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(intent, EXPORT_SOURCE);
            });
        }
        @JavascriptInterface public void beginExport(String requestId, String name, String mime) {
            io.execute(() -> {
                try {
                    ExportStore.Session session = exportStore().begin(name, mime);
                    emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export-begin").put("sessionId", session.id));
                } catch (Exception e) { failure(requestId, "export-begin", e.getClass().getSimpleName()); }
            });
        }
        @JavascriptInterface public void appendExportChunk(String requestId, String sessionId, String sequence, String encoded) {
            io.execute(() -> {
                try {
                    if (encoded.length() > 360000) throw new IllegalArgumentException("export-chunk-too-large");
                    ExportStore.Session session = exportStore().append(sessionId, Integer.parseInt(sequence), Base64.decode(encoded, Base64.NO_WRAP));
                    emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export-chunk")
                        .put("sessionId", session.id).put("bytes", session.bytes).put("sequence", session.sequence));
                } catch (Exception e) { failure(requestId, "export-chunk", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()); }
            });
        }
        @JavascriptInterface public void completeExport(String requestId, String sessionId) {
            io.execute(() -> {
                try {
                    ExportStore.Session session = exportStore().complete(sessionId);
                    runOnUiThread(() -> {
                        if (!canUseWeb()) return; // Durable staging remains available after user reopen.
                        if (exportRequest != null) { failure(requestId, "export", "document-picker-busy"); return; }
                        exportRequest = requestId; exportSession = session.id; exportText = null;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(session.mime)
                            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, session.name);
                        startActivityForResult(intent, EXPORT_SOURCE);
                    });
                } catch (Exception e) { failure(requestId, "export", e.getClass().getSimpleName()); }
            });
        }
        @JavascriptInterface public void getPendingExports(String requestId) {
            io.execute(() -> {
                try {
                    JSONArray sessions = new JSONArray();
                    for (ExportStore.Session session : exportStore().pending()) {
                        sessions.put(new JSONObject().put("sessionId", session.id).put("name", session.name).put("mime", session.mime)
                            .put("bytes", session.bytes).put("sequence", session.sequence).put("complete", session.complete));
                    }
                    emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export-pending").put("sessions", sessions));
                } catch (Exception e) { failure(requestId, "export-pending", e.getClass().getSimpleName()); }
            });
        }
        @JavascriptInterface public void discardExport(String requestId, String sessionId) {
            io.execute(() -> {
                try {
                    exportStore().discard(sessionId);
                    emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export-discard"));
                } catch (Exception e) { failure(requestId, "export-discard", e.getClass().getSimpleName()); }
            });
        }
        @JavascriptInterface public void saveDocument(String requestId, String uri, String text, String expectedSha256) {
            if (!"tablet".equals(role)) { failure(requestId, "save", "tablet-required"); return; }
            io.execute(() -> emit(sources.saveDocument(requestId, uri, text, expectedSha256)));
        }
        @JavascriptInterface public void saveDocumentVersioned(String requestId, String uri, String text, String expectedSourceSha256, String expectedPendingSha256) {
            if (!"tablet".equals(role)) { failure(requestId, "save", "tablet-required"); return; }
            io.execute(() -> emit(sources.saveDocumentVersioned(requestId, uri, text, expectedSourceSha256, expectedPendingSha256)));
        }
        @JavascriptInterface public void getPendingSource(String requestId, String uri) {
            io.execute(() -> emit(sources.getPendingSource(requestId, uri)));
        }
        @JavascriptInterface public void readDocument(String requestId, String uri) {
            io.execute(() -> emit(sources.readDocument(requestId, uri)));
        }
        @JavascriptInterface public void retryPendingWrite(String requestId, String uri) {
            if (!"tablet".equals(role)) { failure(requestId, "save", "tablet-required"); return; }
            io.execute(() -> emit(sources.retryPendingWrite(requestId, uri)));
        }
        /** Legacy single-SHA conflict decisions cannot bind the pending version shown to the user. */
        @JavascriptInterface public void resolveSourceConflict(String requestId, String uri, String resolvedText, String sourceSha256) {
            if (!"tablet".equals(role)) { failure(requestId, "save", "tablet-required"); return; }
            io.execute(() -> emit(sources.resolveSourceConflict(requestId, uri, resolvedText, sourceSha256)));
        }
        @JavascriptInterface public void getPendingWrites(String requestId) {
            io.execute(() -> emit(sources.getPendingWrites(requestId)));
        }
        @JavascriptInterface public void getSourceSnapshot(String requestId, String uri) {
            io.execute(() -> emit(sources.getSourceSnapshot(requestId, uri)));
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        Uri uri = data == null ? null : data.getData();
        if (request == OPEN_WEB_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(result == RESULT_OK && uri != null ? new Uri[] {uri} : null);
            fileCallback = null; return;
        }
        if (request == OPEN_SOURCE) {
            final String requestId = openRequest; openRequest = null;
            if (result != RESULT_OK || uri == null) { failure(requestId, "open", "cancelled"); return; }
            final int permissions = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            try { getContentResolver().takePersistableUriPermission(uri, permissions); }
            catch (SecurityException ignored) { /* Some providers offer temporary grants only; surfaced below. */ }
            io.execute(() -> {
                boolean retained = false;
                try {
                    for (android.content.UriPermission grant : getContentResolver().getPersistedUriPermissions()) {
                        if (grant.getUri().equals(uri) && grant.isReadPermission() && grant.isWritePermission()) retained = true;
                    }
                } catch (SecurityException unavailableGrantList) {
                    // A temporary grant can still permit the read; report its actual retained state.
                }
                emit(sources.openDocument(requestId, uri.toString(), retained));
            });
        } else if (request == EXPORT_SOURCE) {
            final String requestId = exportRequest, text = exportText, sessionId = exportSession;
            exportRequest = null; exportText = null; exportSession = null;
            if (result != RESULT_OK || uri == null) { failure(requestId, "export", "cancelled"); return; }
            io.execute(() -> {
                try {
                    if (sessionId != null) {
                        ExportStore.Session session = exportStore().read(sessionId);
                        try (InputStream input = new FileInputStream(session.file); OutputStream output = getContentResolver().openOutputStream(uri, "rwt")) {
                            if (output == null) throw new IllegalStateException("export-unavailable");
                            byte[] buffer = new byte[64 * 1024]; int count;
                            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                            output.flush();
                        }
                        String written = ExportStore.digest(getContentResolver().openInputStream(uri));
                        if (!written.equals(session.sha256)) throw new IllegalStateException("export-verification-failed");
                        exportStore().discard(sessionId);
                        emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export").put("uri", uri.toString())
                            .put("bytes", session.bytes).put("sha256", written));
                    } else {
                        writeSource(uri, text);
                        emit(new JSONObject().put("requestId", requestId).put("ok", true).put("type", "export").put("uri", uri.toString()));
                    }
                } catch (Exception e) { failure(requestId, "export", e.getClass().getSimpleName()); }
            });
        }
    }

    private void writeSource(Uri uri, String text) throws Exception {
        try (OutputStream output = getContentResolver().openOutputStream(uri, "rwt")) {
            if (output == null) throw new IllegalStateException("source-unavailable");
            output.write(text.getBytes(StandardCharsets.UTF_8)); output.flush();
        }
    }
    private ExportStore exportStore() { return new ExportStore(new File(getFilesDir(), "export-staging")); }
    private void failure(String request, String type, String error) {
        try { emit(new JSONObject().put("requestId", request).put("type", type).put("ok", false).put("error", error)); }
        catch (Exception ignored) { }
    }
    private void recognitionResult(String request, String type, JSONObject result) {
        try { emit(result.put("requestId", request).put("type", type)); }
        catch (Exception failed) { failure(request, type, "recognition-failed"); }
    }
    private void emit(JSONObject detail) {
        String json = detail.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        runOnUiThread(() -> {
            WebView target = web;
            if (target == null || isFinishing() || isDestroyed() || target.getParent() == null) return;
            try { target.evaluateJavascript("window.dispatchEvent(new CustomEvent('quietpaper-native',{detail:" + json + "}))", null); }
            catch (IllegalStateException destroyedView) { Log.w("GlossaNative", "Discarded callback for unavailable WebView"); }
        });
    }

    @Override protected void onPause() { invalidateBackRequest(); super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        invalidateBackRequest();
        if (Build.VERSION.SDK_INT >= 33 && systemBackCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBackCallback);
            systemBackCallback = null;
        }
        cancelFileChooser();
        if (recognition != null) recognition.close();
        WebView previous = web; web = null;
        if (previous != null) { previous.removeJavascriptInterface("QuietPaperNative"); previous.destroy(); }
        super.onDestroy();
    }
}
