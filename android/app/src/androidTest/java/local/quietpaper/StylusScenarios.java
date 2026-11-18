package local.quietpaper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.webkit.WebView;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Drives the production WebView with Android MotionEvent, without substituting DOM input. */
final class StylusScenarios {
    private static final int STYLUS = MotionEvent.TOOL_TYPE_STYLUS;
    private static final int FINGER = MotionEvent.TOOL_TYPE_FINGER;
    private static final int BARREL = MotionEvent.BUTTON_STYLUS_PRIMARY;
    private static final String STROKES = "document.querySelectorAll('.paper-sheet [data-ink-stroke]').length";
    private final Instrumentation runner;
    private final StringBuilder evidence = new StringBuilder();
    private int assertions;
    private MainActivity activity;
    private WebView web;
    private float x, y, step;

    private StylusScenarios(Instrumentation runner) {
        this.runner = runner;
    }

    static void run(Instrumentation runner) {
        StylusScenarios scenario = new StylusScenarios(runner);
        Bundle output = new Bundle();
        int result = Activity.RESULT_OK;
        String outcome;
        try {
            scenario.execute();
            outcome = "PASS native stylus " + scenario.assertions + " assertions";
        } catch (Throwable failure) {
            result = Activity.RESULT_CANCELED;
            StringWriter trace = new StringWriter();
            failure.printStackTrace(new PrintWriter(trace));
            outcome = "FAIL native stylus\n" + trace;
            try {
                scenario.evidence.append("Last trace: ").append(scenario.evaluate("window.__stylusTrace")).append('\n');
            } catch (Exception ignored) { }
        } finally {
            if (scenario.activity != null) runner.runOnMainSync(scenario.activity::finish);
        }
        output.putString("stream", "\n" + outcome + "\n" + scenario.evidence
            + "Scope: synthetic Android MotionEvent through the packaged WebView. "
            + "No physical S Pen pressure calibration, palm hardware, latency or One UI gesture claim.\n");
        runner.finish(result, output);
    }

    private void execute() throws Exception {
        activity = (MainActivity) runner.startActivitySync(new Intent(runner.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        runner.runOnMainSync(() -> web = activity.getWindow().getDecorView().findViewWithTag("quietpaper-web"));
        require(web instanceof StylusWebView, "physical tablet uses scoped stylus WebView");
        waitFor("document.querySelector('.new-paper') && typeof window.QuietPaperNative?.setStylusPaperBounds==='function'");
        evaluate("document.querySelector('.new-paper').click();true");
        waitFor("!!document.querySelector('.paper-sheet')");
        JSONArray area = new JSONArray(evaluate("""
            (() => {
              const paper = document.querySelector('.paper-sheet');
              const rect = paper.getBoundingClientRect();
              const left = Math.max(rect.left + 20, 20), top = Math.max(rect.top + 20, 20);
              const right = Math.min(rect.right - 20, innerWidth - 20);
              const bottom = Math.min(rect.bottom - 20, innerHeight - 120);
              if (right - left < 120 || bottom - top < 150) throw new Error('No visible writing area');
              const x = left + (right - left) * 0.15, y = top + (bottom - top) * 0.19;
              const step = Math.min((right - left) / 15, (bottom - top) / 17);
              for (const [dx,dy] of [[0,0],[4,0],[4,3],[4,7],[4,10]]) {
                if (!document.elementFromPoint(x + dx * step, y + dy * step)?.closest('.paper-sheet'))
                  throw new Error('Input point is occluded');
              }
              return [x * devicePixelRatio, y * devicePixelRatio, step * devicePixelRatio];
            })()
            """));
        x = (float) area.getDouble(0);
        y = (float) area.getDouble(1);
        step = (float) area.getDouble(2);
        evaluate("""
            window.__stylusTrace = [];
            window.__stylusExitCount = 0;
            window.addEventListener('glossa-stylus-hover-exit', () => window.__stylusExitCount++);
            for (const kind of ['pointerenter', 'pointerleave', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
              document.addEventListener(kind, event => {
                if (!event.target.closest?.('.paper-sheet')) return;
                const sample = point => [point.pressure, point.tiltX, point.tiltY, point.timeStamp];
                window.__stylusTrace.push({
                  type: event.type, tool: event.pointerType, button: event.button,
                  buttons: event.buttons, id: event.pointerId, trusted: event.isTrusted,
                  sample: sample(event), history: (event.getCoalescedEvents?.() || []).map(sample)
                });
              }, true);
            }
            true;
            """);

        draw(0, 0, false);
        waitFor(STROKES + "===1");
        require(check("has('pen','pointerdown',e=>e.trusted && e.buttons===1"
                + " && Math.abs(e.sample[0]-.24)<.01 && (e.sample[1]!==0 || e.sample[2]!==0))"),
            "real WebView receives native pen contact with pressure and tilt");
        verifyRawSamples();

        clearTrace();
        float secondY = y + 3 * step;
        long fingerDown = SystemClock.uptimeMillis() - 35;
        Contact finger = contact(1, FINGER, x + step, secondY + step, 0.4f);
        Contact pen = contact(7, STYLUS, x, secondY, 0.42f);
        touch(fingerDown, fingerDown, MotionEvent.ACTION_DOWN, 0, 0, finger);
        waitFor("window.__stylusTrace.some(e=>e.tool==='touch' && e.type==='pointerdown')");
        touch(fingerDown, fingerDown + 12, pointerAction(MotionEvent.ACTION_POINTER_DOWN, 1), 0, 0, finger, pen);
        pen.coords.x = x + step;
        touch(fingerDown, fingerDown + 20, MotionEvent.ACTION_MOVE, 0, 0, finger, pen);
        waitFor("window.__stylusTrace.some(e=>e.tool==='pen' && e.type==='pointermove')");
        require(check("has('touch','pointercancel') && has('pen','pointerdown')"
                + " && !has('pen','pointerup') && !has('pen','pointercancel') && " + STROKES + "===1"),
            "pen joins an active finger stream and cancels its preview");
        touch(fingerDown, SystemClock.uptimeMillis(), pointerAction(MotionEvent.ACTION_POINTER_UP, 1),
            0, 0, finger, pen);
        waitFor(STROKES + "===2");

        clearTrace();
        pen.coords.x = x;
        pen.coords.y = y + 5 * step;
        touch(fingerDown, SystemClock.uptimeMillis(), pointerAction(MotionEvent.ACTION_POINTER_DOWN, 1),
            0, 0, finger, pen);
        pen.coords.x = x + step;
        touch(fingerDown, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, 0, 0, finger, pen);
        touch(fingerDown, SystemClock.uptimeMillis(), pointerAction(MotionEvent.ACTION_POINTER_UP, 0),
            0, MotionEvent.FLAG_CANCELED, finger, pen);
        waitFor("window.__stylusTrace.some(e=>e.tool==='pen' && e.type==='pointermove')");
        require(check("has('pen','pointerdown') && !has('pen','pointerup')"
                + " && !has('pen','pointercancel') && " + STROKES + "===2"),
            "a second stroke starts with the same palm resting and survives its flagged lift");
        pen.coords.x = x + 3 * step;
        touch(fingerDown, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, 0, 0, pen);
        touch(fingerDown, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, 0, 0, pen);
        waitFor(STROKES + "===3");
        require(check("window.__stylusTrace.filter(e=>e.tool==='pen' && e.type==='pointerup').length===1"),
            "pen commits exactly once after palm rejection");

        clearTrace();
        long canceledDown = SystemClock.uptimeMillis() - 30;
        pen.coords.x = x;
        pen.coords.y = y + 7 * step;
        finger.coords.y = pen.coords.y + step;
        touch(canceledDown, canceledDown, MotionEvent.ACTION_DOWN, 0, 0, pen);
        touch(canceledDown, canceledDown + 8, pointerAction(MotionEvent.ACTION_POINTER_DOWN, 1), 0, 0, pen, finger);
        pen.coords.x = x + 2 * step;
        touch(canceledDown, canceledDown + 16, MotionEvent.ACTION_MOVE, 0, 0, pen, finger);
        touch(canceledDown, canceledDown + 24, pointerAction(MotionEvent.ACTION_POINTER_UP, 0),
            0, MotionEvent.FLAG_CANCELED, pen, finger);
        touch(canceledDown, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, 0, 0, finger);
        waitFor("window.__stylusTrace.some(e=>e.tool==='pen' && e.type==='pointercancel')");
        require(check("!has('pen','pointerup') && !has('touch','pointerdown') && " + STROKES + "===3"),
            "flagged pen lift rolls back ink and the leftover finger cannot commit");

        clearTrace();
        draw(0, BARREL, true);
        waitFor("window.__stylusTrace.some(e=>e.tool==='pen' && e.type==='pointercancel')");
        require(check("has('pen','pointerdown',e=>e.button===5 && e.buttons===32) && " + STROKES + "===3"),
            "S Pen barrel reaches the DOM as a temporary eraser; native cancel preserves original ink");
        clearTrace();
        draw(0, BARREL, false);
        waitFor(STROKES + "===2");
        require(check("has('pen','pointerup',e=>e.button===5 && e.buttons===0)"),
            "eraser remains latched through barrel release and commits only on valid lift");

        verifyHover();

        clearTrace();
        draw(10, 0, false);
        waitFor(STROKES + "===3");
        require(check("has('pen','pointerdown',e=>e.button===0 && e.buttons===1)"),
            "next unmodified pen contact writes ink with the previous pen tool");

        evaluate("""
            const r = document.querySelector('.paper-sheet').getBoundingClientRect();
            QuietPaperNative.setStylusPaperBounds(r.left * devicePixelRatio, r.top * devicePixelRatio,
              r.right * devicePixelRatio, r.bottom * devicePixelRatio, false);
            true;
            """);
        clearTrace();
        draw(7, BARREL, false);
        waitFor(STROKES + "===4");
        require(check("has('pen','pointerdown',e=>e.button===0 && e.buttons===1)"),
            "disabled barrel preference preserves writing instead of WebView text selection");
    }

    private void verifyHover() throws Exception {
        clearTrace();
        String cursor = "document.querySelector('circle[data-pen-hover]')";
        hover(MotionEvent.ACTION_HOVER_ENTER, 0, x);
        hover(MotionEvent.ACTION_HOVER_MOVE, 0, x + step);
        waitFor(cursor + "?.getAttribute('visibility')==='visible'");
        hover(MotionEvent.ACTION_HOVER_MOVE, BARREL, x + 2 * step);
        waitFor(cursor + "?.getAttribute('data-tool')==='eraser'");
        require(check("has('pen','pointermove',e=>e.trusted && e.buttons===2 && e.sample[0]===0)"
                + " && !has('pen','pointerdown') && " + STROKES + "===2"),
            "barrel hover previews the eraser radius without writing or erasing");
        hover(MotionEvent.ACTION_HOVER_EXIT, 0, x + 2 * step);
        waitFor("window.__stylusExitCount>0 && " + cursor + "?.getAttribute('visibility')==='hidden'");
        require(check("!has('pen','pointerdown') && " + STROKES + "===2"),
            "leaving native hover at the same point clears the cursor without changing ink");
    }

    private void verifyRawSamples() throws Exception {
        String read = """
            (() => {
              const id = document.querySelector('.paper-sheet [data-ink-stroke]').getAttribute('data-ink-stroke');
              const open = indexedDB.open('quiet-paper-v1', 1);
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('workspace', 'readonly');
                const current = tx.objectStore('workspace').get('current');
                current.onsuccess = () => {
                  window.__storedStylusSamples = current.result?.project.operations
                    .find(op => op.type === 'object.create' && op.payload.object.id === id)?.payload.object.points;
                };
                tx.oncomplete = () => db.close();
              };
              return true;
            })()
            """;
        for (int attempt = 0; attempt < 20; attempt++) {
            evaluate(read);
            if ("true".equals(evaluate("Array.isArray(window.__storedStylusSamples)"))) break;
            Thread.sleep(75);
        }
        require(check("""
            (() => {
              const points = window.__storedStylusSamples;
              const pressures = [.24, .35, .51, .72];
              return points?.length === pressures.length && points.every((p,i) =>
                Math.abs(p.pressure - pressures[i]) < .01 &&
                Math.abs(p.time - points[0].time - 6*i) < 1 &&
                Math.abs(p.tiltY - 20) < 2 &&
                (i===0 || p.x > points[i-1].x));
            })()
            """), "every native historical sample persists in order with pressure, tilt and timing");
    }

    private void draw(int yOffset, int barrel, boolean cancel) {
        long down = SystemClock.uptimeMillis() - 32;
        float atY = y + yOffset * step;
        Contact pen = contact(7, STYLUS, x, atY, 0.24f);
        touch(down, down, MotionEvent.ACTION_DOWN, barrel, 0, pen);
        pen.coords.x = x + step;
        pen.coords.pressure = 0.35f;
        MotionEvent batch = obtain(down, down + 6, MotionEvent.ACTION_MOVE, 0, 0, pen);
        pen.coords.x = x + 2 * step;
        pen.coords.pressure = 0.51f;
        batch.addBatch(down + 12, new MotionEvent.PointerCoords[]{pen.coords}, 0);
        pen.coords.x = x + 3 * step;
        pen.coords.pressure = 0.72f;
        batch.addBatch(down + 18, new MotionEvent.PointerCoords[]{pen.coords}, 0);
        dispatch(batch);
        pen.coords.pressure = 0;
        touch(down, SystemClock.uptimeMillis(), cancel ? MotionEvent.ACTION_CANCEL : MotionEvent.ACTION_UP, 0, 0, pen);
    }

    private static int pointerAction(int action, int index) {
        return action | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
    }

    private static final class Contact {
        final MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
        final MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
    }

    private static Contact contact(int id, int tool, float x, float y, float pressure) {
        Contact contact = new Contact();
        contact.properties.id = id;
        contact.properties.toolType = tool;
        contact.coords.x = x;
        contact.coords.y = y;
        contact.coords.pressure = pressure;
        contact.coords.size = tool == FINGER ? 0.6f : 0.02f;
        if (tool == STYLUS) contact.coords.setAxisValue(MotionEvent.AXIS_TILT, 0.35f);
        return contact;
    }

    private static MotionEvent obtain(long down, long time, int action, int buttons, int flags, Contact... contacts) {
        MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[contacts.length];
        MotionEvent.PointerCoords[] coordinates = new MotionEvent.PointerCoords[contacts.length];
        for (int index = 0; index < contacts.length; index++) {
            properties[index] = contacts[index].properties;
            coordinates[index] = contacts[index].coords;
        }
        return MotionEvent.obtain(down, time, action, contacts.length, properties, coordinates,
            0, buttons, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, flags);
    }

    private void hover(int action, int buttons, float atX) {
        long now = SystemClock.uptimeMillis();
        Contact pen = contact(7, STYLUS, atX, y, 0);
        MotionEvent event = MotionEvent.obtain(now, now, action, 1,
            new MotionEvent.PointerProperties[]{pen.properties}, new MotionEvent.PointerCoords[]{pen.coords},
            0, buttons, 1, 1, 0, 0, InputDevice.SOURCE_STYLUS, 0);
        try {
            runner.runOnMainSync(() -> web.dispatchGenericMotionEvent(event));
        } finally {
            event.recycle();
        }
    }

    private void touch(long down, long time, int action, int buttons, int flags, Contact... contacts) {
        dispatch(obtain(down, time, action, buttons, flags, contacts));
    }

    private void dispatch(MotionEvent event) {
        try {
            runner.runOnMainSync(() -> web.dispatchTouchEvent(event));
        } finally {
            event.recycle();
        }
    }

    private void clearTrace() throws Exception {
        evaluate("window.__stylusTrace.length=0;true");
    }

    private boolean check(String expression) throws Exception {
        return "true".equals(evaluate("(() => {const has=(tool,type,predicate=()=>true)=>window.__stylusTrace"
            + ".some(e=>e.tool===tool && e.type===type && predicate(e));return " + expression + ";})()"));
    }

    private void waitFor(String expression) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        do {
            if ("true".equals(evaluate("Boolean(" + expression + ")"))) return;
            Thread.sleep(60);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Timed out: " + expression);
    }

    private String evaluate(String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch complete = new CountDownLatch(1);
        runner.runOnMainSync(() -> web.evaluateJavascript(script, result -> {
            value.set(result);
            complete.countDown();
        }));
        if (!complete.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("WebView evaluation timed out");
        return value.get();
    }

    private void require(boolean valid, String label) {
        if (!valid) throw new AssertionError(label);
        assertions++;
        evidence.append("PASS ").append(label).append('\n');
    }
}
