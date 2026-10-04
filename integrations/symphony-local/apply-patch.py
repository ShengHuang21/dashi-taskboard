#!/usr/bin/env python3
"""Apply the local feature only to verified source; never fetch or upgrade it."""
import hashlib
import json
import pathlib
import subprocess
import sys

bundle = pathlib.Path(__file__).resolve().parent
if len(sys.argv) != 2 or not pathlib.Path(sys.argv[1]).is_absolute():
    sys.exit("usage: apply-patch.py ABSOLUTE_SOURCE_ROOT")
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
manifest = json.loads((bundle / "source-manifest.json").read_text())
def file_hash(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest() if filename.is_file() else None
for name, hashes in manifest["files"].items():
    if file_hash(root / name) != hashes["before"]:
        sys.exit("source baseline mismatch: " + name)
patch = bundle / "symphony.patch"
subprocess.run(["patch", "--dry-run", "-p1", "-i", str(patch)], cwd=root, check=True)
subprocess.run(["patch", "-p1", "-i", str(patch)], cwd=root, check=True)
for name, hashes in manifest["files"].items():
    if file_hash(root / name) != hashes["after"]:
        sys.exit("candidate verification failed: " + name)
print("Verified local Symphony feature applied; no runtime was started.")
