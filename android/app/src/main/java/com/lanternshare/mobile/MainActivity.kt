package com.lanternshare.mobile

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var addressField: EditText
    private lateinit var webView: WebView
    private var uploadCallback: ValueCallback<Array<Uri>>? = null
    private var currentHost: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(242, 245, 240)
        window.navigationBarColor = android.graphics.Color.rgb(242, 245, 240)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.rgb(242, 245, 240))
        }
        val heading = TextView(this).apply {
            text = "lanternshare"
            textSize = 22f
            setTextColor(android.graphics.Color.rgb(31, 75, 54))
            setPadding(dp(18), dp(14), dp(18), dp(4))
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
        }
        val hint = TextView(this).apply {
            text = "Connect to a paired host on your Wi-Fi or wired network."
            textSize = 13f
            setTextColor(android.graphics.Color.rgb(88, 107, 94))
            setPadding(dp(18), 0, dp(18), dp(10))
        }
        val addressRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(10))
        }
        addressField = EditText(this).apply {
            this.hint = "Host address (port 8787)"
            setSingleLine(true)
            textSize = 14f
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setTextColor(android.graphics.Color.rgb(32, 57, 43))
            setHintTextColor(android.graphics.Color.rgb(125, 143, 131))
            background = roundedBackground(0xFFFFFFFF.toInt(), 0xFFD6E1D7.toInt())
            layoutParams = LinearLayout.LayoutParams(0, dp(48), 1f)
        }
        val connectButton = Button(this).apply {
            text = "Connect"
            isAllCaps = false
            textSize = 14f
            setTextColor(android.graphics.Color.WHITE)
            background = roundedBackground(0xFF258763.toInt(), 0xFF258763.toInt())
            layoutParams = LinearLayout.LayoutParams(dp(98), dp(48)).apply { marginStart = dp(8) }
            setOnClickListener { connect() }
        }
        addressField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { connect(); true } else false
        }
        addressRow.addView(addressField)
        addressRow.addView(connectButton)

        webView = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            CookieManager.getInstance().setAcceptCookie(true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    val sameHost = uri.host?.equals(currentHost, ignoreCase = true) == true
                    if (sameHost) return false
                    if (uri.scheme == "http" || uri.scheme == "https") {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        return true
                    }
                    return true
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    if (request.isForMainFrame) Toast.makeText(this@MainActivity, "Could not reach that host. Check the address and same-network connection.", Toast.LENGTH_LONG).show()
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams
                ): Boolean {
                    uploadCallback?.onReceiveValue(null)
                    uploadCallback = filePathCallback
                    val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    return try {
                        startActivityForResult(picker, FILE_PICKER_REQUEST)
                        true
                    } catch (_: Exception) {
                        uploadCallback?.onReceiveValue(null)
                        uploadCallback = null
                        false
                    }
                }
            }
            setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                try {
                    val request = DownloadManager.Request(Uri.parse(url)).apply {
                        addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                        setMimeType(mimeType)
                        setTitle(contentDisposition ?: "Lantern Share download")
                        setDescription("Downloading from your local Lantern Share host")
                        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileNameFromDisposition(contentDisposition))
                    }
                    (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                    Toast.makeText(this@MainActivity, "Download started", Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Could not start the download", Toast.LENGTH_LONG).show()
                }
            })
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }

        root.addView(heading)
        root.addView(hint)
        root.addView(addressRow)
        root.addView(webView)
        setContentView(root)

        val savedAddress = getPreferences(Context.MODE_PRIVATE).getString(PREF_ADDRESS, "") ?: ""
        addressField.setText(savedAddress)
        if (savedAddress.isNotBlank()) loadHost(savedAddress)
        else showWelcome()
    }

    private fun connect() {
        val value = normalizeAddress(addressField.text.toString())
        if (value == null) {
            addressField.error = "Enter the host's local address, including :8787"
            return
        }
        addressField.setText(value)
        getPreferences(Context.MODE_PRIVATE).edit().putString(PREF_ADDRESS, value).apply()
        loadHost(value)
    }

    private fun loadHost(address: String) {
        val normalized = normalizeAddress(address) ?: return showWelcome()
        currentHost = Uri.parse(normalized).host
        webView.loadUrl(normalized)
    }

    private fun showWelcome() {
        webView.loadDataWithBaseURL(null, """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="font:16px system-ui;background:#f7f8f5;color:#20392b;padding:28px;line-height:1.5">
            <h2>Connect to your room</h2><p>Enter the local address printed by your Windows, Mac, or Linux Mint host, then tap Connect.</p>
            <p>Enter the local address printed by your Windows, Mac, or Linux Mint host.</p><p>After the room opens, enter its six-digit PIN.</p>
            </body>
        """.trimIndent(), "text/html", "UTF-8", null)
    }

    private fun normalizeAddress(raw: String): String? {
        var value = raw.trim()
        if (value.isEmpty()) return null
        if (!value.contains("://")) value = "http://$value"
        val uri = Uri.parse(value)
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        val host = uri.host?.lowercase(Locale.ROOT) ?: return null
        if (scheme !in setOf("http", "https") || uri.userInfo != null || uri.query != null || uri.fragment != null) return null
        if (uri.path?.isNotEmpty() == true && uri.path != "/") return null
        if (host == "localhost" || host == "127.0.0.1") return null
        if (!host.endsWith(".local") && !isPrivateIpv4(host)) return null
        val port = if (uri.port >= 0) uri.port else 8787
        if (port !in 1..65535) return null
        return "$scheme://$host:$port"
    }

    private fun isPrivateIpv4(host: String): Boolean {
        val pieces = host.split(".")
        if (pieces.size != 4 || pieces.any { part -> part.toIntOrNull()?.let { it !in 0..255 } ?: true }) return false
        val first = pieces[0].toInt()
        val second = pieces[1].toInt()
        return first == 10 || first == 192 && second == 168 || first == 172 && second in 16..31
    }

    private fun fileNameFromDisposition(value: String?): String {
        val raw = value?.substringAfter("filename*=UTF-8''", "")?.takeIf { it.isNotBlank() }
            ?: value?.substringAfter("filename=", "")?.trim('"')
            ?: "lantern-share-download"
        return Uri.decode(raw).substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._ -]"), "_").take(120)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_PICKER_REQUEST) return
        val callback = uploadCallback ?: return
        uploadCallback = null
        if (resultCode != RESULT_OK || data == null) { callback.onReceiveValue(null); return }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri) }
        if (uris.isEmpty()) data.data?.let(uris::add)
        callback.onReceiveValue(uris.toTypedArray())
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        uploadCallback?.onReceiveValue(null)
        uploadCallback = null
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun roundedBackground(fill: Int, stroke: Int): android.graphics.drawable.Drawable {
        return android.graphics.drawable.GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(12).toFloat()
            setStroke(dp(1), stroke)
        }
    }

    companion object {
        private const val PREF_ADDRESS = "lantern_host_address"
        private const val FILE_PICKER_REQUEST = 4812
    }
}
