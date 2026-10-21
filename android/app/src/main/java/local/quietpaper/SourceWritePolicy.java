package local.quietpaper;

/** Pure comparison rules shared by the Android source journal and JVM checks. */
public final class SourceWritePolicy {
    private SourceWritePolicy() { }
    public static String base(String previousText, String previousSha, String previousBase,
            String text, String expectedSource, String expectedPending, boolean versioned) {
        if (versioned) {
            String actual = previousSha == null ? "" : previousSha;
            if (!actual.equals(expectedPending == null ? "" : expectedPending)) {
                throw new IllegalStateException("pending-content-changed");
            }
            // The caller must prove ownership of this pending version before
            // acknowledging it; the bridge independently checks its identity.
            return expectedSource;
        }
        if (previousSha == null) return expectedSource;
        boolean samePayloadRetry = previousText.equals(text) && previousBase.equals(expectedSource);
        if (!previousSha.equals(expectedSource) && !samePayloadRetry) {
            throw new IllegalStateException("pending-content-changed");
        }
        return previousBase;
    }
}
