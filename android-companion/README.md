# 李花花 Android Companion

这是 VC-AI-PET 的 Android Thin WebView Shell，不是 Android 版花花，也不复制一套客户端业务：

```text
Android APK
  -> 全屏 WebView
  -> LAN Companion Web UI
  -> Windows/Kali 上的 VC-AI-PET Host
```

聊天、Vision、互动、动画和 Conversation Persistence 仍然全部由电脑端 LAN Web UI 提供。网页的 HTML/CSS/JS 更新后，WebView reload 即可生效，不需要重新编译或重新安装 APK；只有 Android 原生壳、Manifest/权限、文件选择器、沉浸式行为、图标/名称或原生发现能力变化时才需要重建。

## 连接

首次启动会自动探测两个保存的 endpoint：`LAN_ENDPOINT=192.168.1.175:17870` 与 `REMOTE_ENDPOINT=100.69.220.26:17870`。连接模式 `CONNECTION_MODE` 默认为 `AUTO`，候选顺序是 `lastSuccessfulEndpoint`、`LEARNED_LAN_ENDPOINT`、配置的 LAN endpoint、remote endpoint；候选会去重。LAN 候选尽可能绑定当前 `TRANSPORT_WIFI` 网络，remote endpoint 继续使用系统默认/VPN 网络。探测只接受具有当前 `/api/pet/state` 稳定结构的 HTTP 200 响应，不会把任意开放端口当成花花的电脑。

如果所有已知候选都失败，`AUTO`/`LAN` 会根据当前 Wi-Fi IPv4 和 prefix 只扫描本地 subnet，最多扫描 512 个主机，并使用 20 个并发的短超时 probe。找到合法的 VC-AI-PET state 后，地址会保存为 `LEARNED_LAN_ENDPOINT`、`lastSuccessfulEndpoint` 和 `pet_host`；下一次启动会优先快速探测这个 learned endpoint，不要求用户清缓存或重新输入地址。过大的 subnet 会直接跳过 discovery。

默认端口是 `17870`。允许的地址是 `localhost`、`127.0.0.1`、私有 IPv4 网段 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、Tailscale CGNAT `100.64.0.0/10`，以及手工输入的 `*.local` 主机名。地址会规范化为 `http://host:port/`。WebView 主导航只允许当前配置的 HTTP origin；公网、HTTPS、`file:`、`content:`、`intent:`、`javascript:` 和 `data:` 导航都会被拦截。

## 原生壳范围

- 一个普通 Kotlin `ComponentActivity` 和 XML Layout。
- 一个全屏 WebView，开启 JavaScript 与 DOM Storage，关闭文件访问及 URL 文件访问能力。
- `WebChromeClient.onShowFileChooser()` 使用 Activity Result `OpenDocument`，只交回图片 URI；取消时回调 `null`，不读取、压缩或上传图片。
- 使用 `WindowCompat` / `WindowInsetsControllerCompat` 隐藏状态栏和导航栏，允许边缘 swipe 临时显示系统栏；方向固定为 portrait。
- 返回键优先返回 WebView history，没有 history 时退出 Activity。
- 不包含原生聊天、Vision、聊天数据库或 WebSocket。WebView 提供一个仅在已验证花花页面 ready 后响应的窄桥 `VcAiPetNotifications`，用于用户启停 Android 主动消息和报告聊天页可见状态；不开放通用 HTTP、文件或原生业务 API。
- 用户在前台打开主动消息后，原生 `remoteMessaging` foreground service（API 34+）通过现有 LAN/Tailscale endpoint 长轮询；API 26–33 使用普通 foreground service。首次启用读取 `latest=1` 建立 cursor 基线，之后把持久消息 cursor 存在应用 preferences，按 cursor 去重。通知点击会打开聊天页；若服务端响应当前安静时段标记，补收通知仍展示但保持静音。
- 后台连接服务按 endpoint route 显式使用 Wi-Fi `Network` 或系统 active default/VPN `Network`，不会依赖 Activity 的 process-wide Wi-Fi bind。连接失败时继续重试；LAN endpoint 全部失效后，每个当前 Wi-Fi IPv4/prefix 最多执行一次复用现有有界 discovery，并保存发现的 LAN endpoint。
- Android Doze 和厂商省电策略仍可暂停 foreground service 的网络活动，因此无云推送 provider 时，后台主动消息属于尽力送达，恢复网络/系统调度后会从持久 cursor 续传。应用不请求 wakelock，也不申请或修改电池优化豁免。
- Android 13+ 需要用户授权 `POST_NOTIFICATIONS` 才显示消息提醒。用户必须在应用前台主动打开此功能；服务不会从后台自行启动。Android 13 用户若拒绝通知权限，服务不会启用。

## 构建

项目内包含 Gradle Wrapper，Windows 构建命令为：

```powershell
.\gradlew.bat assembleDebug
```

Debug APK 输出为 `app/build/outputs/apk/debug/app-debug.apk`。可将它复制为 `李花花-Android-Companion-v0.1-debug.apk` 到 `dist/` 或桌面；这些构建产物默认不提交 Git。安装前可用：

```powershell
adb devices
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Manifest 还声明主动消息所需的 `FOREGROUND_SERVICE`、API 34+ `FOREGROUND_SERVICE_REMOTE_MESSAGING` 和运行时 `POST_NOTIFICATIONS`；没有位置权限或电池优化豁免。其余网络权限为 `INTERNET`、读取当前网络拓扑的 `ACCESS_NETWORK_STATE`，以及 WebView 页面加载时绑定 LAN Wi-Fi / remote default network 的 `CHANGE_NETWORK_STATE`。LAN HTTP 由应用自己的 `network_security_config.xml` 允许，WebViewClient 仍执行当前 origin 的导航边界。

## 人工验收

安装后确认 App 名称为“李花花”，启动直接显示 LAN 页面且没有浏览器地址栏、底栏或 App Toolbar；确认状态栏/导航栏默认隐藏并可边缘 swipe 临时显示。继续验证文字聊天、摸摸头、玩耍、长按、图片选择器、真实 Vision 回复、历史消息/图片恢复，以及从电脑端修改一个可回滚的 Web UI marker 后 reload 能看到更新而无需重装 APK。最后撤销 marker，不在 Pet 核心留下测试改动。
