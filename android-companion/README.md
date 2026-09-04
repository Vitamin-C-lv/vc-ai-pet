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

首次启动会显示可编辑的电脑地址，预填 `192.168.1.129:17870`。保存到 `SharedPreferences` 的只有 `host:port`，键名为 `pet_host`，不保存账号或密码。

默认端口是 `17870`。允许的地址是 `localhost`、`127.0.0.1`、私有 IPv4 网段 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`，以及手工输入的 `*.local` 主机名。地址会规范化为 `http://host:port/`。WebView 主导航只允许当前配置的 HTTP origin；公网、HTTPS、`file:`、`content:`、`intent:`、`javascript:` 和 `data:` 导航都会被拦截。

## 原生壳范围

- 一个普通 Kotlin `ComponentActivity` 和 XML Layout。
- 一个全屏 WebView，开启 JavaScript 与 DOM Storage，关闭文件访问及 URL 文件访问能力。
- `WebChromeClient.onShowFileChooser()` 使用 Activity Result `OpenDocument`，只交回图片 URI；取消时回调 `null`，不读取、压缩或上传图片。
- 使用 `WindowCompat` / `WindowInsetsControllerCompat` 隐藏状态栏和导航栏，允许边缘 swipe 临时显示系统栏；方向固定为 portrait。
- 返回键优先返回 WebView history，没有 history 时退出 Activity。
- 不使用 `addJavascriptInterface()`，不包含原生聊天、Vision、HTTP Pet API client、数据库、WebSocket、后台服务、推送、扫描或登录。

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

不需要 `READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`、`MANAGE_EXTERNAL_STORAGE`、`CAMERA`、`RECORD_AUDIO`、`POST_NOTIFICATIONS` 或位置权限；Manifest 只声明 `INTERNET`。LAN HTTP 由应用自己的 `network_security_config.xml` 允许，WebViewClient 仍执行当前 origin 的导航边界。

## 人工验收

安装后确认 App 名称为“李花花”，启动直接显示 LAN 页面且没有浏览器地址栏、底栏或 App Toolbar；确认状态栏/导航栏默认隐藏并可边缘 swipe 临时显示。继续验证文字聊天、摸摸头、玩耍、长按、图片选择器、真实 Vision 回复、历史消息/图片恢复，以及从电脑端修改一个可回滚的 Web UI marker 后 reload 能看到更新而无需重装 APK。最后撤销 marker，不在 Pet 核心留下测试改动。
