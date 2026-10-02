package com.vitaminc.vcaipet.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

object ProactiveNotificationPrefs {
    const val PREFERENCES_NAME = "pet_connection"
    const val ENABLED = "proactive_notifications_enabled"
    const val CURSOR = "proactive_notification_cursor"
}

object ProactiveChatVisibility {
    @Volatile
    var activityResumed = false

    @Volatile
    var chatVisible = false

    fun isVisible(): Boolean = activityResumed && chatVisible
}

class ProactiveNotificationService : Service() {
    private val running = AtomicBoolean(false)
    private val worker by lazy { Executors.newSingleThreadExecutor() }
    private val preferences by lazy {
        getSharedPreferences(ProactiveNotificationPrefs.PREFERENCES_NAME, MODE_PRIVATE)
    }
    private val connectivityManager by lazy {
        getSystemService(ConnectivityManager::class.java)
    }

    @Volatile
    private var activeConnection: HttpURLConnection? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!preferences.getBoolean(ProactiveNotificationPrefs.ENABLED, false)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (running.compareAndSet(false, true)) worker.execute(::pollMessages)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running.set(false)
        activeConnection?.disconnect()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val notification = foregroundNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                FOREGROUND_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
            )
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification)
        }
    }

    private fun pollMessages() {
        val discoverySubnets = mutableSetOf<String>()
        while (running.get()) {
            if (!preferences.getBoolean(ProactiveNotificationPrefs.ENABLED, false) ||
                !notificationsAllowed(this)
            ) {
                running.set(false)
                stopSelf()
                return
            }

            val settings = ConnectionSettingsReader.read(preferences)
            var response: JSONObject? = null
            var reached: EndpointCandidate? = null
            for (candidate in settings.candidateEntries()) {
                if (!running.get()) break
                response = requestMessages(candidate)
                if (response != null) {
                    reached = candidate
                    break
                }
            }

            if (response == null) {
                val wifi = WifiLanDiscovery.findWifiNetwork(connectivityManager)
                if (settings.mode != ConnectionMode.REMOTE && wifi != null) {
                    val subnetKey = "${wifi.ipv4Address.hostAddress}/${wifi.prefixLength}"
                    if (discoverySubnets.add(subnetKey)) {
                        val discovered = discoverLanEndpoint(wifi)
                        if (discovered != null) {
                            rememberEndpoint(discovered, learnedLan = true)
                            val candidate = EndpointCandidate(discovered, EndpointRoute.WIFI)
                            response = requestMessages(candidate)
                            if (response != null) reached = candidate
                        }
                    }
                }
            }

            if (response == null) {
                pauseBeforeRetry()
                continue
            }
            if (!isActive()) return
            reached?.let { rememberEndpoint(it.address, learnedLan = false) }
            if (isActive()) consumeResponse(response)
        }
    }

    private fun requestMessages(candidate: EndpointCandidate): JSONObject? {
        val wifiNetwork = if (candidate.route == EndpointRoute.WIFI) {
            WifiLanDiscovery.findWifiNetwork(connectivityManager)?.network
        } else {
            null
        }
        val activeDefaultNetwork = if (candidate.route == EndpointRoute.DEFAULT) {
            connectivityManager.activeNetwork
        } else {
            null
        }
        val network = networkForEndpointRoute(candidate.route, wifiNetwork, activeDefaultNetwork)
            ?: return null
        val hasCursor = preferences.contains(ProactiveNotificationPrefs.CURSOR)
        val cursor = if (hasCursor) {
            preferences.getLong(ProactiveNotificationPrefs.CURSOR, 0L)
        } else {
            null
        }
        val query = if (cursor == null) {
            "latest=1"
        } else {
            "after=$cursor&wait=25"
        }
        val connection = runCatching {
            val url = URL("${candidate.address.url}api/pet/proactive/messages?$query")
            network.openConnection(url) as HttpURLConnection
        }.getOrNull() ?: return null
        activeConnection = connection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            JSONObject(connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() })
        } catch (exception: Exception) {
            Log.i(TAG, "PROACTIVE_POLL_RETRY endpoint=${candidate.address.hostPort} reason=${exception.javaClass.simpleName}")
            null
        } finally {
            connection.disconnect()
            if (activeConnection === connection) activeConnection = null
        }
    }

    private fun consumeResponse(response: JSONObject) {
        if (!isActive()) return
        val responseCursor = response.optLong("cursor", -1L)
        val silentDelivery = response.optBoolean("silent", false)
        val messages = response.optJSONArray("messages") ?: JSONArray()
        if (!preferences.contains(ProactiveNotificationPrefs.CURSOR)) {
            if (isActive() && responseCursor >= 0L) {
                preferences.edit().putLong(ProactiveNotificationPrefs.CURSOR, responseCursor).commit()
            }
            return
        }

        val current = preferences.getLong(ProactiveNotificationPrefs.CURSOR, 0L)
        val pending = (0 until messages.length()).mapNotNull { index ->
            messages.optJSONObject(index)?.let { message ->
                message.optLong("cursor", -1L).takeIf { it > current }?.let { it to message }
            }
        }.sortedBy { it.first }
        for ((messageCursor, message) in pending) {
            if (!isActive()) return
            val step = ProactiveMessageCursor(
                preferences.getLong(ProactiveNotificationPrefs.CURSOR, 0L),
            ).receive(messageCursor, chatVisible = isChatVisible()) ?: continue
            if (!isChatVisible()) {
                if (!isActive() || !showMessage(message, messageCursor, silentDelivery)) return
            }
            if (!isActive() || !preferences.edit()
                    .putLong(ProactiveNotificationPrefs.CURSOR, step.cursor.value ?: messageCursor)
                    .commit()
            ) return
        }
        if (isActive() && responseCursor >= 0L) {
            val updated = ProactiveMessageCursor(
                preferences.getLong(ProactiveNotificationPrefs.CURSOR, 0L),
            ).advanceTo(responseCursor)
            preferences.edit().putLong(
                ProactiveNotificationPrefs.CURSOR,
                updated.value ?: responseCursor,
            ).commit()
        }
    }

    private fun showMessage(message: JSONObject, cursor: Long, silentDelivery: Boolean): Boolean {
        if (!isActive() || !notificationsAllowed(this)) return false
        val text = message.optString("text").ifBlank { "花花有新消息" }
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_CHAT
            data = Uri.parse("vcaipet://proactive/$cursor")
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            cursor.toInt(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.notification_small)
            .setContentTitle("花花")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setSilent(silentDelivery)
            .build()
        return try {
            NotificationManagerCompat.from(this).notify(
                MESSAGE_NOTIFICATION_TAG,
                cursor.toInt(),
                notification,
            )
            true
        } catch (_: SecurityException) {
            false
        }
    }

    private fun isChatVisible(): Boolean = ProactiveChatVisibility.isVisible()

    private fun isActive(): Boolean {
        return running.get() && preferences.getBoolean(ProactiveNotificationPrefs.ENABLED, false)
    }

    private fun discoverLanEndpoint(wifi: WifiNetworkSnapshot): LanAddress? {
        val candidates = WifiLanDiscovery.candidateAddresses(wifi.ipv4Address, wifi.prefixLength)
            ?: return null
        return WifiLanDiscovery.discover(candidates) { address ->
            EndpointProbe.isAvailable(
                address = address,
                connectTimeoutMs = EndpointProbe.DISCOVERY_CONNECT_TIMEOUT_MS,
                readTimeoutMs = EndpointProbe.DISCOVERY_READ_TIMEOUT_MS,
                network = wifi.network,
            )
        }
    }

    private fun rememberEndpoint(address: LanAddress, learnedLan: Boolean) {
        val editor = preferences.edit()
            .putString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, address.hostPort)
            .putString("pet_host", address.hostPort)
        if (learnedLan) editor.putString(ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT, address.hostPort)
        editor.apply()
    }

    private fun pauseBeforeRetry() {
        try {
            Thread.sleep(RETRY_DELAY_MS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun foregroundNotification(): Notification {
        return NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.notification_small)
            .setContentTitle("花花主动消息")
            .setContentText("正在接收花花的消息")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val ACTION_START = "com.vitaminc.vcaipet.companion.action.START_PROACTIVE_NOTIFICATIONS"
        private const val TAG = "ProactiveNotifications"
        private const val SERVICE_CHANNEL_ID = "proactive_service"
        private const val MESSAGE_CHANNEL_ID = "proactive_messages"
        private const val MESSAGE_NOTIFICATION_TAG = "huahua-proactive"
        private const val FOREGROUND_NOTIFICATION_ID = 7001
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val READ_TIMEOUT_MS = 35_000
        private const val RETRY_DELAY_MS = 3_000L

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(
                    SERVICE_CHANNEL_ID,
                    "花花后台连接",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    MESSAGE_CHANNEL_ID,
                    "花花主动消息",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }

        fun notificationsAllowed(context: Context): Boolean {
            if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) return false
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
            return if (Build.VERSION.SDK_INT >= 26) {
                context.getSystemService(NotificationManager::class.java)
                    .getNotificationChannel(MESSAGE_CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE
            } else {
                true
            }
        }

        fun start(context: Context) {
            val intent = Intent(context, ProactiveNotificationService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ProactiveNotificationService::class.java))
        }
    }
}
