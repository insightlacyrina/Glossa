package local.quietpaper;

public final class SourceWritePolicyTest {
    public static void main(String[] args) {
        require(SourceWritePolicy.base(null, null, null, "new", "source-v1", "", true).equals("source-v1"), "CAS with no pending");
        require(SourceWritePolicy.base("queued", "pending-v1", "source-v1", "queued", "source-v1", "pending-v1", true).equals("source-v1"), "CAS known pending");
        reject(() -> SourceWritePolicy.base("queued", "pending-v1", "source-v1", "new", "source-v1", "", true), "unacknowledged pending");
        reject(() -> SourceWritePolicy.base("queued", "pending-v2", "source-v1", "new", "source-v1", "pending-v1", true), "pending changed since capture");
        reject(() -> SourceWritePolicy.base(null, null, null, "new", "source-v1", "pending-v1", true), "pending removed since capture");
        require(SourceWritePolicy.base("queued", "pending-v1", "source-v1", "queued", "source-v1", null, false).equals("source-v1"), "identical legacy payload retry from original source base");
        reject(() -> SourceWritePolicy.base("queued", "pending-v1", "source-v1", "different", "source-v1", null, false), "legacy retry cannot replace different pending text");
        reject(() -> SourceWritePolicy.base("queued", "pending-v1", "source-v1", "queued", "wrong-source", null, false), "identical text still requires known version");
        require(SourceWritePolicy.base("queued", "pending-v1", "source-v1", "next", "pending-v1", null, false).equals("source-v1"), "legacy explicitly based on pending retains original source base");
        System.out.println("PASS SourceWritePolicy: 9 checks; source/pending CAS and exact-payload retry");
    }
    private static void require(boolean valid, String check) { if (!valid) throw new AssertionError(check); }
    private static void reject(Runnable operation, String check) {
        try { operation.run(); } catch (IllegalStateException expected) { return; }
        throw new AssertionError(check);
    }
}
