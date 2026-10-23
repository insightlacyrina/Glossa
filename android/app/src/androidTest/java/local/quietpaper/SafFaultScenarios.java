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

/** Real DocumentsUI cancellation, grant revocation and offline-source retention through the packaged homepage. */
public final class SafFaultScenarios {
    private static final String ORIGIN = "https://appassets.quietpaper.local";
    private static final Uri CONTROL = Uri.parse("content://local.quietpaper.test.safcontrol");
    private final Instrumentation runner;
    private final Context context;
    private final ContentResolver resolver;
    private final StringBuilder evidence = new StringBuilder();
    private MainActivity activity;
    private WebView web;
    private UiAutomation automation;
    private String token, filename, stateKey;
    private int assertions, requests;
    private String lastWindow = "not observed";
    private SafFaultScenarios(Instrumentation runner) {
        this.runner = runner; context = runner.getTargetContext(); resolver = context.getContentResolver();
    }
    public static void run(Instrumentation runner) {
        SafFaultScenarios scenario = new SafFaultScenarios(runner);
        Bundle output = new Bundle(); int code = Activity.RESULT_OK; String outcome;
        try { scenario.faults(); outcome = "PASS system SAF faults; assertions=" + scenario.assertions; }
        catch (Throwable failure) {
            code = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter(); failure.printStackTrace(new PrintWriter(trace));
            outcome = "FAIL system SAF faults\n" + trace;
            scenario.captureFailure(trace.toString());
        }
        if (scenario.activity != null) try { scenario.onMain(() -> { scenario.activity.finish(); return null; }); }
        catch (Throwable cleanup) { scenario.evidence.append("Cleanup: ").append(cleanup).append('\n'); }
        output.putString("stream", "\n" + outcome + "\n" + scenario.evidence
            + "Last native window: " + scenario.lastWindow + "\n"
            + "Scope: real system picker and real packaged-homepage JavaScript/native file callbacks; "
            + "test-APK DocumentsProvider owns the file under a different UID. "
            + "Retention assertions cover native pending journals and source snapshots, not React editor state or physical device behavior.\n");
        runner.finish(code, output);
    }
    private void faults() throws Exception {
        token = UUID.randomUUID().toString(); filename = SafFixtureDocumentsProvider.name(token);
        stateKey = "__glossaSafFault_" + token.replace("-", "");
        String before = "\uFEFF# SAF fault retention\r\n<!-- " + token + " -->\r\n$x+1$ 中文 📝  \r\n";
        String local = before.replace("$x+1$", "$x+2$");
        Bundle bytes = new Bundle(); bytes.putByteArray("bytes", before.getBytes(StandardCharsets.UTF_8));
        Bundle fixture = resolver.call(CONTROL, "create", token, bytes);
        require(fixture != null && fixture.getInt("ownerUid") != Process.myUid(),
            "test document belongs to a different UID; target has no owner MediaStore bypass");
        launchHomepage(); automation = runner.getUiAutomation();
        AccessibilityServiceInfo info = automation.getServiceInfo();
        if (info != null) { info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS; automation.setServiceInfo(info); }
        evaluateJson("(function(){var s={results:{}};window[" + quote(stateKey) + "]=s;"
            + "window.addEventListener('quietpaper-native',function(e){var r=e.detail;"
            + "if(r&&typeof r.requestId==='string'&&r.requestId.indexOf(" + quote(token) + ")===0)s.results[r.requestId]=r;});"
            + "return {ready:true};})()", SystemClock.uptimeMillis()+10000);
        String knownUri = DocumentsContract.buildDocumentUri(SafFixtureDocumentsProvider.AUTHORITY, token).toString();
        JSONObject ungranted = request("readDocument", knownUri);
        require(!ungranted.optBoolean("ok") && ungranted.optBoolean("unavailable"),
            "external-UID source is inaccessible before any system selection grants permission");
        String opening = start("openDocument"); selectSystemFile();
        JSONObject opened = awaitReply(opening);
        require(opened.optBoolean("ok") && before.equals(opened.optString("text")),
            "real system picker returns exact original document bytes through homepage DOM callback");
        Uri document = Uri.parse(opened.getString("uri"));
        require(SafFixtureDocumentsProvider.AUTHORITY.equals(document.getAuthority())
            && token.equals(DocumentsContract.getDocumentId(document)) && hasReadWriteGrant(document)
            && opened.optBoolean("persistentPermission"),
            "selected external-UID document has real persisted read/write URI grant");
        String uri = document.toString();
        Bundle offline = new Bundle(); offline.putBoolean("offline", true);
        resolver.call(CONTROL, "offline", token, offline);
        JSONObject unavailable = request("readDocument", uri);
        require(!unavailable.optBoolean("ok") && unavailable.optBoolean("unavailable"),
            "temporarily offline DocumentsProvider reports source unavailable through real JavaScript bridge");
        JSONObject staged = request("saveDocumentVersioned", uri, local, sha(before), "");
        require(!staged.optBoolean("ok") && staged.optBoolean("pending") && staged.optBoolean("unavailable"),
            "offline write stages exact local content before provider access fails");
        retained(uri, local, before, "offline failure");
        String cancel = start("openDocument"); awaitPicker();
        require(automation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK),
            "system picker receives actual Back cancellation");
        JSONObject cancelled = awaitReply(cancel);
        require(!cancelled.optBoolean("ok") && "cancelled".equals(cancelled.optString("error")),
            "system picker cancellation reaches matching original homepage request");
        retained(uri, local, before, "picker cancellation");
        offline.putBoolean("offline", false); resolver.call(CONTROL, "offline", token, offline);
        resolver.call(CONTROL, "revoke", token, null);
        require(!hasReadWriteGrant(document), "document owner revokes actual persisted URI permission");
        require(context.checkUriPermission(document, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            != android.content.pm.PackageManager.PERMISSION_GRANTED
            && context.checkUriPermission(document, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            != android.content.pm.PackageManager.PERMISSION_GRANTED,
            "URI-wide owner revocation removes actual temporary read and write grants as well");
        JSONObject denied = request("readDocument", uri);
        require(!denied.optBoolean("ok") && denied.optBoolean("unavailable"),
            "revoked document fails actual ContentResolver read even after provider returns online");
        JSONObject deniedRetry = request("retryPendingWrite", uri);
        require(!deniedRetry.optBoolean("ok") && deniedRetry.optBoolean("pending"),
            "revoked grant prevents retry without discarding pending content");
        retained(uri, local, before, "grant revocation");
        String reselect = start("openDocument"); selectSystemFile();
        JSONObject reopened = awaitReply(reselect);
        require(reopened.optBoolean("ok") && uri.equals(reopened.optString("uri"))
            && before.equals(reopened.optString("text")) && hasReadWriteGrant(document)
            && reopened.optBoolean("persistentPermission"),
            "real system picker reauthorizes same untouched source document");
        JSONObject saved = request("retryPendingWrite", uri);
        require(saved.optBoolean("ok") && !saved.optBoolean("pending"),
            "retained pending write succeeds only after explicit system reauthorization");
        require(Arrays.equals(local.getBytes(StandardCharsets.UTF_8), resolver.call(CONTROL,"bytes",token,null).getByteArray("bytes")),
            "owner reopens exact final UTF-8 BOM/CRLF and local formula edit");
        require(!request("getPendingSource",uri).optBoolean("pending"), "only confirmed write clears pending journal");
        String readOnlyId = UUID.randomUUID().toString();
        Bundle readOnly = new Bundle(); readOnly.putByteArray("bytes", before.getBytes(StandardCharsets.UTF_8));
        readOnly.putBoolean("readonly", true); resolver.call(CONTROL,"create",readOnlyId,readOnly);
        filename = SafFixtureDocumentsProvider.name(readOnlyId);
        String readOnlyOpen = start("openDocument"); selectSystemFile();
        JSONObject readOnlyReply = awaitReply(readOnlyOpen);
        Uri readOnlyUri = Uri.parse(readOnlyReply.getString("uri"));
        boolean retainedRead = false, retainedWrite = false;
        for (UriPermission permission : resolver.getPersistedUriPermissions()) if (readOnlyUri.equals(permission.getUri())) {
            retainedRead = permission.isReadPermission(); retainedWrite = permission.isWritePermission();
        }
        evidence.append("Read-only provider capability; actual persisted grant read=").append(retainedRead)
            .append(" write=").append(retainedWrite).append('\n');
        require(readOnlyReply.optBoolean("ok") && before.equals(readOnlyReply.optString("text")) && retainedRead,
            "system picker opens provider read-only document with actual retained read permission");
        require(readOnlyReply.has("persistentPermission")
            && readOnlyReply.getBoolean("persistentPermission") == (retainedRead && retainedWrite),
            "homepage persistentPermission reports actual retained grant mask, independently of provider write capability");
        String readOnlyRaw = readOnlyUri.toString();
        JSONObject refusedWrite = request("saveDocumentVersioned",readOnlyRaw,local,sha(before),"");
        require(!refusedWrite.optBoolean("ok") && refusedWrite.optBoolean("pending")
            && "source-write-failed".equals(refusedWrite.optString("error"))
            && refusedWrite.optBoolean("sourceReachable") && !refusedWrite.optBoolean("unavailable"),
            "provider rejects actual write capability while readable source is not classified offline");
        JSONObject readOnlyPending = request("getPendingSource",readOnlyRaw);
        require(readOnlyPending.optBoolean("ok") && readOnlyPending.optBoolean("pending")
            && local.equals(readOnlyPending.optString("text")) && sha(local).equals(readOnlyPending.optString("sha256"))
            && sha(before).equals(readOnlyPending.optString("baseSha256")),
            "rejected read-only write preserves exact pending body, target SHA and original base");
        JSONObject readOnlySnapshot = request("getSourceSnapshot",readOnlyRaw);
        require(readOnlySnapshot.optBoolean("ok") && local.equals(readOnlySnapshot.optString("text")),
            "rejected read-only write retains recoverable local candidate snapshot");
        require(Arrays.equals(before.getBytes(StandardCharsets.UTF_8),
            resolver.call(CONTROL,"bytes",readOnlyId,null).getByteArray("bytes")),
            "provider owner confirms original read-only document bytes are unchanged");
    }
    private void retained(String uri, String local, String before, String stage) throws Exception {
        JSONObject pending = request("getPendingSource",uri), snapshot = request("getSourceSnapshot",uri);
        require(pending.optBoolean("ok") && pending.optBoolean("pending") && local.equals(pending.optString("text"))
            && sha(local).equals(pending.optString("sha256")) && sha(before).equals(pending.optString("baseSha256")),
            stage + " retains exact pending body, content SHA and original base");
        require(snapshot.optBoolean("ok") && local.equals(snapshot.optString("text")),
            stage + " preserves local recoverable source snapshot body");
        require(Arrays.equals(before.getBytes(StandardCharsets.UTF_8), resolver.call(CONTROL,"bytes",token,null).getByteArray("bytes")),
            stage + " leaves externally owned original source bytes intact");
    }
    private String start(String method, String... args) throws Exception {
        String id = token + "-" + (++requests);
        org.json.JSONArray arguments = new org.json.JSONArray(); arguments.put(id);
        for (String arg : args) arguments.put(arg);
        evaluateJson("(function(){QuietPaperNative[" + quote(method) + "].apply(QuietPaperNative,"
            + arguments.toString() + ");return {started:true};})()", SystemClock.uptimeMillis()+10000);
        return id;
    }
    private JSONObject request(String method, String... args) throws Exception { return awaitReply(start(method,args)); }
    private void awaitPicker() throws Exception {
        long deadline=SystemClock.uptimeMillis()+20000;
        while(SystemClock.uptimeMillis()<deadline) {
            AccessibilityNodeInfo root=automation.getRootInActiveWindow();
            if(root!=null) try { if(isPickerPackage(String.valueOf(root.getPackageName()))) return; } finally {root.recycle();}
            Thread.sleep(100);
        }
        throw new AssertionError("System DocumentsUI did not become active");
    }
    private void captureFailure(String trace) {
        try {
            JSONObject report = new JSONObject().put("trace",trace).put("evidence",evidence.toString())
                .put("window",lastWindow).put("fixture",filename);
            if(automation!=null) {
                AccessibilityNodeInfo root=automation.getRootInActiveWindow();
                if(root!=null) try{report.put("nodes",dump(root));}finally{root.recycle();}
                Bitmap bitmap=automation.takeScreenshot();
                if(bitmap!=null) try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),"saf-faults-failure.png"))) {
                    bitmap.compress(Bitmap.CompressFormat.PNG,100,out);out.getFD().sync();
                } finally {bitmap.recycle();}
            }
            try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),"saf-faults-failure.json"))) {
                out.write(report.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();
            }
        } catch(Throwable capture) { evidence.append("Capture failure: ").append(capture).append('\n'); }
    }
    private void launchHomepage() throws Exception {
        android.util.Log.i("GlossaSafFaults", "Launching packaged homepage in a new Activity task; app data preserved");
        activity = (MainActivity) runner.startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        android.util.Log.i("GlossaSafFaults", "MainActivity started");
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
                if (!fileClicked && click(root, n -> !n.isEditable() && exact(n, filename), "unique external UID test document")) {
                    fileClicked = true; Thread.sleep(200); continue;
                }
                if (fileClicked) {
                    click(root, n -> any(n, "Open", "打开", "Select", "选择"), "system picker confirm");
                    Thread.sleep(150); continue;
                }
                if (!downloadsChosen) {
                    AccessibilityNodeInfo roots = find(root, n -> idEnds(n, ":id/roots_list"));
                    try {
                        if (roots != null && click(roots, n -> any(n, SafFixtureDocumentsProvider.ROOT_LABEL), "test DocumentsProvider root")) {
                            downloadsChosen = true; downloadsAt = SystemClock.uptimeMillis(); continue;
                        }
                    } finally { if (roots != null) roots.recycle(); }
                    if (drawerOpened && click(root, n -> any(n, SafFixtureDocumentsProvider.ROOT_LABEL), "test DocumentsProvider root")) {
                        downloadsChosen = true; downloadsAt = SystemClock.uptimeMillis(); continue;
                    }
                    if (!drawerOpened && SystemClock.uptimeMillis() - started > 1200
                            && click(root, n -> any(n, "Show roots", "Open navigation drawer", "显示根目录", "打开导航抽屉"), "Show roots")) {
                        drawerOpened = true; continue;
                    }
                    if (!drawerOpened && SystemClock.uptimeMillis() - started > 3000
                            && click(root, n -> any(n, SafFixtureDocumentsProvider.ROOT_LABEL), "visible test provider root")) {
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
    private void require(boolean condition, String message) {
        android.util.Log.i("GlossaSafFaults", (condition ? "PASS " : "FAIL ") + message);
        if (!condition) throw new AssertionError(message);
        assertions++; evidence.append("PASS ").append(message).append('\n');
    }
    private static String quote(String value) { return JSONObject.quote(value).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"); }
    private static String sha(String text) throws Exception {
        StringBuilder out = new StringBuilder(); for (byte part : MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))
            out.append(String.format(Locale.ROOT, "%02x", part & 255)); return out.toString();
    }
}
