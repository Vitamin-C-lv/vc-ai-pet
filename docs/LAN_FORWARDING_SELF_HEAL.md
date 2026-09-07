# VC-AI-PET 固定 LAN Endpoint 与 WSL 转发自愈

## 正式 Contract

```
OFFICIAL_LAN_ENDPOINT=http://192.168.1.175:17870
OFFICIAL_LAN_PORT=17870
WINDOWS_FIXED_LAN_IP=192.168.1.175
IP_STABILITY_METHOD=ROUTER_DHCP_RESERVATION
WSL_FORWARDING=SELF_HEAL_CONNECTADDRESS
```

Windows 保持 DHCP。路由器需要将当前 WLAN 的真实 MAC reservation 到
192.168.1.175；本机脚本不修改 Windows Static IPv4，也不操作路由器。

## Self-heal 脚本

脚本位于 scripts/windows/vc-ai-pet-lan-forwarding-self-heal.ps1，职责只有：

1. 从 Kali WSL eth0 读取当前 IPv4；
2. 检查 Windows 是否仍拥有正式的 192.168.1.175；
3. 查询 portproxy 的 192.168.1.175:17870 目标；
4. 目标正确时输出 NOOP；
5. WSL IP 漂移时只替换这个 portproxy 的 connectaddress；
6. 验证 Windows LAN root 和 /api/pet/state。

脚本不会重启 WSL、Pet、Local Brain 或其它服务，不改 Firewall，不改其它
portproxy entry，也不把新 DHCP 地址漂移成正式 endpoint。若 Windows 不再
拥有 .175，会输出 LAN_FIXED_IP_LOST 并以非零状态停止。

真实运行：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1
```

## 计划任务

任务名：VC-AI-PET LAN Forwarding Self-Heal

触发策略：当前用户登录后延迟约 1 分钟执行一次；不配置每分钟轮询或常驻
daemon。任务使用 Windows PowerShell 5.1 和仓库内脚本的绝对路径。

## 有界测试

当前实况 A：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1
```

预期：当前 WSL IP 与 192.168.1.175:17870 已一致时输出
SELF_HEAL_CURRENT_RUN=NOOP，并得到 root/state 的 2xx。

模拟 WSL 漂移 B（DryRun，不写真实 portproxy）：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1 -SimulatedWslIPv4 172.25.248.162 -DryRun
```

预期：输出 WOULD_UPDATE，范围为 TARGET_ONLY；不触碰其它 portproxy 或
Firewall。

模拟固定地址丢失 C：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1 -SimulatedWindowsLanIPv4 192.168.1.176 -SimulatedWslIPv4 172.25.248.162
```

预期：输出 LAN_FIXED_IP_LOST，停止且不写入 portproxy。

Android F/G：

- fresh install 且没有 pet_host preference 时默认 192.168.1.175:17870；
- 已有 pet_host preference 时继续加载并保留用户地址；
- 本轮不增加 UDP discovery、mDNS 或 preference 覆盖逻辑。
