# Agent Handoff Protocol

VC-AI-PET（李花花）由多个没有共享聊天记忆的 Agent 协作开发：
DeepSeek Harness（DSH V4）、Windows Codex、Kali Codex、Luna（Luna Max/Team）。

所有 Agent 都能访问同一台机器的项目目录，因此从 Visual Memory Phase 1 开始，
**磁盘是唯一的跨 Agent 工程记忆**。

## Canonical 共享目录

唯一 canonical shared directory：

```text
/home/vitamin_c/projects/personal/vc-ai-pet-agent-share/
├── README.md        <- 目录说明与读写规则
├── CURRENT.md       <- 当前真实状态（阶段/优先级/deferred bugs）
├── DECISIONS.md     <- 全局决策登记（D-001 …）
├── WORK_CLAIMS.md   <- 文件 ownership（只有 coordinator 修改）
├── agents/          <- 每个 Agent 一份状态 <agent-id>.md
├── tasks/           <- 每个任务一份契约/说明 <task>.md
└── handoffs/        <- 任务完成交接 <task-id>-<agent-id>.md
```

规则：

1. **不要复制多份日志。** 只有一个 canonical directory。
2. 每个项目 worktree 根目录通过 `.agent-handoff` symlink 指向该目录。
3. `.agent-handoff` 通过本机 git exclude（common gitdir 的 `info/exclude`）排除，
   绝不进入 `git status`，也**不**产生大量实时日志 commit。
4. 不要让多个 Agent 同时修改同一个个人日志。

## 写权限

| 角色 | 可写文件 |
|------|----------|
| DeepSeek V4（coordinator） | CURRENT.md、DECISIONS.md、WORK_CLAIMS.md、agents/deepseek-v4.md |
| 每个 Luna | agents/<自己的ID>.md、handoffs/<自己的任务>.md |

任何 Agent 不得修改其它 Agent 的 agent status。
发现 ownership 冲突：先重新分工，不得并发硬改同一文件。

## 任务开始前（每个 Agent 必须）

1. 读 `.agent-handoff/CURRENT.md`、`DECISIONS.md`、`WORK_CLAIMS.md`
2. 读 `.agent-handoff/tasks/<当前任务>.md`
3. 读与自己接口有关的其它 Agent 最新状态
4. 在 `.agent-handoff/agents/<agent-id>.md` 登记：

```text
AGENT=
TASK=
STATUS=WORKING
WORKTREE=
BRANCH=
BASE_COMMIT=
FILES_OWNED=
WHAT_I_AM_DOING=
BLOCKERS=
NEXT=
```

5. 发现别人已 CLAIM 相同文件 → 不得并发修改，报告 blocker。

## 任务完成时（每个 Agent 必须）

1. 自己状态更新为 `STATUS=DONE / PARTIAL / BLOCKED`
2. 记录：

```text
FILES_CHANGED=
TESTS=
RESULT=
DISCOVERED=
COMMIT=
NEEDS_COORDINATOR_DECISION=
```

3. 写 `handoffs/<task-id>-<agent-id>.md`，
   让下一位 Agent 无需知道上一段聊天即可接手。

## Git 工作方式

- 阶段 integration branch 从指定 BASE_COMMIT 创建。
- 每个需要实际编码的 Luna 使用独立 branch/worktree，禁止多个 Agent 同时修改同一 worktree。
- 只有 coordinator 修改 WORK_CLAIMS.md、执行 merge/cherry-pick、解决接口冲突、运行 integration tests、push。
- 实时 Agent 日志不进 Git；阶段稳定结论进 `docs/DEVLOG_*.md`。
- 生产 Pet DB 在开发阶段禁止破坏性测试；测试一律使用临时 sandbox / fixture DB。

## 生产红线（写死，所有 Agent 遵守）

- 生产 Pet owner 只有 3080；3081 Pet bundle disabled。
- Local Brain=127.0.0.1:17862；LAN Companion=17870；Pet 不管理 llama/Relay/GPU gate，
  不 restart llama / Local Brain。
- 开发阶段禁止：生产 test chats、生产 Dream、生产 Visual backfill mutation。
- 阶段完成后不自动部署生产；由单独的 deployment closure 处理。
