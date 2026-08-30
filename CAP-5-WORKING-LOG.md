# CAP-5 Working Log

## Objective

Preserve arbitrary attachment bytes when Taskboard API requests are relayed through the Codex CDP network proxy.

## Current evidence

- Whole-diff Phase 1 reviewer verdict: `CHANGES_REQUIRED`.
- Confirmed defect: `scripts/codex-injector.mjs` forwards `request.postData` as text, while README/task/comment attachment endpoints upload raw binary `File` bodies.
- Static reproduction: bytes including `0x80` and `0xff` change after a UTF-8 string round trip.
- RED evidence: the new proxy-level binary round-trip test failed because no binary-safe request-body helper existed.
- GREEN evidence: CDP `postDataEntries[].bytes` are decoded from base64 into a `Buffer`; the local proxy regression uploads and downloads `00 7f 80 ff 0d 0a 41` byte-for-byte.
- Focused verification: `node --check scripts/codex-injector.mjs` and all 13 `test/injector.test.mjs` tests pass.
- Related verification: Node 431 passed/1 skipped, dedicated browser 1/1, components 9/9, TypeScript typecheck, `build:web`, and `git diff --check` pass.
- Independent CAP-5 reviewer verdict: `PASS`; a real Chrome/CDP probe confirmed `postDataEntries[].bytes` preserves the exact binary sequence and the regression exercises the production forwarding function.
- Current cumulative baseline: `5a420160c505f6daa1b68d87aa812e23ec6cb72e` plus the preserved Phase 1 dirty tree.

## Scope

- `scripts/codex-injector.mjs`
- `test/injector.test.mjs`

No canonical restart, deployment, direct SQLite mutation, force-push, or unrelated adapter work.

## Next action

Repeat the independent Phase 1 whole-diff review against fixed base `5a420160c505f6daa1b68d87aa812e23ec6cb72e` before any delivery action. Canonical `47823` remains untouched and is not current-source acceptance evidence.
