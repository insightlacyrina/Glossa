package local.quietpaper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.system.Os;
import android.system.OsConstants;
import android.view.KeyEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import java.io.PrintWriter;
import java.io.StringWriter;

/** Real system SAF selection and retained-grant acceptance; no injected Activity result or URI. */
public final class SafPickerScenarios {
    private static final String ORIGIN = "https://appassets.quietpaper.local";
    private final Instrumentation runner;
    private final Context context;
    private final ContentResolver resolver;
    private final StringBuilder evidence = new StringBuilder();
    private MainActivity activity;
    private WebView web;
    private UiAutomation automation;
    private String token, filename, before, written, stateKey;
    private Uri createdMediaUri;
    private int assertions;
    private String lastWindow = "not observed";

    private SafPickerScenarios(Instrumentation runner) {
        this.runner = runner; context = runner.getTargetContext(); resolver = context.getContentResolver();
    }
    public static void run(Instrumentation runner, String phase) {
        SafPickerScenarios scenario = new SafPickerScenarios(runner);
        Bundle output = new Bundle(); int code = Activity.RESULT_OK; String outcome;
        try {
            if ("prepare".equals(phase)) scenario.prepare();
            else if ("resume".equals(phase)) scenario.resume();
            else throw new IllegalArgumentException("Unknown SAF phase: " + phase);
            outcome = "PASS system SAF " + phase + "; assertions=" + scenario.assertions;
        } catch (Throwable failure) {
            code = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            outcome = "FAIL system SAF " + phase + "\n" + trace;
            scenario.saveFailure(phase, trace.toString());
        }
        if (scenario.activity != null) {
            try { scenario.onMain(() -> { scenario.activity.finish(); return null; }); }
            catch (Throwable cleanup) { scenario.evidence.append("Activity cleanup warning: ").append(cleanup).append('\n'); }
        }
        output.putString("stream", "\n" + outcome + "; pid=" + Process.myPid() + "\n" + scenario.evidence
            + "Last native window: " + scenario.lastWindow + "\n"
            + "Scope: system DocumentsUI selection of one owned Downloads fixture and its persisted read/write grant. "
            + "The owner UID may also have MediaStore access; persisted-grant flags are checked independently. "
            + "No cloud provider, rename/move compatibility, general format coverage or power-loss proof is claimed.\n");
        runner.finish(code, output);
    }

    private void prepare() throws Exception {
        if (proofFile().exists() && "prepared".equals(new JSONObject(readFile(proofFile())).optString("phase")))
            throw new AssertionError("Resume the previous prepared SAF proof before creating another fixture");
        if (Build.VERSION.SDK_INT < 29) throw new AssertionError("This owned Downloads fixture requires API29+ MediaStore scoped storage");
        token = UUID.randomUUID().toString(); filename = "Glossa-SAF-" + token + ".md";
        before = "\uFEFF# Glossa SAF acceptance\r\n<!-- Glossa-SAF-Test:" + token + " -->\r\n"
            + "真实选择器与持久授权 📝\r\n$x+1$ % 保留中文注释和空白  \r\n";
        written = before.replace("$x+1$", "$x+2$");
        stateKey = "__glossaSaf_" + token.replace("-", "");
        createDownloadsFixture();
        evidence.append("Owned fixture: /sdcard/Download/").append(filename).append(" mediaUri=").append(createdMediaUri).append('\n');
        launchHomepage();
        automation = runner.getUiAutomation();
        AccessibilityServiceInfo info = automation.getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
        }
        String openId = "saf-open-" + token, saveId = "saf-save-" + token;
        String key = quote(stateKey);
        evaluateJson("(function(){var s={results:{}};window[" + key + "]=s;"
            + "window.addEventListener('quietpaper-native',function(e){var r=e.detail;"
            + "if(r&&(r.requestId===" + quote(openId) + "||r.requestId===" + quote(saveId) + "))s.results[r.requestId]=r;});"
            + "QuietPaperNative.openDocument(" + quote(openId) + ");return {started:true};})()",
            SystemClock.uptimeMillis() + 10000);
        selectSystemFile();
        JSONObject opened = awaitReply(openId);
        require(opened.optBoolean("ok") && "open".equals(opened.optString("type")),
            "real system picker returns through production onActivityResult and the JavaScript DOM event");
        Uri document = Uri.parse(opened.getString("uri"));
        require(isSystemDocument(document) && !document.equals(createdMediaUri),
            "selected source is a real system DocumentsProvider document URI");
        // Refuse all writes unless the selected document is exactly this freshly owned fixture.
        require(filename.equals(opened.optString("name")) && before.equals(opened.optString("text"))
            && sha(before).equals(opened.optString("sha256")) && filename.equals(displayName(document)),
            "selected document name, random test marker, entire text and SHA identify the owned fixture");
        require(opened.optBoolean("persistentPermission") && hasReadWriteGrant(document),
            "actual picker grants persistent read and write permission to its document URI");
        evaluateJson("(function(){if(!window[" + key + "])throw new Error('SAF homepage session lost');"
            + "QuietPaperNative.saveDocumentVersioned(" + quote(saveId) + "," + quote(document.toString()) + ","
            + quote(written) + "," + quote(sha(before)) + ",'');return {started:true};})()",
            SystemClock.uptimeMillis() + 10000);
        JSONObject saved = awaitReply(saveId);
        require(saved.optBoolean("ok") && !saved.optBoolean("pending") && sha(written).equals(saved.optString("sha256")),
            "homepage JavaScript writes one formula character through the selected SAF document");
        require(Arrays.equals(written.getBytes(StandardCharsets.UTF_8), readBytes(document))
            && Arrays.equals(written.getBytes(StandardCharsets.UTF_8), readBytes(createdMediaUri)),
            "document and owned Downloads source both reopen exact written UTF-8 BOM/CRLF bytes");
        JSONObject proof = new JSONObject().put("phase", "prepared").put("pid", Process.myPid())
            .put("token", token).put("filename", filename).put("uri", document.toString())
            .put("mediaUri", createdMediaUri.toString()).put("before", before).put("written", written)
            .put("sha256", sha(written)).put("preparedAt", System.currentTimeMillis());
        durable(proofFile(), proof.toString());
        require(proofFile().isFile(), "SAF restart proof is fsynced after the real grant and write complete");
        evidence.append("READY force-stop local.quietpaper before saf-resume; document=").append(document).append('\n');
    }

    private void resume() throws Exception {
        JSONObject proof = new JSONObject(readFile(proofFile()));
        require("prepared".equals(proof.optString("phase")), "completed SAF prepare proof exists");
        require(proof.getInt("pid") != Process.myPid(), "SAF resume runs in a different Android process: "
            + proof.getInt("pid") + " -> " + Process.myPid());
        token = proof.getString("token"); UUID.fromString(token);
        filename = "Glossa-SAF-" + token + ".md"; before = proof.getString("before"); written = proof.getString("written");
        Uri document = Uri.parse(proof.getString("uri"));
        require(filename.equals(proof.getString("filename")) && before.contains("<!-- Glossa-SAF-Test:" + token + " -->")
            && written.equals(before.replace("$x+1$", "$x+2$")) && sha(written).equals(proof.getString("sha256"))
            && isSystemDocument(document) && filename.equals(displayName(document)),
            "durable proof and actual document still identify only the marked test fixture");
        require(hasReadWriteGrant(document), "actual persisted read/write document grant survives process replacement");
        require(Arrays.equals(written.getBytes(StandardCharsets.UTF_8), readBytes(document)),
            "new process reopens the exact previously written document without opening a picker or WebView");
        NativeSourceStore store = new NativeSourceStore(context);
        JSONObject reopened = store.readDocument("saf-resume-read-" + token, document.toString());
        require(reopened.optBoolean("ok") && written.equals(reopened.optString("text"))
            && sha(written).equals(reopened.optString("sha256")),
            "production NativeSourceStore reads the retained SAF URI in the new process");
        String next = written.replace("$x+2$", "$x+3$");
        JSONObject saved = store.saveDocumentVersioned("saf-resume-save-" + token, document.toString(), next, sha(written), "");
        require(saved.optBoolean("ok") && !saved.optBoolean("pending") && sha(next).equals(saved.optString("sha256")),
            "production native store writes one further character using the retained grant");
        require(Arrays.equals(next.getBytes(StandardCharsets.UTF_8), readBytes(document)),
            "new-process SAF write reopens with all other original bytes preserved");
        proof.put("phase", "resumed").put("resumePid", Process.myPid()).put("finalText", next).put("finalSha256", sha(next));
        durable(proofFile(), proof.toString());
        evidence.append("Retained document: ").append(document).append("; no Activity or WebView created in resume\n");
    }

    private void createDownloadsFixture() throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "text/markdown");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        createdMediaUri = resolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (createdMediaUri == null) throw new AssertionError("MediaStore did not create the owned Downloads test file");
        try (ParcelFileDescriptor file = resolver.openFileDescriptor(createdMediaUri, "w")) {
            if (file == null) throw new AssertionError("Owned Downloads fixture is not writable");
            try (ParcelFileDescriptor.AutoCloseOutputStream stream = new ParcelFileDescriptor.AutoCloseOutputStream(file)) {
                stream.write(before.getBytes(StandardCharsets.UTF_8)); stream.flush(); file.getFileDescriptor().sync();
            }
        }
        values.clear(); values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        if (resolver.update(createdMediaUri, values, null, null) != 1)
            throw new AssertionError("Owned Downloads fixture was not published for the system picker");
    }

    private void launchHomepage() throws Exception {
        activity = (MainActivity) runner.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        onMain(() -> {
            web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            evidence.append("WebView provider: ").append(provider == null ? "unavailable" : provider.packageName + " " + provider.versionName).append('\n');
            return null;
        });
        long deadline = SystemClock.uptimeMillis() + 45000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (windowProgress() == 100) {
                JSONObject page = evaluateJson("({ready:document.readyState==='complete'&&!!document.querySelector('#root .app-shell'),href:location.href})", deadline);
                if (page.optBoolean("ready") && (ORIGIN + "/index.html").equals(page.optString("href"))) return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Real homepage did not become ready for the SAF request within 45 seconds");
    }

    private void selectSystemFile() throws Exception {
        long started = SystemClock.uptimeMillis(), deadline = started + 45000;
        boolean pickerSeen = false, drawerOpened = false, downloadsChosen = false, fileClicked = false, searchOpened = false, searched = false;
        long downloadsAt = started;
        while (SystemClock.uptimeMillis() < deadline) {
            windowProgress();
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root == null) { Thread.sleep(150); continue; }
            try {
                String packageName = String.valueOf(root.getPackageName());
                if (!isPickerPackage(packageName)) {
                    if (fileClicked && "local.quietpaper".equals(packageName)) {
                        evidence.append("System picker returned to application after file selection\n"); return;
                    }
                    Thread.sleep(150); continue;
                }
                if (!pickerSeen) {
                    pickerSeen = true; evidence.append("System picker observed: ").append(packageName).append('\n');
                    evidence.append("Initial picker nodes:\n").append(dump(root));
                }
                if (!fileClicked && click(root, n -> !n.isEditable() && exact(n, filename), "unique Downloads test file")) {
                    fileClicked = true; Thread.sleep(200); continue;
                }
                if (fileClicked) {
                    click(root, n -> any(n, "Open", "打开", "Select", "选择"), "system picker confirm");
                    Thread.sleep(150); continue;
                }
                if (!downloadsChosen) {
                    AccessibilityNodeInfo roots = find(root, n -> idEnds(n, ":id/roots_list"));
                    try {
                        if (roots != null && click(roots, n -> any(n, "Downloads", "Download", "下载"), "Downloads root")) {
                            downloadsChosen = true; downloadsAt = SystemClock.uptimeMillis(); continue;
                        }
                    } finally { if (roots != null) roots.recycle(); }
                    if (drawerOpened && click(root, n -> any(n, "Downloads", "Download", "下载"), "Downloads root")) {
                        downloadsChosen = true; downloadsAt = SystemClock.uptimeMillis(); continue;
                    }
                    if (!drawerOpened && SystemClock.uptimeMillis() - started > 1200
                            && click(root, n -> any(n, "Show roots", "Open navigation drawer", "显示根目录", "打开导航抽屉"), "Show roots")) {
                        drawerOpened = true; continue;
                    }
                    if (!drawerOpened && SystemClock.uptimeMillis() - started > 3000
                            && click(root, n -> any(n, "Downloads", "Download", "下载"), "visible Downloads root")) {
                        downloadsChosen = true; downloadsAt = SystemClock.uptimeMillis(); continue;
                    }
                }
                if (downloadsChosen && !searchOpened && SystemClock.uptimeMillis() - downloadsAt > 4000) {
                    searchOpened = click(root, n -> idEnds(n, ":id/option_menu_search") || any(n, "Search", "搜索"), "search owned filename");
                } else if (searchOpened && !searched) {
                    AccessibilityNodeInfo input = find(root, n -> n.isEditable());
                    if (input != null) {
                        try {
                            Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, filename);
                            if (input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) { pressEnter(); searched = true; }
                        } finally { input.recycle(); }
                    }
                }
            } finally { root.recycle(); }
            Thread.sleep(150);
        }
        throw new AssertionError("System SAF selection timed out: pickerSeen=" + pickerSeen + " fileClicked=" + fileClicked
            + " downloadsChosen=" + downloadsChosen + " searched=" + searched);
    }

    private boolean click(AccessibilityNodeInfo root, Predicate<AccessibilityNodeInfo> match, String label) {
        AccessibilityNodeInfo node = find(root, match);
        if (node == null) return false;
        try {
            for (int parents = 0; parents < 7; parents++) {
                if (node.isEnabled() && node.isClickable() && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    evidence.append("Accessibility click: ").append(label).append('\n'); return true;
                }
                AccessibilityNodeInfo parent = node.getParent();
                if (parent == null) break;
                node.recycle(); node = parent;
            }
        } finally { node.recycle(); }
        return false;
    }
    private AccessibilityNodeInfo find(AccessibilityNodeInfo root, Predicate<AccessibilityNodeInfo> match) {
        return find(root, match, 0, new int[] {0});
    }
    private AccessibilityNodeInfo find(AccessibilityNodeInfo node, Predicate<AccessibilityNodeInfo> match, int depth, int[] count) {
        if (node == null || depth > 20 || count[0]++ > 350) return null;
        if (node.isVisibleToUser() && match.test(node)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { AccessibilityNodeInfo found = find(child, match, depth + 1, count); if (found != null) return found; }
            finally { child.recycle(); }
        }
        return null;
    }
    private static boolean exact(AccessibilityNodeInfo node, String text) {
        return text.contentEquals(node.getText() == null ? "" : node.getText())
            || text.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription());
    }
    private static boolean any(AccessibilityNodeInfo node, String... labels) {
        for (String label : labels) if (exact(node, label)) return true;
        return false;
    }
    private static boolean idEnds(AccessibilityNodeInfo node, String suffix) {
        return node.getViewIdResourceName() != null && node.getViewIdResourceName().endsWith(suffix);
    }
    private static boolean isPickerPackage(String packageName) {
        return "com.android.documentsui".equals(packageName) || "com.google.android.documentsui".equals(packageName);
    }
    private void pressEnter() {
        long now = SystemClock.uptimeMillis();
        automation.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0), true);
        automation.injectInputEvent(new KeyEvent(now, now + 1, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0), true);
    }

    private JSONObject awaitReply(String id) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 20000;
        while (SystemClock.uptimeMillis() < deadline) {
            JSONObject result = evaluateJson("(function(){var s=window[" + quote(stateKey) + "];"
                + "if(!s)throw new Error('SAF homepage session lost');return {reply:s.results[" + quote(id) + "]||null};})()", deadline);
            if (!result.isNull("reply")) {
                JSONObject reply = result.getJSONObject("reply");
                evidence.append("DOM reply requestId=").append(reply.optString("requestId")).append(" type=")
                    .append(reply.optString("type")).append(" ok=").append(reply.optBoolean("ok"))
                    .append(" error=").append(reply.optString("error")).append('\n');
                return reply;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("SAF DOM reply timed out: " + id);
    }
    private JSONObject evaluateJson(String expression, long deadline) throws Exception {
        AtomicReference<String> value = new AtomicReference<>(); CountDownLatch callback = new CountDownLatch(1);
        onMain(() -> {
            assertUsableWeb();
            web.evaluateJavascript("JSON.stringify((function(){try{return (" + expression
                + ");}catch(e){return {__scenarioError:String(e&&e.stack||e)};}})())",
                result -> { value.set(result); callback.countDown(); }); return null;
        });
        long until = Math.min(deadline, SystemClock.uptimeMillis() + 10000);
        while (!callback.await(100, TimeUnit.MILLISECONDS)) {
            windowProgress();
            if (SystemClock.uptimeMillis() >= until) throw new AssertionError("SAF JavaScript evaluation callback timed out");
        }
        windowProgress();
        if (value.get() == null) throw new AssertionError("Missing SAF JavaScript evaluation result");
        Object decoded = new JSONTokener(value.get()).nextValue();
        if (!(decoded instanceof String)) throw new AssertionError("Unexpected SAF JavaScript result: " + value.get());
        JSONObject result = new JSONObject((String) decoded);
        if (result.has("__scenarioError")) throw new AssertionError(result.getString("__scenarioError"));
        return result;
    }
    private int windowProgress() throws Exception {
        return onMain(() -> { assertUsableWeb(); lastWindow = "url=" + web.getUrl() + " progress=" + web.getProgress(); return web.getProgress(); });
    }
    private void assertUsableWeb() {
        if (activity == null || activity.isDestroyed() || activity.isFinishing()) throw new AssertionError("MainActivity no longer active");
        View decor = activity.getWindow().getDecorView();
        if (decor.findViewWithTag("quietpaper-native-recovery") != null) throw new AssertionError("Production renderer recovery displayed during SAF acceptance");
        if (web == null || decor.findViewWithTag("quietpaper-web") != web || !web.isAttachedToWindow()
                || web.getParent() == null || !decor.isAttachedToWindow()) throw new AssertionError("Production WebView/window missing or detached");
    }
    private <T> T onMain(Callable<T> task) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return task.call();
        AtomicReference<T> result = new AtomicReference<>(); AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicBoolean expired = new AtomicBoolean(); CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            if (expired.get()) { done.countDown(); return; }
            try { result.set(task.call()); } catch (Throwable error) { failure.set(error); } finally { done.countDown(); }
        });
        if (!done.await(5, TimeUnit.SECONDS)) { expired.set(true); throw new AssertionError("Android main looper did not respond within 5 seconds"); }
        Throwable error = failure.get();
        if (error instanceof Exception) throw (Exception) error;
        if (error instanceof Error) throw (Error) error;
        if (error != null) throw new AssertionError(error);
        return result.get();
    }

    private boolean hasReadWriteGrant(Uri document) {
        for (UriPermission grant : resolver.getPersistedUriPermissions())
            if (document.equals(grant.getUri()) && grant.isReadPermission() && grant.isWritePermission()) return true;
        return false;
    }
    private boolean isSystemDocument(Uri document) {
        if (!"content".equals(document.getScheme()) || !DocumentsContract.isDocumentUri(context, document)) return false;
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(document.getAuthority(), 0);
        return provider != null && provider.applicationInfo != null
            && (provider.applicationInfo.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
    }
    private String displayName(Uri document) {
        try (Cursor cursor = resolver.query(document, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) : "";
        }
    }
    private byte[] readBytes(Uri document) throws Exception {
        try (InputStream input = resolver.openInputStream(document); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (input == null) throw new AssertionError("Document stream unavailable");
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (out.size() + count > 1024 * 1024) throw new AssertionError("Selected document exceeds the small owned fixture limit");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }
    private File proofFile() { return new File(context.getFilesDir(), "saf-picker-proof.json"); }
    private String readFile(File file) throws Exception {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count; while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
    private void durable(File destination, String text) throws Exception {
        File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
        try (FileOutputStream file = new FileOutputStream(temporary)) { file.write(text.getBytes(StandardCharsets.UTF_8)); file.getFD().sync(); }
        Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        FileDescriptor parent = Os.open(destination.getParent(), OsConstants.O_RDONLY | OsConstants.O_CLOEXEC, 0);
        try {
            if (!OsConstants.S_ISDIR(Os.fstat(parent).st_mode)) throw new IllegalStateException("proof-parent-not-directory");
            Os.fsync(parent);
        } finally { Os.close(parent); }
    }
    private void saveFailure(String phase, String trace) {
        try {
            String safePhase = "prepare".equals(phase) || "resume".equals(phase) ? phase : "unknown";
            File report = new File(context.getFilesDir(), "saf-picker-failure-" + safePhase + ".json");
            JSONObject failure = new JSONObject().put("phase", phase).put("pid", Process.myPid()).put("token", token)
                .put("filename", filename).put("mediaUri", createdMediaUri == null ? JSONObject.NULL : createdMediaUri.toString())
                .put("lastWindow", lastWindow).put("trace", trace).put("evidence", evidence.toString());
            if (automation != null) {
                try {
                    AccessibilityNodeInfo root = automation.getRootInActiveWindow();
                    if (root != null) try { failure.put("nodes", dump(root)); } finally { root.recycle(); }
                    Bitmap screenshot = automation.takeScreenshot();
                    if (screenshot != null) {
                        File png = new File(context.getFilesDir(), "saf-picker-failure-" + safePhase + ".png");
                        try (FileOutputStream out = new FileOutputStream(png)) { screenshot.compress(Bitmap.CompressFormat.PNG, 100, out); out.getFD().sync(); }
                        finally { screenshot.recycle(); }
                        failure.put("screenshot", png.getAbsolutePath());
                    }
                } catch (Throwable capture) { failure.put("uiCaptureError", capture.toString()); }
            }
            durable(report, failure.toString()); evidence.append("Failure evidence: ").append(report.getAbsolutePath()).append('\n');
        } catch (Throwable failure) { evidence.append("Failure evidence capture warning: ").append(failure).append('\n'); }
    }
    private String dump(AccessibilityNodeInfo root) {
        StringBuilder text = new StringBuilder(); dump(root, text, 0, new int[] {0}); return text.toString();
    }
    private void dump(AccessibilityNodeInfo node, StringBuilder text, int depth, int[] count) {
        if (node == null || depth > 16 || count[0]++ > 180) return;
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        text.append(depth).append(' ').append(node.getPackageName()).append(' ').append(node.getViewIdResourceName())
            .append(' ').append(node.getClassName()).append(" text=").append(shortText(node.getText()))
            .append(" desc=").append(shortText(node.getContentDescription())).append(" click=").append(node.isClickable())
            .append(" visible=").append(node.isVisibleToUser()).append(" bounds=").append(bounds).append('\n');
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i); if (child == null) continue;
            try { dump(child, text, depth + 1, count); } finally { child.recycle(); }
        }
    }
    private String shortText(CharSequence value) { String text = value == null ? "" : value.toString(); return text.length() > 240 ? text.substring(0, 240) : text; }
    private void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); assertions++; evidence.append("PASS ").append(message).append('\n'); }
    private static String quote(String value) { return JSONObject.quote(value).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"); }
    private static String sha(String text) throws Exception {
        StringBuilder out = new StringBuilder(); for (byte part : MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))
            out.append(String.format(Locale.ROOT, "%02x", part & 255)); return out.toString();
    }
}
