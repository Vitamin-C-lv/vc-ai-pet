# StackChan Phase 3 handoff index

This handoff records a **precondition abort before any firmware write**. The host-side bridge and face-client source/tests are available; the physical device is not accepted as an embodied face terminal.

## Contents

- `01_reports/PHASE3_FINAL_REPORT.md` — final status, actual boot/partition evidence, gate failures, production invariants, and recovery advice.
- `01_reports/PHASE3_COMMANDS_AND_RESULTS.md` — sanitized command/test and read-only device results.
- `01_reports/PHASE3_OFFLINE_BUILD_REPORT.md`, `01_reports/PHASE3_TEST_SUMMARY.md` — offline implementation/build/test details.
- `02_audit_design/DEVICE_PHASE_0_CAPABILITY_RECORD.md`, `02_audit_design/PHASE2_AUDIT_HANDOFF_SUMMARY.md`, `02_audit_design/SUBAGENT_AUDIT_SUMMARY.md` — firmware, hardware, official-source, and recovery audit evidence.
- `02_audit_design/PHASE1_ACCEPTANCE.md`, `02_audit_design/PHASE2_ACCEPTANCE.md`, `02_audit_design/PHASE2_COMMANDS_AND_RESULTS.md` — prior phase acceptance context.
- `02_audit_design/body-state-contract-v1.json`, `03_bridge/`, `04_device_source/` — contract, bridge source/tests, face-client source/tests and patch notes.
- `05_git/GIT_PROVENANCE.md` — base/final commit, clean status, diff stat and changed-file list.

## Exclusions

The package excludes `.git`, build outputs/caches, `node_modules`, firmware binaries, the private full-flash image, all OTA/partition backup files, raw serial logs, raw partition dumps, device unique serial/MAC, SSID/IP/password, clipboard contents, and unrelated Android user changes. The Phase 2 recovery audit is included only as a sanitized summary so it does not disclose the private image location or checksum.

The archive’s own SHA-256 is reported outside the ZIP because embedding a file’s own final hash inside the archive would change that hash.
