# Phase 3C 被动启动窗口

## 采集参数

```text
CAPTURE_MODE=PASSIVE_SERIAL
PORT=COM5
BAUD=115200
FORMAT=8N1
DTR_ENABLE=false
RTS_ENABLE=false
USER_RESET_COMMAND_SENT=NO
ESPTOOL_RESET_USED_DURING_CAPTURE=NO
WINDOW_SECONDS=38
USER_PROMPTED_ONCE_TO_SHORT_PRESS_RST=YES
BOOT_LOG_RAW=PRIVATE_ONLY
BOOT_LOG_HANDOFF_COPY=SANITIZED_ONLY
```

串口打开期间没有发送命令，没有进入 BOOT/download mode，没有执行 reset command。窗口内脱敏输出只有运行态 `SystemInfo` 行，未出现 `ESP-ROM`、`rst:`、`Trying partition`、`Loaded app`、校验失败或 fallback 行。因而：

```text
BOOT_CAPTURE_RESULT=NO_NEW_BOOT_OBSERVED
BOOT_OTADATA_SELECTED_SLOT=ota_0 (metadata/source inference, not a boot log line)
BOOT_FIRST_ATTEMPT_SLOT=UNOBSERVED
BOOT_FIRST_ATTEMPT_RESULT=UNOBSERVED
BOOT_FALLBACK_OCCURRED=UNOBSERVED
BOOT_FALLBACK_REASON=NOT_OBSERVED; copy1 ABORTED is excluded before selection
ACTUALLY_LOADED_SLOT=UNOBSERVED_THIS_WINDOW
```

## 历史证据的边界

上一轮独立串口窗口曾观察到：

```text
Loaded app from partition at offset 0x20000
```

实际分区表把 `0x20000` 映射为 `ota_0`。这可作为“历史已知运行工厂槽”为 `ota_0` 的证据，但不能替代本轮同一启动窗口的 first-attempt/fallback 观测。因此本报告不会把历史行重命名成 fresh boot PASS。

## post-readback

被动窗口结束后，单独执行一次只读 `read_flash 0xD000 0x2000`。该工具操作会触发自己的正常 reset side effect，故不计入上面的被动窗口。post-readback 得到 8192 bytes，与 boot 前 fresh `otadata`：

```text
OTADATA_CHANGED_DURING_PASSIVE_BOOT=NO_CHANGE_OBSERVED
POST_BOOT_COPY0=seq 1 / VALID / CRC 0x4743989a
POST_BOOT_COPY1=seq 2 / ABORTED / CRC 0x55f63774
PRE_POST_OTADATA_DIFF_BYTES=0
READBACK_RESET_SIDE_EFFECT=YES
```

由于本轮没有捕获新的 boot，`NO_CHANGE_OBSERVED` 表示两次只读样本一致，不表示应用已经完成一次可见的启动状态转换。
