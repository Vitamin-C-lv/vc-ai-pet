package com.vitaminc.vcaipet.companion

import android.annotation.SuppressLint
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private lateinit var petWebView: WebView
    private lateinit var connectionPanel: View
    private lateinit var connectionPrompt: TextView
    private lateinit var hostInput: EditText
    private lateinit var connectButton: Button
    private lateinit var connectionError: TextView
    private lateinit var errorActions: View
    private lateinit var retryButton: Button
    private lateinit var editAddressButton: Button

    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val connectivityManager by lazy {
        getSystemService(ConnectivityManager::class.java)
    }
    private val endpointProbeExecutor: ExecutorService by lazy { Executors.newSingleThreadExecutor() }
    private var activeEndpoint: LanAddress? = null
    private var activeEndpointNetwork: Network? = null
    private var endpointProbeGeneration = 0L
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
        connectionError = findViewById(R.id.connection_error)
        errorActions = findViewById(R.id.error_actions)
        retryButton = findViewById(R.id.retry_button)
        editAddressButton = findViewById(R.id.edit_address_button)

        configureWebView()
        configureConnectionUi()
        installBackNavigation()
        hideSystemBars()

        val settings = readEndpointSettings()
        val initialHost = settings.lastSuccessfulEndpoint?.hostPort
            ?: preferences.getString(PREFERENCE_HOST, null)
            ?: settings.lanEndpoint.hostPort
        showConnectionForm(initialHost)
        connectUsingConfiguredEndpoints(settings)
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
        retryButton.setOnClickListener {
            val address = activeEndpoint
            if (address == null || readEndpointSettings().mode == ConnectionMode.AUTO) {
                connectUsingConfiguredEndpoints()
            } else {
                loadPet(address, activeEndpointNetwork)
            }
        }
        editAddressButton.setOnClickListener {
            val settings = readEndpointSettings()
            showConnectionForm(
                activeEndpoint?.hostPort
                    ?: settings.lastSuccessfulEndpoint?.hostPort
                    ?: hostInput.text.toString().ifBlank { settings.lanEndpoint.hostPort },
            )
        }
    }

    private fun installBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (petWebView.visibility == View.VISIBLE && petWebView.canGoBack()) {
                    petWebView.goBack()
                } else {
                    finish()
                }
            }
        })
    }

    private fun connectFromInput() {
        endpointProbeGeneration += 1
        hostInput.error = null
        val address = runCatching { LanAddress.parse(hostInput.text.toString()) }.getOrNull()
        if (address == null) {
            hostInput.error = getString(R.string.invalid_address)
            return
        }
        loadPet(address, network = null)
    }

    private fun connectUsingConfiguredEndpoints(settings: EndpointSettings = readEndpointSettings()) {
        endpointProbeGeneration += 1
        val generation = endpointProbeGeneration
        endpointProbeExecutor.execute {
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
                if (generation != endpointProbeGeneration || isFinishing || isDestroyed) return@runOnUiThread
                if (selected == null) {
                    activeEndpoint = null
                    activeEndpointNetwork = null
                    showConnectionError()
                } else {
                    val network = if (selected.route == EndpointRoute.WIFI) {
                        wifiNetwork?.network
                    } else {
                        null
                    }
                    rememberSuccessfulEndpoint(selected.address, learnedLan = discovered != null)
                    loadPet(selected.address, network)
                }
            }
        }
    }

    private fun discoverLanEndpoint(wifiNetwork: WifiNetworkSnapshot): LanAddress? {
        val candidates = WifiLanDiscovery.candidateAddresses(
            address = wifiNetwork.ipv4Address,
            prefixLength = wifiNetwork.prefixLength,
        ) ?: return null
        return WifiLanDiscovery.discover(candidates) { endpoint ->
            EndpointProbe.isAvailable(
                address = endpoint,
                connectTimeoutMs = EndpointProbe.DISCOVERY_CONNECT_TIMEOUT_MS,
                readTimeoutMs = EndpointProbe.DISCOVERY_READ_TIMEOUT_MS,
                network = wifiNetwork.network,
            )
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

    private fun loadPet(address: LanAddress, network: Network? = null) {
        connectivityManager.bindProcessToNetwork(network)
        activeEndpoint = address
        activeEndpointNetwork = network
        preferences.edit()
            .putString(PREFERENCE_HOST, address.hostPort)
            .putString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, address.hostPort)
            .apply()
        petWebView.webViewClient = PetWebViewClient(address) {
            runOnUiThread {
                if (activeEndpoint == address) showConnectionError()
            }
        }
        connectionPanel.visibility = View.GONE
        petWebView.visibility = View.VISIBLE
        petWebView.loadUrl(address.url)
    }

    private fun showConnectionForm(value: String) {
        connectionPanel.visibility = View.VISIBLE
        petWebView.visibility = View.GONE
        connectionPrompt.visibility = View.VISIBLE
        hostInput.visibility = View.VISIBLE
        connectButton.visibility = View.VISIBLE
        connectionError.visibility = View.GONE
        errorActions.visibility = View.GONE
        hostInput.setText(value)
        hostInput.setSelection(hostInput.length())
    }

    private fun showConnectionError() {
        petWebView.stopLoading()
        petWebView.visibility = View.GONE
        connectionPanel.visibility = View.VISIBLE
        connectionPrompt.visibility = View.GONE
        hostInput.visibility = View.GONE
        connectButton.visibility = View.GONE
        connectionError.visibility = View.VISIBLE
        errorActions.visibility = View.VISIBLE
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
        endpointProbeExecutor.shutdownNow()
        pendingFileCallback?.onReceiveValue(null)
        pendingFileCallback = null
        if (::petWebView.isInitialized) {
            petWebView.stopLoading()
            petWebView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val PREFERENCES_NAME = "pet_connection"
        private const val PREFERENCE_HOST = "pet_host"
        private val IMAGE_MIME_TYPES = arrayOf(
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/*",
        )
    }
}
