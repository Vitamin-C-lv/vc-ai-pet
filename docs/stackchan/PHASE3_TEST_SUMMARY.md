# StackChan Phase 3 — Test and build summary

Date: 2026-09-15 (Asia/Shanghai)

| Check | Result | Scope / limitation |
|---|---|---|
| Bridge contract tests | PASS | Deterministic mapping and safety cases; local only |
| Bridge fake-upstream server tests | PASS | Offline fake upstream; no state-mutating upstream request |
| C++ body-state/face host test | PASS | GCC C++17 and ESP-IDF cJSON; not physical LCD rendering |
| Official factory-source baseline build | PASS | Isolated WSL `/tmp` source/toolchain |
| Custom factory-source build | PASS | Isolated WSL `/tmp`; bridge URL unset in output image |
| `git diff --check` | PASS | Feature worktree documentation/source changes |
| Live `/api/pet/state` | Not repeated | Earlier Phase 1 GET returned HTTP 200; no POST in Phase 3 |
| Device face / online / offline / recovery | NOT RUN | No firmware write was allowed after preconditions failed |

Relevant focused commands (run from the feature worktree):

```sh
node tools/stackchan-bridge/test/contract.test.mjs
node tools/stackchan-bridge/test/server.test.mjs
g++ -std=c++17 -Wall -Wextra -Werror \
  -Idevice/stackchan/m5stack-factory \
  -I/tmp/esp-idf-v5.5.4/components/json/cJSON \
  device/stackchan/m5stack-factory/lihuahua_body_state.cpp \
  device/stackchan/m5stack-factory/test/body_state_test.cpp \
  /tmp/esp-idf-v5.5.4/components/json/cJSON/cJSON.c \
  -o /tmp/stackchan-body-state-test
/tmp/stackchan-body-state-test
```

Full sanitized commands/results, including the actual read-only device gate, are in `PHASE3_COMMANDS_AND_RESULTS.md`.
