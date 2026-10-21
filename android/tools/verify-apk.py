#!/usr/bin/env python3
"""Verify the deliverable APK contains exactly the selected Web build bytes."""
import argparse
import hashlib
import json
import pathlib
import zipfile


def main():
    project = pathlib.Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=pathlib.Path, default=project / "android/app/build/outputs/apk/debug/app-debug.apk")
    parser.add_argument("--web-root", type=pathlib.Path, default=project / "dist")
    args = parser.parse_args()
    expected = {"assets/web/" + file.relative_to(args.web_root).as_posix(): file for file in args.web_root.rglob("*") if file.is_file()}
    if "assets/web/index.html" not in expected:
        raise SystemExit("Selected Web build has no index.html")
    with zipfile.ZipFile(args.apk) as archive:
        actual = {name for name in archive.namelist() if name.startswith("assets/web/") and not name.endswith("/")}
        if actual != set(expected):
            raise SystemExit("APK Web file set mismatch: " + json.dumps({"missing": sorted(set(expected) - actual), "stale": sorted(actual - set(expected))}))
        for name, file in expected.items():
            if archive.read(name) != file.read_bytes():
                raise SystemExit("APK contains stale Web bytes: " + name)
        dex = b"".join(archive.read(name) for name in archive.namelist() if name.startswith("classes") and name.endswith(".dex"))
        for method in [b"saveDocumentVersioned", b"getPendingSource", b"beginExport", b"appendExportChunk", b"completeExport", b"onRenderProcessGone", b"quietpaper-native-recovery"]:
            if method not in dex:
                raise SystemExit("APK omits required native bridge: " + method.decode())
    print(json.dumps({"apk": str(args.apk.resolve()), "sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
                      "webFiles": len(expected), "webBytes": sum(file.stat().st_size for file in expected.values()),
                      "webMatches": True, "versionedSourceAndChunkExportBridgePresent": True, "rendererRecoveryPresent": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
