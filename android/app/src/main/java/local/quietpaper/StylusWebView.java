package local.quietpaper;

import android.content.Context;
import android.os.Build;
import android.view.MotionEvent;
import android.webkit.WebView;

/** Keeps a paper stroke in one WebView input stream even when a palm lands or lifts. */
final class StylusWebView extends WebView {
    private static final int BARREL_BUTTONS = MotionEvent.BUTTON_STYLUS_PRIMARY
        | MotionEvent.BUTTON_STYLUS_SECONDARY | MotionEvent.BUTTON_SECONDARY;
    private static final int NO_PEN = -1;

    private static final class PaperBounds {
        final double left, top, right, bottom;
        final boolean barrelErases;

        PaperBounds(double left, double top, double right, double bottom, boolean barrelErases) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.barrelErases = barrelErases;
        }

        boolean contains(float x, float y) {
            return x >= left && x < right && y >= top && y < bottom;
        }
    }

    // The JavaScript interface publishes complete snapshots from its bridge thread.
    private volatile PaperBounds paper;
    private final MotionEvent.PointerProperties[] penProperties = {new MotionEvent.PointerProperties()};
    private final MotionEvent.PointerCoords[] penCoordinates = {new MotionEvent.PointerCoords()};
    private int penId = NO_PEN;
    private int penTool;
    private long penDownTime;
    private boolean webHasTouchStream;
    private boolean discardFingerTail;

    StylusWebView(Context context) {
        super(context);
    }

    void setPaperBounds(double left, double top, double right, double bottom, boolean barrelErases) {
        paper = Double.isFinite(left) && Double.isFinite(top)
            && Double.isFinite(right) && Double.isFinite(bottom) && right > left && bottom > top
            ? new PaperBounds(left, top, right, bottom, barrelErases) : null;
    }

    @Override public boolean onHoverEvent(MotionEvent event) {
        PaperBounds bounds = paper;
        if (bounds == null || event.getPointerCount() != 1 || !isPen(event.getToolType(0)))
            return super.onHoverEvent(event);
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_HOVER_EXIT) {
            // Chromium can drop hover exit when the tip leaves digitizer range
            // at the same coordinates. This clears only the paper hover preview.
            if (isAttachedToWindow()) {
                evaluateJavascript("window.dispatchEvent(new Event('glossa-stylus-hover-exit'))", null);
            }
            return super.onHoverEvent(event);
        }
        int originalButtons = event.getButtonState();
        if ((action != MotionEvent.ACTION_HOVER_ENTER && action != MotionEvent.ACTION_HOVER_MOVE)
                || (originalButtons & BARREL_BUTTONS) == 0 || !bounds.contains(event.getX(), event.getY()))
            return super.onHoverEvent(event);
        // Chromium maps BUTTON_STYLUS_PRIMARY to left mouse in hover. Represent
        // the barrel as the standard pen right-button state without tip contact.
        int buttons = (originalButtons & ~BARREL_BUTTONS)
            | (bounds.barrelErases ? MotionEvent.BUTTON_SECONDARY : 0);
        if (buttons == originalButtons) return super.onHoverEvent(event);
        float rawOffsetX = event.getRawX() - event.getX();
        float rawOffsetY = event.getRawY() - event.getY();
        event.getPointerProperties(0, penProperties[0]);
        readPenCoordinates(event, 0, -1, rawOffsetX, rawOffsetY);
        MotionEvent hover = obtain(event, event.getDownTime(), event.getEventTime(),
            event.getAction(), penProperties, penCoordinates, buttons);
        try {
            hover.offsetLocation(-rawOffsetX, -rawOffsetY);
            return super.onHoverEvent(hover);
        } finally {
            hover.recycle();
        }
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            penId = NO_PEN;
            webHasTouchStream = false;
            discardFingerTail = false;
        }
        if (penId != NO_PEN) {
            forwardPen(event);
            return true;
        }
        PaperBounds bounds = paper;
        if (bounds != null && (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN)) {
            int index = event.getActionIndex();
            int tool = event.getToolType(index);
            if (isPen(tool) && bounds.contains(event.getX(index), event.getY(index))
                    && !hasOtherPen(event, index)) {
                if (webHasTouchStream) cancelPriorTouch(event, index);
                penId = event.getPointerId(index);
                penDownTime = action == MotionEvent.ACTION_DOWN ? event.getDownTime() : event.getEventTime();
                penTool = bounds.barrelErases && (event.getButtonState() & BARREL_BUTTONS) != 0
                    ? MotionEvent.TOOL_TYPE_ERASER : tool;
                sendPen(event, index, MotionEvent.ACTION_DOWN);
                return true;
            }
        }
        // Another pen stroke may start while the same palm is still resting.
        if (discardFingerTail) return true;
        boolean handled = super.onTouchEvent(event);
        if (action == MotionEvent.ACTION_DOWN) webHasTouchStream = handled;
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) webHasTouchStream = false;
        return handled;
    }

    private static boolean isPen(int tool) {
        return tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
    }

    private static boolean hasOtherPen(MotionEvent event, int ownerIndex) {
        for (int index = 0; index < event.getPointerCount(); index++)
            if (index != ownerIndex && isPen(event.getToolType(index))) return true;
        return false;
    }

    private void forwardPen(MotionEvent event) {
        int index = event.findPointerIndex(penId);
        if (index < 0) return;
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_MOVE) {
            sendPen(event, index, action);
        } else if (action == MotionEvent.ACTION_CANCEL
                || ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP)
                    && event.getActionIndex() == index)) {
            boolean canceled = action == MotionEvent.ACTION_CANCEL || (Build.VERSION.SDK_INT >= 33
                && (event.getFlags() & MotionEvent.FLAG_CANCELED) != 0);
            sendPen(event, index, canceled ? MotionEvent.ACTION_CANCEL : MotionEvent.ACTION_UP);
            penId = NO_PEN;
            webHasTouchStream = false;
            discardFingerTail = action == MotionEvent.ACTION_POINTER_UP;
        }
    }

    private void sendPen(MotionEvent event, int index, int action) {
        // Chromium treats a held native barrel button as a text-selection gesture.
        // An eraser tool reaches Blink as a pen with the standard eraser button.
        int buttons = event.getButtonState() & ~BARREL_BUTTONS;
        int history = action == MotionEvent.ACTION_MOVE ? event.getHistorySize() : 0;
        if (history == 0 && event.getPointerCount() == 1 && action == event.getAction()
                && penTool == event.getToolType(index) && buttons == event.getButtonState()
                && penDownTime == event.getDownTime()) {
            super.onTouchEvent(event);
            return;
        }

        event.getPointerProperties(index, penProperties[0]);
        penProperties[0].toolType = penTool;
        float rawOffsetX = event.getRawX() - event.getX();
        float rawOffsetY = event.getRawY() - event.getY();
        // WebView's touch conversion can drop MotionEvent history, even when
        // the DOM exposes getCoalescedEvents. Forward the real samples in order
        // so Chromium can coalesce them without discarding their pressure/time.
        for (int sample = 0; sample <= history; sample++) {
            boolean current = sample == history;
            readPenCoordinates(event, index, current ? -1 : sample, rawOffsetX, rawOffsetY);
            long time = current ? event.getEventTime() : event.getHistoricalEventTime(sample);
            MotionEvent projected = obtain(event, penDownTime, time, action, penProperties, penCoordinates, buttons);
            try {
                projected.offsetLocation(-rawOffsetX, -rawOffsetY);
                super.onTouchEvent(projected);
            } finally {
                projected.recycle();
            }
        }
    }

    private void readPenCoordinates(MotionEvent event, int index, int history, float rawOffsetX, float rawOffsetY) {
        MotionEvent.PointerCoords point = penCoordinates[0];
        if (history < 0) event.getPointerCoords(index, point);
        else event.getHistoricalPointerCoords(index, history, point);
        point.x += rawOffsetX;
        point.y += rawOffsetY;
    }

    private void cancelPriorTouch(MotionEvent event, int newPenIndex) {
        int count = event.getPointerCount() - 1;
        MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
        MotionEvent.PointerCoords[] coordinates = new MotionEvent.PointerCoords[count];
        float rawOffsetX = event.getRawX() - event.getX();
        float rawOffsetY = event.getRawY() - event.getY();
        for (int source = 0, target = 0; source < event.getPointerCount(); source++) {
            if (source == newPenIndex) continue;
            properties[target] = new MotionEvent.PointerProperties();
            coordinates[target] = new MotionEvent.PointerCoords();
            event.getPointerProperties(source, properties[target]);
            event.getPointerCoords(source, coordinates[target]);
            coordinates[target].x += rawOffsetX;
            coordinates[target].y += rawOffsetY;
            target++;
        }
        MotionEvent cancel = obtain(event, event.getDownTime(), event.getEventTime(),
            MotionEvent.ACTION_CANCEL, properties, coordinates, event.getButtonState() & ~BARREL_BUTTONS);
        try {
            cancel.offsetLocation(-rawOffsetX, -rawOffsetY);
            super.onTouchEvent(cancel);
        } finally {
            cancel.recycle();
        }
        webHasTouchStream = false;
    }

    private static MotionEvent obtain(MotionEvent source, long downTime, long eventTime, int action,
            MotionEvent.PointerProperties[] properties, MotionEvent.PointerCoords[] coordinates, int buttons) {
        return MotionEvent.obtain(downTime, eventTime, action, properties.length, properties, coordinates,
            source.getMetaState(), buttons, source.getXPrecision(), source.getYPrecision(), source.getDeviceId(),
            source.getEdgeFlags(), source.getSource(), source.getFlags());
    }
}
