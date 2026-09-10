package com.vitaminc.vcaipet.companion

import android.annotation.SuppressLint
import android.graphics.drawable.AnimationDrawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

class MainActivity : ComponentActivity() {
    private lateinit var petWebView: WebView
    private lateinit var connectionPanel: View
    private lateinit var connectionPrompt: TextView
    private lateinit var hostInput: EditText
    private lateinit var connectButton: Button
    private lateinit var splashOverlay: View
    private lateinit var splashAnimation: ImageView
    private lateinit var splashTitle: TextView
    private lateinit var splashSubtitle: TextView
    private lateinit var splashRetryButton: Button
    private lateinit var splashAdvancedButton: Button

    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val connectivityManager by lazy {
        getSystemService(ConnectivityManager::class.java)
    }
    private val endpointProbeExecutor: ExecutorService by lazy { Executors.newSingleThreadExecutor() }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val splashTimingCoordinator = SplashTimingCoordinator()
    private var activeEndpoint: LanAddress? = null
    private var activeEndpointNetwork: Network? = null
    private var endpointProbeGeneration = 0L
    private var activeProbeFuture: Future<*>? = null
    private var discoveryInFlightGeneration: Long? = null
    private var currentSplashAttempt: SplashTimingCoordinator.Attempt? = null
    private var attemptClosed = false
    private var nextDiscoveryRetryIndex = 0
    private var connectionUiState = ConnectionUiState.SEARCHING
    private var recoveryDeadlineRunnable: Runnable? = null
    private var discoveryRetryRunnable: Runnable? = null
    private var revealRunnable: Runnable? = null
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = pendingFileCallback ?: return@registerForActivityResult
        pendingFileCallback = null
        callback.onReceiveValue(uri?.let { arrayOf(it) })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        petWebView = findViewById(R.id.pet_webview)
        connectionPanel = findViewById(R.id.connection_panel)
        connectionPrompt = findViewById(R.id.connection_prompt)
        hostInput = findViewById(R.id.host_input)
        connectButton = findViewById(R.id.connect_button)
        splashOverlay = findViewById(R.id.splash_overlay)
        splashAnimation = findViewById(R.id.splash_animation)
        splashTitle = findViewById(R.id.splash_title)
        splashSubtitle = findViewById(R.id.splash_subtitle)
        splashRetryButton = findViewById(R.id.splash_retry_button)
        splashAdvancedButton = findViewById(R.id.splash_advanced_button)

        configureWebView()
        configureConnectionUi()
        configureSplashUi()
        installBackNavigation()
        hideSystemBars()

        startAutomaticAttempt()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        petWebView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        petWebView.overScrollMode = View.OVER_SCROLL_NEVER
        petWebView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                if (filePathCallback == null) return true
                if (pendingFileCallback != null) {
                    filePathCallback.onReceiveValue(null)
                    return true
                }

                pendingFileCallback = filePathCallback
                return try {
                    filePicker.launch(IMAGE_MIME_TYPES)
                    true
                } catch (_: IllegalStateException) {
                    pendingFileCallback = null
                    filePathCallback.onReceiveValue(null)
                    true
                }
            }
        }
    }

    private fun configureConnectionUi() {
        connectButton.setOnClickListener { connectFromInput() }
    }

    private fun configureSplashUi() {
        splashRetryButton.setOnClickListener { startAutomaticAttempt() }
        splashAdvancedButton.setOnClickListener { openAdvancedSettings() }
    }

    private fun installBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (connectionUiState == ConnectionUiState.ADVANCED_SETTINGS) {
                    showSplashFailure()
                    return
                }
                if (petWebView.visibility == View.VISIBLE && petWebView.canGoBack()) {
                    petWebView.goBack()
                } else {
                    finish()
                }
            }
        })
    }

    private fun connectFromInput() {
        hostInput.error = null
        val address = runCatching { LanAddress.parse(hostInput.text.toString()) }.getOrNull()
        if (address == null) {
            hostInput.error = getString(R.string.invalid_address)
            return
        }

        val attempt = beginAttempt()
        val network = if (LanAddress.isPrivateLanIpv4(address.host)) {
            WifiLanDiscovery.findWifiNetwork(connectivityManager)?.network
        } else {
            null
        }
        loadPet(address, network, attempt)
    }

    private fun startAutomaticAttempt() {
        val settings = readEndpointSettings()
        val attempt = beginAttempt()
        connectUsingConfiguredEndpoints(settings, attempt)
        scheduleNextDiscoveryPass(attempt)
    }

    private fun beginAttempt(): SplashTimingCoordinator.Attempt {
        cancelAttemptCallbacks()
        cancelProbeWork()
        val attempt = splashTimingCoordinator.startAttempt(SystemClock.elapsedRealtime())
        endpointProbeGeneration = attempt.generation
        currentSplashAttempt = attempt
        attemptClosed = false
        nextDiscoveryRetryIndex = 0
        connectionUiState = ConnectionUiState.SEARCHING
        showSplashSearching()
        scheduleRecoveryDeadline(attempt)
        return attempt
    }

    private fun connectUsingConfiguredEndpoints(
        settings: EndpointSettings,
        attempt: SplashTimingCoordinator.Attempt,
    ) {
        if (!isAttemptOpen(attempt) || discoveryInFlightGeneration == attempt.generation) return
        val generation = attempt.generation
        discoveryInFlightGeneration = generation
        activeProbeFuture = endpointProbeExecutor.submit {
            val wifiNetwork = WifiLanDiscovery.findWifiNetwork(connectivityManager)
            val known = settings.candidateEntries().firstOrNull { candidate ->
                if (candidate.route == EndpointRoute.WIFI && wifiNetwork == null) {
                    return@firstOrNull false
                }
                val network = if (candidate.route == EndpointRoute.WIFI) wifiNetwork?.network else null
                EndpointProbe.isAvailable(candidate.address, network = network)
            }
            val discovered = if (known == null && settings.mode != ConnectionMode.REMOTE) {
                wifiNetwork?.let(::discoverLanEndpoint)
            } else {
                null
            }
            val selected = known ?: discovered?.let {
                EndpointCandidate(it, EndpointRoute.WIFI)
            }
            runOnUiThread {
                if (discoveryInFlightGeneration == generation) {
                    discoveryInFlightGeneration = null
                    activeProbeFuture = null
                }
                if (!isAttemptOpen(attempt) || generation != endpointProbeGeneration) return@runOnUiThread
                if (selected == null) return@runOnUiThread

                val network = if (selected.route == EndpointRoute.WIFI) {
                    wifiNetwork?.network
                } else {
                    null
                }
                rememberSuccessfulEndpoint(selected.address, learnedLan = discovered != null)
                loadPet(selected.address, network, attempt)
            }
        }
    }

    private fun scheduleNextDiscoveryPass(attempt: SplashTimingCoordinator.Attempt) {
        if (!isAttemptOpen(attempt) || nextDiscoveryRetryIndex >= DISCOVERY_RETRY_OFFSETS_MS.size) {
            return
        }
        val targetElapsedMs = DISCOVERY_RETRY_OFFSETS_MS[nextDiscoveryRetryIndex]
        val elapsedMs = (SystemClock.elapsedRealtime() - attempt.startedAtMs).coerceAtLeast(0L)
        val delayMs = (targetElapsedMs - elapsedMs).coerceAtLeast(0L)
        val runnable = Runnable {
            discoveryRetryRunnable = null
            if (!isAttemptOpen(attempt)) return@Runnable
            nextDiscoveryRetryIndex += 1
            connectUsingConfiguredEndpoints(readEndpointSettings(), attempt)
            scheduleNextDiscoveryPass(attempt)
        }
        discoveryRetryRunnable = runnable
        mainHandler.postDelayed(runnable, delayMs)
    }

    private fun scheduleRecoveryDeadline(attempt: SplashTimingCoordinator.Attempt) {
        val runnable = Runnable {
            recoveryDeadlineRunnable = null
            if (!isAttemptOpen(attempt)) return@Runnable
            val remainingMs = splashTimingCoordinator.recoveryRemaining(
                attempt,
                SystemClock.elapsedRealtime(),
            )
            if (remainingMs > 0L) {
                scheduleRecoveryDeadline(attempt)
                return@Runnable
            }
            if (!splashTimingCoordinator.isRecoveryDue(attempt, SystemClock.elapsedRealtime())) {
                return@Runnable
            }
            attemptClosed = true
            endpointProbeGeneration += 1
            cancelDiscoveryAndRecoveryCallbacks()
            cancelProbeWork()
            showSplashFailure()
        }
        recoveryDeadlineRunnable = runnable
        mainHandler.postDelayed(
            runnable,
            splashTimingCoordinator.recoveryRemaining(
                attempt,
                SystemClock.elapsedRealtime(),
            ),
        )
    }

    private fun discoverLanEndpoint(wifiNetwork: WifiNetworkSnapshot): LanAddress? {
        val candidates = WifiLanDiscovery.candidateAddresses(
            address = wifiNetwork.ipv4Address,
            prefixLength = wifiNetwork.prefixLength,
        ) ?: run {
            Log.i(
                WIFI_DISCOVERY_LOG_TAG,
                "WIFI_DISCOVERY_SUBNET network=${wifiNetwork.network} " +
                    "ipv4=${wifiNetwork.ipv4Address.hostAddress}/${wifiNetwork.prefixLength} " +
                    "candidateCount=NONE",
            )
            return null
        }
        Log.i(
            WIFI_DISCOVERY_LOG_TAG,
            "WIFI_DISCOVERY_SUBNET network=${wifiNetwork.network} " +
                "ipv4=${wifiNetwork.ipv4Address.hostAddress}/${wifiNetwork.prefixLength} " +
                "candidateCount=${candidates.size}",
        )
        return WifiLanDiscovery.discover(candidates) { endpoint ->
            val available = EndpointProbe.isAvailable(
                address = endpoint,
                connectTimeoutMs = EndpointProbe.DISCOVERY_CONNECT_TIMEOUT_MS,
                readTimeoutMs = EndpointProbe.DISCOVERY_READ_TIMEOUT_MS,
                network = wifiNetwork.network,
            )
            if (available) {
                Log.i(
                    WIFI_DISCOVERY_LOG_TAG,
                    "WIFI_DISCOVERY_PROBE_PASS endpoint=${endpoint.hostPort} " +
                        "method=GET path=/api/pet/state",
                )
            }
            available
        }
    }

    private fun readEndpointSettings(): EndpointSettings {
        val lanEndpoint = readEndpoint(
            ConnectionPreferenceKeys.LAN_ENDPOINT,
            ConnectionDefaults.LAN_ENDPOINT,
        )
        val remoteEndpoint = readEndpoint(
            ConnectionPreferenceKeys.REMOTE_ENDPOINT,
            ConnectionDefaults.REMOTE_ENDPOINT,
        )
        val mode = ConnectionMode.fromPreference(
            preferences.getString(ConnectionPreferenceKeys.CONNECTION_MODE, null),
        )
        val learnedLanEndpoint = preferences.getString(
            ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT,
            null,
        )?.let { runCatching { LanAddress.parse(it) }.getOrNull() }
            ?.takeIf { LanAddress.isPrivateLanIpv4(it.host) }
        val lastSuccessfulEndpoint = listOf(
            preferences.getString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, null),
            preferences.getString(PREFERENCE_HOST, null),
        ).asSequence()
            .filterNotNull()
            .mapNotNull { runCatching { LanAddress.parse(it) }.getOrNull() }
            .firstOrNull()

        val preferenceEditor = preferences.edit()
            .putString(ConnectionPreferenceKeys.LAN_ENDPOINT, lanEndpoint.hostPort)
            .putString(ConnectionPreferenceKeys.REMOTE_ENDPOINT, remoteEndpoint.hostPort)
            .putString(ConnectionPreferenceKeys.CONNECTION_MODE, mode.name)
        if (lastSuccessfulEndpoint != null) {
            preferenceEditor.putString(
                ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT,
                lastSuccessfulEndpoint.hostPort,
            )
        }
        if (learnedLanEndpoint != null) {
            preferenceEditor.putString(
                ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT,
                learnedLanEndpoint.hostPort,
            )
        }
        preferenceEditor.apply()

        return EndpointSettings(
            lanEndpoint = lanEndpoint,
            remoteEndpoint = remoteEndpoint,
            mode = mode,
            lastSuccessfulEndpoint = lastSuccessfulEndpoint,
            learnedLanEndpoint = learnedLanEndpoint,
        )
    }

    private fun readEndpoint(key: String, fallback: String): LanAddress {
        val raw = preferences.getString(key, null) ?: fallback
        return runCatching { LanAddress.parse(raw) }
            .getOrElse { LanAddress.parse(fallback) }
    }

    private fun rememberSuccessfulEndpoint(address: LanAddress, learnedLan: Boolean = false) {
        val editor = preferences.edit()
            .putString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, address.hostPort)
            .putString(PREFERENCE_HOST, address.hostPort)
        if (learnedLan) {
            editor.putString(ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT, address.hostPort)
        }
        editor.apply()
    }

    private fun loadPet(
        address: LanAddress,
        network: Network?,
        attempt: SplashTimingCoordinator.Attempt,
    ) {
        if (!isAttemptOpen(attempt)) return
        connectivityManager.bindProcessToNetwork(network)
        activeEndpoint = address
        activeEndpointNetwork = network
        preferences.edit()
            .putString(PREFERENCE_HOST, address.hostPort)
            .putString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, address.hostPort)
            .apply()
        petWebView.webViewClient = PetWebViewClient(
            petAddress = address,
            onMainFrameReady = { onPetPageReady(attempt, address) },
            onMainFrameError = { onPetPageError(attempt, address) },
        )
        connectionPanel.visibility = View.GONE
        petWebView.visibility = View.VISIBLE
        petWebView.loadUrl(address.url)
    }

    private fun onPetPageReady(
        attempt: SplashTimingCoordinator.Attempt,
        address: LanAddress,
    ) {
        if (!isAttemptOpen(attempt) || activeEndpoint != address) return
        val decision = splashTimingCoordinator.markPageReady(
            attempt,
            SystemClock.elapsedRealtime(),
        ) ?: return
        attemptClosed = true
        endpointProbeGeneration += 1
        cancelDiscoveryAndRecoveryCallbacks()
        cancelProbeWork()
        connectionUiState = decision.state
        if (decision.revealDelayMs == 0L) {
            revealSplash(attempt)
        } else {
            val runnable = Runnable {
                revealRunnable = null
                revealSplash(attempt)
            }
            revealRunnable = runnable
            mainHandler.postDelayed(runnable, decision.revealDelayMs)
        }
    }

    private fun onPetPageError(
        attempt: SplashTimingCoordinator.Attempt,
        address: LanAddress,
    ) {
        if (!isAttemptOpen(attempt) || activeEndpoint != address) return
        petWebView.stopLoading()
        petWebView.visibility = View.GONE
    }

    private fun revealSplash(attempt: SplashTimingCoordinator.Attempt) {
        if (!isCurrentAttempt(attempt) ||
            !splashTimingCoordinator.canReveal(attempt, SystemClock.elapsedRealtime())
        ) {
            return
        }
        connectionUiState = ConnectionUiState.CONNECTED
        splashOverlay.animate().cancel()
        splashOverlay.visibility = View.VISIBLE
        splashOverlay.alpha = 1f
        splashTitle.setText(R.string.splash_found_title)
        splashSubtitle.setText(R.string.splash_found_subtitle)
        splashRetryButton.visibility = View.GONE
        splashAdvancedButton.visibility = View.GONE
        startSplashAnimation()

        val runnable = Runnable {
            revealRunnable = null
            if (!isCurrentAttempt(attempt) || connectionUiState != ConnectionUiState.CONNECTED) {
                return@Runnable
            }
            splashOverlay.animate()
                .alpha(0f)
                .setDuration(SPLASH_FADE_DURATION_MS)
                .withEndAction {
                    splashOverlay.visibility = View.GONE
                    splashOverlay.alpha = 1f
                    stopSplashAnimation()
                }
                .start()
        }
        revealRunnable = runnable
        mainHandler.postDelayed(runnable, SPLASH_FOUND_MESSAGE_MS)
    }

    private fun showSplashSearching() {
        splashOverlay.animate().cancel()
        splashOverlay.visibility = View.VISIBLE
        splashOverlay.alpha = 1f
        connectionPanel.visibility = View.GONE
        petWebView.stopLoading()
        petWebView.visibility = View.GONE
        splashTitle.setText(R.string.splash_searching_title)
        splashSubtitle.setText(R.string.splash_searching_subtitle)
        splashRetryButton.visibility = View.GONE
        splashAdvancedButton.visibility = View.GONE
        startSplashAnimation()
    }

    private fun showSplashFailure() {
        connectionUiState = ConnectionUiState.FAILED_RETRYABLE
        splashOverlay.animate().cancel()
        splashOverlay.visibility = View.VISIBLE
        splashOverlay.alpha = 1f
        connectionPanel.visibility = View.GONE
        petWebView.stopLoading()
        petWebView.visibility = View.GONE
        splashTitle.setText(R.string.splash_failed_title)
        splashSubtitle.setText(R.string.splash_failed_subtitle)
        splashRetryButton.visibility = View.VISIBLE
        splashAdvancedButton.visibility = View.VISIBLE
        startSplashAnimation()
    }

    private fun openAdvancedSettings() {
        val settings = readEndpointSettings()
        attemptClosed = true
        endpointProbeGeneration += 1
        cancelAttemptCallbacks()
        cancelProbeWork()
        splashTimingCoordinator.invalidate()
        currentSplashAttempt = null
        val value = activeEndpoint?.hostPort
            ?: settings.lastSuccessfulEndpoint?.hostPort
            ?: hostInput.text.toString().ifBlank { settings.lanEndpoint.hostPort }
        connectionUiState = ConnectionUiState.ADVANCED_SETTINGS
        showConnectionForm(value)
    }

    private fun showConnectionForm(value: String) {
        stopSplashAnimation()
        splashOverlay.animate().cancel()
        splashOverlay.visibility = View.GONE
        petWebView.stopLoading()
        petWebView.visibility = View.GONE
        connectionPanel.visibility = View.VISIBLE
        connectionPrompt.visibility = View.VISIBLE
        hostInput.visibility = View.VISIBLE
        connectButton.visibility = View.VISIBLE
        hostInput.setText(value)
        hostInput.setSelection(hostInput.length())
    }

    private fun isCurrentAttempt(attempt: SplashTimingCoordinator.Attempt): Boolean {
        return currentSplashAttempt == attempt &&
            splashTimingCoordinator.isCurrent(attempt) &&
            !isFinishing &&
            !isDestroyed
    }

    private fun isAttemptOpen(attempt: SplashTimingCoordinator.Attempt): Boolean {
        return isCurrentAttempt(attempt) && !attemptClosed
    }

    private fun cancelDiscoveryAndRecoveryCallbacks() {
        discoveryRetryRunnable?.let { mainHandler.removeCallbacks(it) }
        discoveryRetryRunnable = null
        recoveryDeadlineRunnable?.let { mainHandler.removeCallbacks(it) }
        recoveryDeadlineRunnable = null
    }

    private fun cancelAttemptCallbacks() {
        cancelDiscoveryAndRecoveryCallbacks()
        revealRunnable?.let { mainHandler.removeCallbacks(it) }
        revealRunnable = null
    }

    private fun cancelProbeWork() {
        activeProbeFuture?.cancel(true)
        activeProbeFuture = null
        discoveryInFlightGeneration = null
    }

    private fun startSplashAnimation() {
        val drawable = splashAnimation.drawable as? AnimationDrawable ?: return
        if (splashAnimation.isAttachedToWindow) {
            drawable.start()
        } else {
            splashAnimation.post { if (splashOverlay.visibility == View.VISIBLE) drawable.start() }
        }
    }

    private fun stopSplashAnimation() {
        (splashAnimation.drawable as? AnimationDrawable)?.stop()
    }

    private fun hideSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        endpointProbeGeneration += 1
        cancelAttemptCallbacks()
        cancelProbeWork()
        splashTimingCoordinator.invalidate()
        endpointProbeExecutor.shutdownNow()
        pendingFileCallback?.onReceiveValue(null)
        pendingFileCallback = null
        stopSplashAnimation()
        if (::petWebView.isInitialized) {
            petWebView.stopLoading()
            petWebView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val PREFERENCES_NAME = "pet_connection"
        private const val PREFERENCE_HOST = "pet_host"
        private const val SPLASH_FOUND_MESSAGE_MS = 300L
        private const val SPLASH_FADE_DURATION_MS = 250L
        private const val WIFI_DISCOVERY_LOG_TAG = "WifiLanDiscovery"
        private val DISCOVERY_RETRY_OFFSETS_MS = longArrayOf(4_000L, 9_000L, 14_000L)
        private val IMAGE_MIME_TYPES = arrayOf(
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/*",
        )
    }
}
