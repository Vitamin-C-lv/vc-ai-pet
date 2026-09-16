# VC-AI-PET × StackChan CoreS3 — Phase 3B 最终执行报告

日期：2026-09-16（Asia/Shanghai）
范围：刷写前置条件复核、Factory build、非侵入性桥接自检；未执行设备写入。

## 结论

本轮没有向设备 Flash 写入任何字节，也没有切换 OTA 元数据。Windows 能够识别设备，ESP32-S3/16 MiB/COM5 只读识别通过；16 MiB 私有出厂备份的分区表、otadata、ota_0 头部和中部样本与本轮 fresh readback 全部逐字节一致；带当前局域网端点的 Factory image 已成功构建，桥接器 LAN 自检通过。

但是，fresh `otadata` 读取显示两个 CRC 有效的选择记录 `ota_seq=1` 与 `ota_seq=2`。当前分区表存在两个 OTA app 分区，按 ESP-IDF 规则最高有效序号候选为 `ota_1`；旧启动记录曾指向 `0x20000`，与本轮条件性推导不一致。没有同一轮启动日志确认前，不能安全断言活动槽位，也不能把 `ota_1` 当作非活动槽位。因此本轮在“写入门禁”前停止。

## 状态字段

```text
FINAL_STATUS=STACKCHAN_PHASE3B_FLASH_ABORTED_PRECONDITION_FAILED
PRODUCTION_HEAD=1e1af4c7c99463e727888c95eb6eba08b5c764b7
STACKCHAN_BASE_COMMIT=1125c07630543d2ed263d654e4de2d68fabe5293
STACKCHAN_BRANCH=feat/stackchan-body-mvp
STACKCHAN_COMMIT_1=NOT_CREATED_THIS_PHASE
STACKCHAN_COMMIT_2=NOT_CREATED_THIS_PHASE

DEVICE_MODEL=StackChan / M5Stack CoreS3 (identity inferred from USB + screen; exact SKU label not re-read)
DEVICE_CHIP=ESP32-S3 rev v0.2
DEVICE_FRIENDLY_NAME=USB-Serial/JTAG (sanitized; no unique serial)
DEVICE_VID=303A
DEVICE_PID=1001
DEVICE_COM_PORT=COM5

DEVICE_FIRMWARE_MODE=M5STACK_FACTORY_OR_AVATAR
DEVICE_FIRMWARE_VERSION=UNVERIFIED
DEVICE_MOD_SUPPORT=UNVERIFIED
DEVICE_OTA_SUPPORT=UNVERIFIED
DEVICE_WIFI_CLIENT_SUPPORT=USER_CONFIRMED; DEVICE_HTTP_REACHABILITY_NOT_EXERCISED
DEVICE_RECOVERY_PATH=VERIFIED_PRIVATE_FULL_BACKUP_EXISTS; RESTORE_NOT_EXECUTED

DISPLAY=PRESENT
SPEAKER=PRESENT (hardware capability; current API not exercised)
MIC=PRESENT (hardware capability; current API not exercised)
CAMERA=PRESENT/UNVERIFIED FOR THIS UNIT
IMU=PRESENT (hardware capability)
TOUCH=PRESENT/UNVERIFIED FOR THIS UNIT
RGB=PRESENT/UNVERIFIED FOR THIS UNIT

SERVO_PAN_HARDWARE=UNVERIFIED_IN_THIS_PHASE
SERVO_PAN_API=UNVERIFIED
SERVO_TILT_HARDWARE=UNVERIFIED_IN_THIS_PHASE
SERVO_TILT_API=UNVERIFIED

BRIDGE_RUNTIME=WINDOWS_NATIVE (stopped after precondition abort)
WINDOWS_NODE_VERSION=v24.19.0
BRIDGE_UPSTREAM=http://127.0.0.1:17870
BRIDGE_BIND=CURRENT_PHYSICAL_WLAN_IPV4 (redacted from report)
BRIDGE_PORT=17871

BRIDGE_CONTRACT_TEST=PASS
BRIDGE_FAKE_UPSTREAM_TEST=PASS
LIVE_PET_STATE_HTTP=200 (read-only GET)
LIVE_READ_ONLY_UPSTREAM_ADAPTATION=PASS

WINDOWS_WLAN_IP=REDACTED_PRIVATE_LAN
WINDOWS_FORWARDING_CREATED=NO
WINDOWS_FIREWALL_CREATED=YES_THEN_REMOVED
FIREWALL_REMOTE_SCOPE=LocalSubnet / Wireless / TCP 17871
PUBLIC_EXPOSURE_CREATED=NO

DEVICE_FACE_CLIENT=NOT_FLASHED; BLOCKED_BY_ACTIVE_OTA_SLOT_IDENTIFICATION
DEVICE_POLL_MS=2000 (source design; not exercised on device)

DEVICE_REFLASHED=NO
FACTORY_APP_WRITE=NO
OTA_METADATA_SWITCH=NO
SERVO_COMMAND_COUNT=0

OTADATA_COPY0_SEQ=1
OTADATA_COPY1_SEQ=2
OTADATA_PREFERRED_SLOT=ota_1
LAST_OBSERVED_LOADED_SLOT=ota_0_BY_OLD_SERIAL_BANNER
ACTIVE_SLOT_STATUS=CONFLICT_UNRESOLVED
CURRENT_ACTIVE_OTA=UNRESOLVED
CURRENT_INACTIVE_OTA=UNRESOLVED
WRITE_AUTHORIZATION=BLOCKED

PET_RUNTIME_MODIFIED=NO
MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
ANDROID_MODIFIED=NO
PRODUCTION_RESTARTED=NO
PRODUCTION_DIRTY_PRESERVED=YES

HANDOFF_ZIP=SEE_FINAL_RESPONSE_AND_ZIP_METADATA
HANDOFF_ZIP_SIZE=SEE_FINAL_RESPONSE_AND_ZIP_METADATA
HANDOFF_ZIP_SHA256=SEE_FINAL_RESPONSE_AND_ZIP_METADATA
ZIP_VALIDATION=SEE_FINAL_RESPONSE
```

## 证据摘要

- Windows PnP：COM5、VID/PID `303A:1001`、设备状态 OK；本报告不记录完整唯一序列或 MAC。
- Windows 原生 esptool 只读 `flash_id`：ESP32-S3 rev v0.2、16 MiB、USB-Serial/JTAG、加密/安全启动保持关闭（来自本轮只读输出）。
- 私有 16 MiB full backup：大小与 SHA-256 已在私有备份清单复核；不进入 Git 或 ZIP。
- Fresh readback：partition table `0x8000/0x1000`、otadata `0xD000/0x2000`、ota_0 头部 `0x20000/0x10000`、ota_0 中部 `0x320000/0x10000` 均与 full backup slice 逐字节一致。
- 分区表：`ota_0 @ 0x20000, size 0x4f0000`；`ota_1 @ 0x510000, size 0x4f0000`；另有 NVS、assets、coredump 等分区。没有写入这些分区。
- otadata：两份记录 `seq=1`、`seq=2` 的 CRC 与 ESP-IDF v5.5.4 算法匹配；`ota_state` 原始值为未定义/未确认状态，不能替代启动日志。
- Bridge：`GET /healthz` 与 `GET /v1/body/state` 均 HTTP 200；body DTO 小于 4 KiB；只访问 `/api/pet/state`，未发送 POST。
- Factory build：官方源 HEAD `1b5765599fba8aaad1811d9a79358ccc7051f5f3`；构建完成，image bytes `3792448`，小于 OTA 分区；镜像包含 `/v1/body/state` 端点和本轮局域网构建输入（具体地址不写入报告）。
- 相关桥接与 C++ 状态映射测试通过；没有刷写、没有 `erase_flash`、没有 M5Burner、没有 `idf.py flash`。

## 停止原因与恢复条件

停止原因是活动 OTA 槽位证据不一致，不是构建失败。下一轮只读恢复条件：在不写入 Flash 的前提下，抓到与 fresh partition/otadata 同一轮的启动日志，明确 `Loaded app from partition` 偏移，并核对 `ota_state`；若仍不一致，必须保留停止状态。只有确认当前 active slot 和 target slot 后，才允许重新生成一次性写入摘要；本轮生成的构建产物不应直接视为已授权写入物。

## 回滚/恢复

本轮无设备写入，因此不需要设备回滚。私有 full backup 保留在用户 Downloads 的受保护目录，未复制进 handoff。若未来获得明确授权且 OTA1 启动失败，第一动作应是停止重试，使用官方 `otatool.py switch_ota_partition` 切回已确认槽位；不得直接擦除或恢复全片，除非单独获得全片恢复授权。

## 生产不变量

生产 worktree、PetRuntime、Memory Pipeline v2、Dream/Reflection、Android Companion 和现有 17870 服务均未修改、未重启。Windows 上为桥接器创建的专用 17871 入站规则在停止桥接器后已删除；没有修改 17870 的 portproxy 或防火墙规则。
