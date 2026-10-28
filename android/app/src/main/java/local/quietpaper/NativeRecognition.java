package local.quietpaper;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Base64;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognition;
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModel;
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModelIdentifier;
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizer;
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizerOptions;
import com.google.mlkit.vision.digitalink.recognition.Ink;
import com.google.mlkit.vision.digitalink.common.RecognitionCandidate;
import com.google.mlkit.vision.digitalink.recognition.RecognitionContext;
import com.google.mlkit.vision.digitalink.recognition.WritingArea;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import java.util.HashSet;
import java.io.ByteArrayInputStream;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** On-device recognition. Only downloadModel initiates a model download; recognition never does.
 * One bounded worker keeps decoding, model initialization and inference off both WebView threads.
 * Results are candidates for a whole input group, never purported character/stroke mappings. */
final class NativeRecognition implements AutoCloseable {
    static final int MAX_INK_CHARS = 8 * 1024 * 1024;
    static final int MAX_IMAGE_CHARS = 14 * 1024 * 1024;
    static final int MAX_POINTS = 50_000;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0L,
        TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4), runnable -> {
            Thread thread = new Thread(runnable, "GlossaRecognition");
            thread.setPriority(Thread.MIN_PRIORITY);
            return thread;
        });
    private volatile boolean closed;
    private volatile DigitalInkRecognizer activeInk;
    private volatile TextRecognizer activeImage;

    void status(String language, Consumer<JSONObject> complete) {
        submit(() -> statusNow(language), complete);
    }

    void downloadModel(String language, Consumer<JSONObject> complete) {
        submit(() -> {
            // This method is called only by the explicit model-download action in Settings.
            DigitalInkRecognitionModel model = model(language);
            Tasks.await(RemoteModelManager.getInstance().download(model,
                new DownloadConditions.Builder().build()), 180, TimeUnit.SECONDS);
            return statusNow(language);
        }, complete);
    }

    void recognizeInk(String json, Consumer<JSONObject> complete) {
        submit(() -> {
            require(json != null && json.length() <= MAX_INK_CHARS, "recognition-input-too-large");
            JSONObject request = new JSONObject(json);
            InkInput input = parseInk(request);
            DigitalInkRecognitionModel model = model(request.optString("language", "zh-Hans"));
            if (!Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model), 45, TimeUnit.SECONDS))
                throw new IllegalArgumentException("recognition-model-not-downloaded");
            ensureOpen();
            DigitalInkRecognizer recognizer = DigitalInkRecognition.getClient(
                DigitalInkRecognizerOptions.builder(model).build());
            activeInk = recognizer;
            try {
                ensureOpen();
                RecognitionContext.Builder context = RecognitionContext.builder()
                    .setWritingArea(new WritingArea(Math.max(1, input.width), Math.max(1, input.height)));
                String preContext = request.optString("preContext", "");
                require(preContext.length() <= 100, "invalid-recognition-context");
                context.setPreContext(preContext);
                com.google.mlkit.vision.digitalink.common.RecognitionResult result =
                    Tasks.await(recognizer.recognize(input.ink, context.build()), 30, TimeUnit.SECONDS);
                JSONArray candidates = new JSONArray();
                for (RecognitionCandidate candidate : result.getCandidates()) {
                    if (candidates.length() >= 5) break;
                    if (candidate.getText().length() <= 100_000)
                        candidates.put(new JSONObject().put("text", candidate.getText()));
                }
                String text = candidates.length() == 0 ? "" : candidates.getJSONObject(0).getString("text");
                return new JSONObject().put("ok", true).put("text", text)
                    .put("candidates", candidates).put("objectIds", input.objectIds)
                    .put("engine", "mlkit-digital-ink");
            } finally {
                activeInk = null;
                recognizer.close();
            }
        }, complete);
    }

    void recognizeImage(String json, Consumer<JSONObject> complete) {
        submit(() -> {
            require(json != null && json.length() <= MAX_IMAGE_CHARS + 1024,
                "recognition-input-too-large");
            JSONObject request = new JSONObject(json);
            Bitmap bitmap = decodeImage(request.getString("data"));
            TextRecognizer recognizer = null;
            try {
                ensureOpen();
                recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
                activeImage = recognizer;
                ensureOpen();
                Text result = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)),
                    45, TimeUnit.SECONDS);
                String text = result.getText();
                require(text.length() <= 100_000, "recognition-result-too-large");
                JSONArray regions = new JSONArray();
                for (Text.TextBlock block : result.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        if (regions.length() >= 2000) break;
                        android.graphics.Rect bounds = line.getBoundingBox();
                        JSONObject region = new JSONObject().put("text", line.getText());
                        if (bounds != null) region.put("bounds", new JSONObject()
                            .put("x", bounds.left).put("y", bounds.top)
                            .put("width", bounds.width()).put("height", bounds.height()));
                        regions.put(region);
                    }
                }
                return new JSONObject().put("ok", true).put("text", text)
                    .put("candidates", text.isEmpty() ? new JSONArray()
                        : new JSONArray().put(new JSONObject().put("text", text)))
                    .put("regions", regions).put("width", bitmap.getWidth())
                    .put("height", bitmap.getHeight()).put("engine", "mlkit-image-text");
            } finally {
                activeImage = null;
                if (recognizer != null) recognizer.close();
                bitmap.recycle();
            }
        }, complete);
    }

    private JSONObject statusNow(String language) throws Exception {
        DigitalInkRecognitionModel model = model(language);
        boolean downloaded = Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model),
            45, TimeUnit.SECONDS);
        return new JSONObject().put("ok", true).put("available", true)
            .put("downloaded", downloaded).put("language", language)
            .put("modelLanguage", model.getModelIdentifier().getLanguageTag())
            .put("imageAvailable", true).put("engine", "mlkit-digital-ink");
    }

    static DigitalInkRecognitionModel model(String language) throws Exception {
        // UI languages are mapped explicitly; gesture/shape classifiers cannot be selected here.
        String tag;
        if ("zh-Hans".equals(language) || "zh-Hani-CN".equals(language)) tag = "zh-Hani-CN";
        else if ("zh-Hant".equals(language) || "zh-Hani-TW".equals(language)) tag = "zh-Hani-TW";
        else if ("en-US".equals(language)) tag = "en-US";
        else throw new IllegalArgumentException("unsupported-recognition-language");
        DigitalInkRecognitionModelIdentifier identifier =
            DigitalInkRecognitionModelIdentifier.fromLanguageTag(tag);
        require(identifier != null, "unsupported-recognition-language");
        return DigitalInkRecognitionModel.builder(identifier).build();
    }

    static final class InkInput {
        final Ink ink;
        final JSONArray objectIds;
        final float width, height;
        InkInput(Ink ink, JSONArray objectIds, float width, float height) {
            this.ink = ink; this.objectIds = objectIds; this.width = width; this.height = height;
        }
    }

    static InkInput parseInk(JSONObject request) throws Exception {
        JSONArray objects = request.getJSONArray("objects");
        require(objects.length() > 0 && objects.length() <= 512, "invalid-recognition-strokes");
        Set<String> ids = new HashSet<>();
        JSONArray objectIds = new JSONArray();
        float minX = Float.MAX_VALUE, minY = Float.MAX_VALUE, maxX = -Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        String page = null;
        int count = 0;
        // Browser timestamps restart between sessions. Use time only when the entire group has
        // an ordered timeline; never reorder strokes using timestamps from different sessions.
        boolean hasTimeline = true;
        double previousTime = -Double.MAX_VALUE;
        for (int i = 0; i < objects.length(); i++) {
            JSONObject object = objects.getJSONObject(i);
            String id = object.getString("id");
            require(!id.isEmpty() && id.length() <= 200 && ids.add(id), "invalid-recognition-object");
            objectIds.put(id);
            if (object.has("pageId")) {
                String currentPage = object.getString("pageId");
                require(page == null || page.equals(currentPage), "recognition-multiple-pages");
                page = currentPage;
            }
            JSONArray points = object.getJSONArray("points");
            require(points.length() > 0 && (count += points.length()) <= MAX_POINTS,
                "invalid-recognition-points");
            for (int p = 0; p < points.length(); p++) {
                JSONObject point = points.getJSONObject(p);
                float x = coordinate(point, "x"), y = coordinate(point, "y");
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
                double time = point.optDouble("time", Double.NaN);
                if (!Double.isFinite(time) || Math.abs(time) > 1e15 || time < previousTime) hasTimeline = false;
                previousTime = time;
            }
        }
        Ink.Builder ink = Ink.builder();
        for (int i = 0; i < objects.length(); i++) {
            JSONArray points = objects.getJSONObject(i).getJSONArray("points");
            Ink.Stroke.Builder stroke = Ink.Stroke.builder();
            for (int p = 0; p < points.length(); p++) {
                JSONObject point = points.getJSONObject(p);
                float x = coordinate(point, "x") - minX, y = coordinate(point, "y") - minY;
                stroke.addPoint(hasTimeline ? Ink.Point.create(x, y, (long) point.getDouble("time"))
                    : Ink.Point.create(x, y));
            }
            ink.addStroke(stroke.build());
        }
        return new InkInput(ink.build(), objectIds, maxX - minX, maxY - minY);
    }

    static Bitmap decodeImage(String data) throws Exception {
        require(data != null && data.length() <= MAX_IMAGE_CHARS, "recognition-input-too-large");
        require(data.startsWith("data:image/png;base64,") || data.startsWith("data:image/jpeg;base64,")
            || data.startsWith("data:image/webp;base64,"), "invalid-recognition-image");
        int comma = data.indexOf(',');
        byte[] bytes;
        try { bytes = Base64.decode(data.substring(comma + 1), Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("invalid-recognition-image"); }
        require(bytes.length <= 10 * 1024 * 1024, "recognition-input-too-large");
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        require(options.outWidth > 0 && options.outHeight > 0 && options.outWidth <= 100_000
            && options.outHeight <= 100_000, "invalid-recognition-image");
        options.inSampleSize = 1;
        while ((long) (options.outWidth / options.inSampleSize) * (options.outHeight / options.inSampleSize) > 4_000_000
            || Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 3000)
            options.inSampleSize *= 2;
        options.inJustDecodeBounds = false;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        require(bitmap != null, "invalid-recognition-image");
        // The imported data URL retains camera EXIF. Rotate/mirror before passing a Bitmap
        // (unlike InputImage.fromFilePath, fromBitmap cannot apply metadata itself).
        int orientation;
        try {
            orientation = new ExifInterface(new ByteArrayInputStream(bytes))
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (java.io.IOException unsupportedMetadata) { orientation = ExifInterface.ORIENTATION_NORMAL; }
        Matrix transform = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: transform.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: transform.setRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: transform.setScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: transform.setRotate(90); transform.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: transform.setRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: transform.setRotate(-90); transform.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: transform.setRotate(-90); break;
            default: return bitmap;
        }
        try {
            Bitmap oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), transform, true);
            if (oriented != bitmap) bitmap.recycle();
            return oriented;
        } catch (RuntimeException failed) { bitmap.recycle(); throw failed; }
    }

    private static float coordinate(JSONObject point, String name) throws Exception {
        double value = point.getDouble(name);
        require(Double.isFinite(value) && Math.abs(value) <= 1_000_000, "invalid-recognition-coordinate");
        return (float) value;
    }
    private static void require(boolean condition, String code) {
        if (!condition) throw new IllegalArgumentException(code);
    }
    private void ensureOpen() {
        if (closed || Thread.currentThread().isInterrupted()) throw new IllegalStateException("recognition-closed");
    }
    private void submit(Callable<JSONObject> task, Consumer<JSONObject> complete) {
        if (closed) { complete.accept(error("recognition-closed")); return; }
        try {
            worker.execute(() -> {
                JSONObject result;
                try { ensureOpen(); result = task.call(); }
                catch (TimeoutException error) { result = error("recognition-timeout"); }
                catch (IllegalArgumentException error) {
                    String code = error.getMessage();
                    result = error(code != null && code.length() <= 80 && code.matches("[a-z-]+")
                        ? code : "recognition-failed");
                }
                catch (InterruptedException error) {
                    Thread.currentThread().interrupt(); result = error("recognition-cancelled");
                }
                catch (Exception error) {
                    result = error("recognition-failed");
                    Throwable cause = error.getCause() == null ? error : error.getCause();
                    try {
                        result.put("nativeError", cause.getClass().getSimpleName());
                        if (cause instanceof com.google.mlkit.common.MlKitException)
                            result.put("nativeCode", ((com.google.mlkit.common.MlKitException) cause).getErrorCode());
                    } catch (Exception ignored) { }
                }
                if (!closed) complete.accept(result);
            });
        } catch (RejectedExecutionException error) { complete.accept(error("recognition-busy")); }
    }
    private static JSONObject error(String code) {
        try { return new JSONObject().put("ok", false).put("error", code == null ? "recognition-failed" : code); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
    @Override public void close() {
        closed = true;
        worker.shutdownNow();
        DigitalInkRecognizer ink = activeInk;
        if (ink != null) ink.close();
        TextRecognizer image = activeImage;
        if (image != null) image.close();
    }
}
