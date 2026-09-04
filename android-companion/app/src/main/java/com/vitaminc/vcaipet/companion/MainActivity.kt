package com.vitaminc.vcaipet.companion

import android.annotation.SuppressLint
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
    private var petAddress: LanAddress? = null
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

        val savedHost = preferences.getString(PREFERENCE_HOST, null)
        if (savedHost.isNullOrBlank()) {
            showConnectionForm(DEFAULT_HOST)
        } else {
            val savedAddress = runCatching { LanAddress.parse(savedHost) }.getOrNull()
            if (savedAddress == null) {
                showConnectionForm(savedHost)
                hostInput.error = getString(R.string.invalid_address)
            } else {
                loadPet(savedAddress)
            }
        }
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
            val address = petAddress
            if (address == null) connectFromInput() else loadPet(address)
        }
        editAddressButton.setOnClickListener {
            showConnectionForm(petAddress?.hostPort ?: hostInput.text.toString())
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
        hostInput.error = null
        val address = runCatching { LanAddress.parse(hostInput.text.toString()) }.getOrNull()
        if (address == null) {
            hostInput.error = getString(R.string.invalid_address)
            return
        }
        loadPet(address)
    }

    private fun loadPet(address: LanAddress) {
        petAddress = address
        preferences.edit().putString(PREFERENCE_HOST, address.hostPort).apply()
        petWebView.webViewClient = PetWebViewClient(address) {
            runOnUiThread {
                if (petAddress == address) showConnectionError()
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
        pendingFileCallback?.onReceiveValue(null)
        pendingFileCallback = null
        if (::petWebView.isInitialized) {
            petWebView.stopLoading()
            petWebView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val DEFAULT_HOST = "192.168.1.129:17870"
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
