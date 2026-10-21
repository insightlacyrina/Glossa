package local.quietpaper;

import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Focused fault-injection mode of the registered runner; independent of format tests. */
public class RendererRecoveryInstrumentation extends Instrumentation {
    private final StringBuilder evidence = new StringBuilder();
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle output = new Bundle();
        try {
            MainActivity activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            String device = activity.new NativeBridge().getDeviceId();
            String marker = "renderer recovery keeps native journals and export staging";
            File retained = new File(getTargetContext().getFilesDir(), "renderer-recovery-proof.txt");
            try (FileOutputStream file = new FileOutputStream(retained)) { file.write(marker.getBytes(StandardCharsets.UTF_8)); file.getFD().sync(); }
            ExportStore store = new ExportStore(new File(getTargetContext().getFilesDir(), "export-staging"));
            ExportStore.Session staged = store.begin("renderer-proof.json", "application/json");
            store.append(staged.id, 0, marker.getBytes(StandardCharsets.UTF_8)); staged = store.complete(staged.id);
            String stagedSha = staged.sha256;
            waitNative(() -> {
                if (activity.getWindow().getDecorView().findViewWithTag("quietpaper-native-recovery") != null) return true;
                WebView current = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
                return Build.VERSION.SDK_INT >= 29 && current != null && current.getWebViewRenderProcess() != null;
            });
            runOnMainSync(() -> {
                WebView web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
                if (web != null && Build.VERSION.SDK_INT >= 29 && web.getWebViewRenderProcess() != null) web.getWebViewRenderProcess().terminate();
            });
            waitNative(() -> activity.getWindow().getDecorView().findViewWithTag("quietpaper-native-recovery") != null);
            require(!activity.isDestroyed() && !activity.isFinishing(), "application Activity survives renderer termination");
            require(read(retained).equals(marker), "private durable file retained");
            require(store.read(staged.id).sha256.equals(stagedSha), "completed export staging retained");
            AtomicReference<Activity> replacement = new AtomicReference<>();
            Application.ActivityLifecycleCallbacks observer = new Application.ActivityLifecycleCallbacks() {
                @Override public void onActivityCreated(Activity candidate, Bundle state) { if (candidate instanceof MainActivity && candidate != activity) replacement.set(candidate); }
                @Override public void onActivityStarted(Activity a) { }
                @Override public void onActivityResumed(Activity a) { }
                @Override public void onActivityPaused(Activity a) { }
                @Override public void onActivityStopped(Activity a) { }
                @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
                @Override public void onActivityDestroyed(Activity a) { }
            };
            activity.getApplication().registerActivityLifecycleCallbacks(observer);
            runOnMainSync(() -> {
                View reopen = activity.getWindow().getDecorView().findViewWithTag("quietpaper-reopen");
                if (reopen == null || !reopen.performClick()) throw new AssertionError("native reopen action unavailable");
            });
            waitNative(() -> replacement.get() != null && activity.isDestroyed());
            require(replacement.get() instanceof MainActivity, "explicit user reopen creates replacement Activity");
            require(((MainActivity) replacement.get()).new NativeBridge().getDeviceId().equals(device), "installation identity retained after user reopen");
            require(read(retained).equals(marker) && store.read(staged.id).sha256.equals(stagedSha), "private file and export staging retained after user reopen");
            activity.getApplication().unregisterActivityLifecycleCallbacks(observer);
            store.discard(staged.id); retained.delete();
            output.putString("stream", "\nPASS renderer recovery fault injection\n" + evidence);
            finish(Activity.RESULT_OK, output);
        } catch (Throwable error) {
            output.putString("stream", "\nFAIL renderer recovery " + error + "\n" + evidence); finish(Activity.RESULT_CANCELED, output);
        }
    }
    private void waitNative(BooleanSupplier condition) throws Exception {
        long deadline = System.currentTimeMillis() + 120000;
        while (System.currentTimeMillis() < deadline) {
            AtomicBoolean ready = new AtomicBoolean(); runOnMainSync(() -> ready.set(condition.getAsBoolean()));
            if (ready.get()) return;
            Thread.sleep(100);
        }
        throw new IllegalStateException("native recovery UI/lifecycle timeout");
    }
    private String read(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) { return new String(input.readAllBytes(), StandardCharsets.UTF_8); }
    }
    private void require(boolean valid, String label) { if (!valid) throw new AssertionError(label); evidence.append("PASS ").append(label).append('\n'); }
}
