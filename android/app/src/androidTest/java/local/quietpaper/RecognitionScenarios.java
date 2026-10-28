package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Runs real bundled OCR. Optional ink-model=true explicitly requests a test model download. */
final class RecognitionScenarios {
    private int assertions;
    private final StringBuilder evidence = new StringBuilder();
    static void run(Instrumentation instrumentation, boolean downloadInk) {
        new RecognitionScenarios().execute(instrumentation, downloadInk);
    }
    private void execute(Instrumentation instrumentation, boolean downloadInk) {
        Bundle output = new Bundle();
        try (NativeRecognition service = new NativeRecognition()) {
            invalid(() -> NativeRecognition.parseInk(new JSONObject().put("objects", new JSONArray())),
                "empty input rejected");
            JSONObject ink = hInk();
            NativeRecognition.InkInput parsed = NativeRecognition.parseInk(ink);
            require(parsed.ink.getStrokes().size() == 3 && parsed.objectIds.length() == 3,
                "strokes retained as group with original source identities");
            JSONObject duplicate = hInk();
            duplicate.getJSONArray("objects").getJSONObject(1).put("id", "h0");
            invalid(() -> NativeRecognition.parseInk(duplicate), "duplicate identities rejected");
            JSONObject crossPage = hInk();
            crossPage.getJSONArray("objects").getJSONObject(1).put("pageId", "different-page");
            invalid(() -> NativeRecognition.parseInk(crossPage), "multi-page ink rejected");
            JSONObject badCoordinate = hInk();
            badCoordinate.getJSONArray("objects").getJSONObject(0).getJSONArray("points")
                .getJSONObject(0).put("x", 1e9);
            invalid(() -> NativeRecognition.parseInk(badCoordinate), "out-of-range coordinate rejected");
            invalid(() -> NativeRecognition.decodeImage("https://example.invalid/private.png"),
                "remote image URL rejected without fetching");
            invalid(() -> NativeRecognition.decodeImage("data:image/png;base64,YmFk"),
                "invalid image bytes rejected");
            invalid(() -> NativeRecognition.model("en-US-x-gesture"),
                "gesture classifiers cannot be used as text models");
            JSONObject status = await(done -> service.status("en-US", done), 60);
            require(status.optBoolean("ok") && status.getBoolean("imageAvailable"),
                "bundled image model available without download: " + status);
            if (!status.getBoolean("downloaded")) {
                JSONObject unavailable = await(done -> service.recognizeInk(ink.toString(), done), 60);
                require(!unavailable.optBoolean("ok") && "recognition-model-not-downloaded".equals(
                    unavailable.optString("error")), "missing ink model gives actionable error without implicit download");
                JSONObject unchanged = await(done -> service.status("en-US", done), 60);
                require(!unchanged.getBoolean("downloaded"), "inference does not silently download model");
            }
            String fixture = image();
            Bitmap decoded = NativeRecognition.decodeImage(fixture);
            require(decoded.getWidth() == 1000 && decoded.getHeight() == 220,
                "PNG decoded with bounded allocation");
            decoded.recycle();
            JSONObject imageResult = await(done -> service.recognizeImage(
                new JSONObjectUnchecked().data(fixture), done), 70);
            require(imageResult.optBoolean("ok"), "real bundled image OCR completed");
            require(imageResult.getString("text").contains("HELLO")
                && imageResult.getString("text").contains("123"),
                "real image OCR matches HELLO 123 ground truth");
            require("mlkit-image-text".equals(imageResult.getString("engine"))
                && imageResult.getJSONArray("regions").length() > 0,
                "image OCR returns actual engine and line regions");
            JSONObject chineseImage = await(done -> service.recognizeImage(
                new JSONObjectUnchecked().data(imageUnchecked("中文识别 123")), done), 70);
            require(chineseImage.optBoolean("ok") && chineseImage.getString("text").contains("中文识别"),
                "real Chinese image OCR matches Chinese ground truth");
            bridgeSmoke(instrumentation, fixture);
            if (downloadInk) {
                JSONObject downloaded = await(done -> service.downloadModel("en-US", done), 200);
                require(downloaded.optBoolean("ok") && downloaded.getBoolean("downloaded"),
                    "explicit test action downloads ink model");
                JSONObject recognized = await(done -> service.recognizeInk(ink.toString(), done), 60);
                require(recognized.optBoolean("ok")
                    && recognized.getJSONArray("objectIds").length() == 3
                    && recognized.getJSONArray("candidates").length() > 0,
                    "real local digital ink inference returns group candidates");
                boolean matches = false;
                JSONArray candidates = recognized.getJSONArray("candidates");
                for (int i = 0; i < candidates.length(); i++) {
                    JSONObject candidate = candidates.getJSONObject(i);
                    matches |= candidate.getString("text").trim().equalsIgnoreCase("H");
                    require(!candidate.has("confidence"), "no fabricated calibrated confidence");
                }
                require(matches, "H ground truth is present in digital ink alternatives");
                JSONObject chineseDownloaded = await(done -> service.downloadModel("zh-Hans", done), 200);
                require(chineseDownloaded.optBoolean("ok") && chineseDownloaded.getBoolean("downloaded"),
                    "explicit test action downloads simplified Chinese ink model");
                String chineseInk = personInk().toString();
                JSONObject chineseResult = await(done -> service.recognizeInk(chineseInk, done), 90);
                require(chineseResult.optBoolean("ok") && chineseResult.getJSONArray("objectIds").length() == 2,
                    "real local Chinese digital ink inference completes");
                boolean chineseMatches = false;
                JSONArray chineseCandidates = chineseResult.getJSONArray("candidates");
                for (int i = 0; i < chineseCandidates.length(); i++)
                    chineseMatches |= chineseCandidates.getJSONObject(i).getString("text").trim().equals("人");
                require(chineseMatches, "Chinese person character ground truth is present in ink alternatives");
            }
            output.putString("stream", "\nPASS native recognition " + assertions + " assertions\n" + evidence);
            instrumentation.finish(Activity.RESULT_OK, output);
        } catch (Throwable error) {
            output.putString("stream", "\nFAIL native recognition " + error + "\n" + evidence);
            instrumentation.finish(Activity.RESULT_CANCELED, output);
        }
    }
    private JSONObject hInk() throws Exception {
        JSONArray objects = new JSONArray();
        int[][] strokes = {{20, 20, 20, 100}, {70, 20, 70, 100}, {20, 60, 70, 60}};
        for (int i = 0; i < strokes.length; i++) {
            int[] s = strokes[i];
            objects.put(new JSONObject().put("id", "h" + i).put("revision", "v1")
                .put("pageId", "page1").put("points", new JSONArray()
                    .put(new JSONObject().put("x", s[0]).put("y", s[1]).put("time", i * 100))
                    .put(new JSONObject().put("x", s[2]).put("y", s[3]).put("time", i * 100 + 90))));
        }
        return new JSONObject().put("language", "en-US").put("objects", objects);
    }
    private JSONObject personInk() throws Exception {
        int[][][] paths = {{{60, 20}, {52, 45}, {40, 70}, {20, 100}},
            {{55, 40}, {62, 65}, {75, 88}, {90, 100}}};
        JSONArray objects = new JSONArray();
        for (int i = 0; i < paths.length; i++) {
            JSONArray points = new JSONArray();
            for (int p = 0; p < paths[i].length; p++)
                points.put(new JSONObject().put("x", paths[i][p][0]).put("y", paths[i][p][1])
                    .put("time", i * 100 + p * 20));
            objects.put(new JSONObject().put("id", "person" + i).put("revision", "v1")
                .put("pageId", "page1").put("points", points));
        }
        return new JSONObject().put("language", "zh-Hans").put("objects", objects);
    }
    private String image() throws Exception {
        return image("HELLO 123");
    }
    private String imageUnchecked(String text) {
        try { return image(text); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }
    private String image(String text) throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(1000, 220, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK); paint.setTextSize(110);
        paint.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL));
        canvas.drawText(text, 40, 150, paint);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes); bitmap.recycle();
        return "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
    }
    private void bridgeSmoke(Instrumentation instrumentation, String fixture) throws Exception {
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new android.content.Intent(instrumentation.getTargetContext(), MainActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<android.webkit.WebView> view = new AtomicReference<>();
        try {
            instrumentation.runOnMainSync(() -> {
                android.webkit.WebView web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web");
                view.set(web); web.stopLoading();
                web.loadDataWithBaseURL("https://appassets.quietpaper.local/",
                    "<html><body>Recognition fixture<script>window.__results=[];window.addEventListener('quietpaper-native',e=>window.__results.push(e.detail));window.__ready=true;</script></body></html>",
                    "text/html", "UTF-8", null);
            });
            waitFor(instrumentation, view.get(), "window.__ready===true");
            evaluate(instrumentation, view.get(), "QuietPaperNative.getRecognitionStatus('recognition-status-smoke','en-US');true");
            waitFor(instrumentation, view.get(), "window.__results.some(e=>e.requestId==='recognition-status-smoke'&&e.type==='recognition-status'&&e.ok&&e.available)");
            require(true, "real WebView JavascriptInterface status and event callback");
            evaluate(instrumentation, view.get(), "QuietPaperNative.recognizeImage('recognition-image-smoke',"
                + JSONObject.quote(new JSONObject().put("data", fixture).toString()) + ");true");
            waitFor(instrumentation, view.get(), "window.__results.some(e=>e.requestId==='recognition-image-smoke'&&e.type==='recognition-image'&&e.ok&&e.text.includes('HELLO')&&e.text.includes('123'))");
            require(true, "real WebView image OCR round trip with recognized text");
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
    private void waitFor(Instrumentation instrumentation, android.webkit.WebView view, String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 120_000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(evaluate(instrumentation, view, expression))) return;
            Thread.sleep(150);
        }
        throw new AssertionError("recognition bridge callback timeout");
    }
    private String evaluate(Instrumentation instrumentation, android.webkit.WebView view, String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(expression, value -> {
            result.set(value); done.countDown();
        }));
        if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("recognition WebView evaluation timeout");
        return result.get();
    }
    private JSONObject await(Consumer<Consumer<JSONObject>> action, int seconds) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<JSONObject> result = new AtomicReference<>();
        action.accept(value -> { result.set(value); done.countDown(); });
        if (!done.await(seconds, TimeUnit.SECONDS)) throw new AssertionError("recognition callback timed out");
        return result.get();
    }
    interface CheckedAction { void run() throws Exception; }
    private void invalid(CheckedAction action, String message) throws Exception {
        boolean rejected = false;
        try { action.run(); } catch (IllegalArgumentException expected) { rejected = true; }
        require(rejected, message);
    }
    private void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        assertions++; evidence.append("PASS ").append(message).append('\n');
    }
    // Consumer lambdas cannot throw checked JSONException on Android.
    private static final class JSONObjectUnchecked {
        String data(String value) {
            try { return new JSONObject().put("data", value).toString(); }
            catch (Exception impossible) { throw new IllegalStateException(impossible); }
        }
    }
}
