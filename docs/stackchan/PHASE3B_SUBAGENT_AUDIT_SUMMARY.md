# Phase 3B 子代理只读复核摘要

本摘要只保留结论，不保留原始设备标识或敏感日志。

## Factory build audit

复核确认旧 image 没有真实 bridge URL；问题来自配置 header 不在实际编译 source directory。主任务随后新增 deterministic staging script，将 header 仅写到临时 build tree，并对最终 binary 做 endpoint 检查。配置后的 fresh build 已通过。

## OTA/recovery audit

复核确认 `otadata` 两份 CRC 有效记录为 seq 1/2，ESP-IDF v5.5.4 的标准映射在双 OTA 分区下把最高序号映射为 `ota_1`。旧串口启动记录加载 `0x20000`，对应 `ota_0`。两者无法在缺少同一轮启动日志的情况下合并成“当前 active/inactive”结论，必须 fail closed。

## Report audit

复核确认 fresh partition table、otadata、ota_0 头/中部样本与私有 full backup 一致；这证明本轮没有观察到自备份以来的 Flash 内容变化，但不证明 ota_1 可启动，也不授权覆盖它。

## Main-agent decision

保持 no-write：不写 app、不切换 otadata、不执行 erase、不刷新官方/第三方固件。交付状态为 `STACKCHAN_PHASE3B_FLASH_ABORTED_PRECONDITION_FAILED`。
