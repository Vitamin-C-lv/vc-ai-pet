# VC-AI-PET Adaptive LAN ingress 与 WSL 转发自愈

## 当前正式 Contract

```
WINDOWS_WIFI_INTERFACE=WLAN
LAN_PORT=17870
LAN_LISTEN_ADDRESS=CURRENT_WINDOWS_WIFI_IPV4
LAN_CONNECT_ADDRESS=CURRENT_WSL_IPV4
WSL_FORWARDING=SELF_HEAL_CONNECTADDRESS
FIREWALL_SCOPE=PRIVATE/WLAN/TCP_17870/LOCALSUBNET
```

Windows 继续使用 DHCP；脚本读取当前 WLAN 适配器的唯一 preferred RFC1918
IPv4，不修改 Windows Static IPv4，也不操作路由器。WSL 目标读取
kali-linux 的 eth0 IPv4。

每次 self-heal 只保证：

<CURRENT_WINDOWS_WIFI_IPV4>:17870 -> <CURRENT_WSL_IPV4>:17870

现有 100.69.220.26:17870 -> <CURRENT_WSL_IPV4>:17870 Tailscale entry
保持独立存在。脚本只清理 RFC1918 listen address 上的 VC-AI-PET LAN
port 17870 entries，不删除 Tailscale entry，不修改 Exit Node、Clash/Mihomo
或其它端口。

## Self-heal 脚本

脚本位于 scripts/windows/vc-ai-pet-lan-forwarding-self-heal.ps1，职责只有：

1. 读取当前 Windows WLAN IPv4 和 Kali WSL eth0 IPv4；
2. 查询现有 portproxy，删除旧的 RFC1918 LAN :17870 entry，并写入当前 WLAN address；
3. 保留 Tailscale 100.69.220.26:17870 entry；
4. 只更新现有 VC-AI-PET LAN Companion 17870 firewall rule 的 LocalAddress、
   RemoteAddress=LocalSubnet 和 InterfaceAlias=WLAN；
5. 验证当前 WLAN address 的 LAN root 与 /api/pet/state HTTP 状态。

脚本不会重启 WSL、Pet、Local Brain 或其它服务，不创建新的 task/firewall
rule，不做 router port forwarding、UPnP 或公网暴露。当前 WLAN 地址必须是
RFC1918；WLAN 不存在、未 Up、IPv4 不唯一或不是私有地址时 fail-closed。

真实运行：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1
```

## 计划任务

任务名：\VC-AI-PET\LAN Forwarding Self-Heal

现有 task 保持不变：当前用户登录后延迟约 1 分钟执行一次，不配置常驻
daemon 或重复 task；Action 继续指向仓库内脚本的绝对路径，并使用
Windows PowerShell 5.1。

## 有界测试

DryRun 模拟当前 fixture（不写真实系统状态）：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\vc-ai-pet-lan-forwarding-self-heal.ps1 -DryRun -SimulatedWindowsLanIPv4 192.168.1.4 -SimulatedWslIPv4 172.25.248.161

应输出当前动态 LAN listen/connect address、PORTPROXY_SCOPE=LAN_TARGET_ONLY
和 FIREWALL_SCOPE=LAN_RULE_ONLY。公网模拟地址必须 fail-closed。

2026-09-10 初次实机 repair 快照为：

WINDOWS_WIFI_IPV4=192.168.1.4
CURRENT_WSL_IPV4=172.25.248.161
LAN_PORTPROXY=192.168.1.4:17870->172.25.248.161:17870
WINDOWS_CURRENT_LAN_HTTP=http://192.168.1.4:17870/api/pet/state -> 200

随后 DHCP 将 WLAN 地址更新为 192.168.1.199；最新复核为：

WINDOWS_WIFI_IPV4=192.168.1.199
CURRENT_WSL_IPV4=172.25.248.161
LAN_PORTPROXY=192.168.1.199:17870->172.25.248.161:17870
WINDOWS_CURRENT_LAN_HTTP=http://192.168.1.199:17870/api/pet/state -> 200
SELF_HEAL_CURRENT_RUN=NOOP
TASK_LAST_RESULT=0

Android Companion 保留 app data，通过 adb install -r 覆盖安装；不执行
uninstall 或 pm clear。在 Wi-Fi 与 VPN 共存时，LAN probe/discovery
绑定 Wi-Fi network，remote endpoint 继续使用 default/VPN network。

## 历史基线

2026-09-07 的固定 .175 contract 已由当前动态 contract supersede；旧的
192.168.1.175 仍作为 Android 配置中的可回退历史地址保留，但不再作为
Windows self-heal 的硬编码 listen address。
