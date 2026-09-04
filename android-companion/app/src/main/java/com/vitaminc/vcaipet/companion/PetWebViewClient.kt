package com.vitaminc.vcaipet.companion

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.Locale

class PetWebViewClient(
    private val petAddress: LanAddress,
    private val onMainFrameError: () -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        if (request?.isForMainFrame != true) return false
        return !isAllowedPetUrl(request.url, petAddress)
    }

    @Suppress("DEPRECATION")
    @Deprecated("Deprecated in Java")
    override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
        return !isAllowedPetUrl(url?.let(Uri::parse), petAddress)
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        val uri = url?.let(Uri::parse)
        if (!isAllowedPetUrl(uri, petAddress)) {
            view?.stopLoading()
            return
        }
        super.onPageStarted(view, url, favicon)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?,
    ) {
        super.onReceivedError(view, request, error)
        if (request?.isForMainFrame == true) onMainFrameError()
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?,
    ) {
        super.onReceivedHttpError(view, request, errorResponse)
        if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 0) >= 400) {
            onMainFrameError()
        }
    }
}

fun isAllowedPetUrl(uri: Uri?, address: LanAddress): Boolean {
    if (uri?.scheme?.lowercase(Locale.ROOT) != "http") return false
    if (!uri.host.equals(address.host, ignoreCase = true)) return false
    if (uri.port.let { if (it == -1) 80 else it } != address.port) return false
    return uri.encodedAuthority?.contains('@') != true
}
