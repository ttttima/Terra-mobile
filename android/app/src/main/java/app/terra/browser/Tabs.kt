package app.terra.browser

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.util.Base64
import android.view.ContextThemeWrapper
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** One tab's web page. */
class Tab(val id: Int, val view: WebView, val private: Boolean) {
    /** The page's address, read by the ad blocker on another thread. */
    @Volatile
    var pageUrl = ""
    /** Showing our error page for this address. */
    var failedUrl: String? = null
    var desktop = false
    var muted = false
    /** Frames playing sound, and every frame's line back to it. */
    val audibleFrames = mutableSetOf<String>()
    /** Its page runs (timers, animations): when shown, or while it plays sound. */
    var running = true
    val frames = mutableSetOf<JavaScriptReplyProxy>()
}

/**
 * The tabs' web pages: one WebView each, made when a tab first loads
 * something. Only the open tab's page is shown (in [MainActivity.pages]).
 * Everything that happens in a page goes to the UI as a "tab" event.
 */
class Tabs(private val activity: MainActivity) {
    private val tabs = HashMap<Int, Tab>()
    private var shown: Tab? = null
    private var nextPopupId = 1_000_000
    private val host get() = activity.host

    // Settings that matter here (see brain.ts sendConfig).
    private var theme = "dark"
    private var background = Color.parseColor("#111318")
    private var forceDark = false

    private val mobileAgent: String by lazy {
        WebSettings.getDefaultUserAgent(activity)
            .replace("; wv)", ")")
            .replace(Regex("Version/\\d+\\.\\d+ "), "")
    }
    private val desktopAgent: String by lazy {
        val chrome = Regex("Chrome/[\\d.]+").find(mobileAgent)?.value ?: "Chrome/130.0.0.0"
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36"
    }

    fun get(data: JSONObject): Tab? = tabs[data.optInt("id", -1)]

    fun anyView(): WebView? = tabs.values.firstOrNull()?.view

    // ------------------------------------------------------------ settings

    fun configure(config: JSONObject) {
        theme = config.optString("theme", "dark")
        background = try {
            Color.parseColor(config.optString("background", "#111318"))
        } catch (_: Exception) {
            Color.BLACK
        }
        forceDark = config.optBoolean("forceDark")
        for (tab in tabs.values) {
            tab.view.setBackgroundColor(pageBackground())
            setDarkening(tab.view)
        }
    }

    /** Before a page paints: the color mode's background, never a white flash. */
    private fun pageBackground() = if (forceDark) Color.parseColor("#0a0a0a") else background

    /** Pages see Terra's color mode (prefers-color-scheme), from their theme. */
    private fun darkPages() = forceDark || theme != "light"

    private fun setDarkening(view: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, forceDark)
        }
    }

    // ------------------------------------------------------------ making pages

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(id: Int, private: Boolean): Tab {
        val context = ContextThemeWrapper(
            activity,
            if (darkPages()) R.style.Theme_Terra_PageDark else R.style.Theme_Terra_PageLight,
        )
        val view = WebView(context)
        if (private && privateSupported()) {
            ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
            WebViewCompat.setProfile(view, PRIVATE_PROFILE)
        }
        val tab = Tab(id, view, private)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportZoom(true)
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = mobileAgent
            if (private) cacheMode = WebSettings.LOAD_DEFAULT
        }
        setDarkening(view)
        cookiesFor(tab).setAcceptThirdPartyCookies(view, true)
        view.setBackgroundColor(pageBackground())
        view.isFocusable = true
        view.isFocusableInTouchMode = true

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "terraPage", setOf("*")) { _, message, origin, isMainFrame, reply ->
                onPageMessage(tab, message.data ?: return@addWebMessageListener, origin.toString(), isMainFrame, reply)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, PageScripts.SCRIPT, setOf("*"))
        }

        view.webViewClient = PageClient(tab)
        view.webChromeClient = PageChrome(tab)
        view.setDownloadListener { url, agent, disposition, mime, length ->
            activity.downloads.start(url, agent, disposition, mime, length, tab.pageUrl, tab.private)
            // A link that only downloads leaves an empty new tab: close it.
            if (view.url == null || view.url == "about:blank") {
                if (!view.canGoBack()) host.tabEvent(tab.id, "closed")
            }
        }
        view.setFindListener { active, total, done ->
            if (done) {
                host.tabEvent(
                    tab.id,
                    "find",
                    JSONObject().put("active", if (total > 0) active + 1 else 0).put("total", total),
                )
            }
        }
        view.setOnLongClickListener { longPress(tab) }

        view.visibility = View.GONE
        activity.pages.addView(view, FrameLayout.LayoutParams(MainActivity.MATCH, MainActivity.MATCH))
        tabs[id] = tab
        return tab
    }

    private fun cookiesFor(tab: Tab): CookieManager =
        if (tab.private && privateSupported()) {
            ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE).cookieManager
        } else {
            CookieManager.getInstance()
        }

    fun load(id: Int, url: String, private: Boolean, desktop: Boolean) {
        val tab = tabs[id] ?: create(id, private)
        if (desktop != tab.desktop) setDesktop(tab, desktop, reload = false)
        tab.failedUrl = null
        tab.pageUrl = url
        tab.view.loadUrl(url)
        updateRunning(tab)
        if (shown == tab) tab.view.requestFocus()
    }

    fun close(id: Int) {
        val tab = tabs.remove(id) ?: return
        if (shown == tab) shown = null
        if (leaving == tab.view) leaving = null
        tab.view.animate().cancel()
        tab.view.stopLoading()
        tab.view.webChromeClient = null
        activity.pages.removeView(tab.view)
        tab.view.destroy()
        updatePagesVisibility()
    }

    fun destroyAll() {
        for (id in tabs.keys.toList()) close(id)
    }

    fun pauseAll() = tabs.values.forEach { it.view.onPause() }

    fun resumeAll() = tabs.values.forEach { if (it.running) it.view.onResume() }

    /**
     * Hidden pages stop their timers and animations (unless they play
     * sound), so the shown page and the UI get the phone to themselves; the
     * shown page also draws ahead off screen, so scrolling stays smooth.
     */
    private fun updateRunning(tab: Tab) {
        val run = tab == shown || tab.audibleFrames.isNotEmpty()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.OFF_SCREEN_PRERASTER)) {
            WebSettingsCompat.setOffscreenPreRaster(tab.view.settings, tab == shown)
        }
        if (run == tab.running) return
        tab.running = run
        if (!activity.resumed) return
        if (run) tab.view.onResume() else tab.view.onPause()
    }

    /** Shows one tab's page (or none: new tab page, settings). */
    /**
     * Shows one tab's page (or none: new tab page, settings). `from` is the
     * side it comes in from when tabs are swiped through: 1 the right, -1
     * the left, 0 no side (it's simply there).
     */
    fun show(id: Int?, from: Int = 0) {
        val next = id?.let { tabs[it] }
        if (next != shown) {
            val previous = shown
            val hadFocus = shown?.view?.hasFocus() == true
            shown = next
            change(previous?.view, next?.view, from)
            previous?.let { updateRunning(it) }
            next?.let { updateRunning(it) }
            if (hadFocus) activity.hideKeyboard()
        }
        updatePagesVisibility()
        activity.sampler.soon()
    }

    /** The page on its way out while the next one slides over it. */
    private var leaving: WebView? = null

    private fun rest(view: WebView) {
        view.animate().cancel()
        view.translationX = 0f
        view.alpha = 1f
    }

    /**
     * One page gives way to another. Swiped through, the pages are
     * neighbors: the new one comes in from the side the finger pulled it
     * from and pushes the old one out the other, both solid, on the same
     * spring as the UI. Otherwise the new page is there at once. Turning
     * animations off in Android's settings makes it instant too.
     */
    private fun change(out: WebView?, into: WebView?, from: Int) {
        leaving?.let {
            rest(it)
            if (it != into) it.visibility = View.GONE
        }
        leaving = null
        into?.let {
            rest(it)
            it.visibility = View.VISIBLE
        }
        if (out == null || into == null || from == 0 || !activity.resumed) {
            out?.visibility = View.GONE
            return
        }
        val shift = from * activity.pages.width * SLIDE
        leaving = out
        into.bringToFront()
        into.translationX = shift
        into.animate().translationX(0f)
            .setDuration(SLIDE_MS).setInterpolator(SPRING).withLayer().start()
        out.animate().translationX(-shift)
            .setDuration(SLIDE_MS).setInterpolator(SPRING).withLayer()
            .withEndAction {
                if (leaving == out) {
                    leaving = null
                    out.visibility = View.GONE
                    out.translationX = 0f
                }
            }.start()
    }

    private fun updatePagesVisibility() {
        activity.pages.visibility = if (shown != null) View.VISIBLE else View.INVISIBLE
    }

    fun shownView(): WebView? = shown?.view

    fun reload(tab: Tab) {
        val failed = tab.failedUrl
        if (failed != null) {
            tab.failedUrl = null
            tab.view.loadUrl(failed)
        } else {
            tab.view.reload()
        }
    }

    fun setDesktop(tab: Tab, on: Boolean, reload: Boolean = true) {
        tab.desktop = on
        tab.view.settings.userAgentString = if (on) desktopAgent else mobileAgent
        tab.view.settings.loadWithOverviewMode = true
        tab.view.settings.useWideViewPort = true
        if (reload) reload(tab)
    }

    fun setMuted(tab: Tab, on: Boolean) {
        tab.muted = on
        val message = JSONObject().put("type", "mute").put("on", on).toString()
        for (frame in tab.frames) {
            try {
                frame.postMessage(message)
            } catch (_: Exception) {
            }
        }
    }

    /** "Fill in" in the question bar: the saved login goes into the page. */
    fun fill(tab: Tab, loginId: String, origin: String) {
        if (originOf(tab.view.url ?: "") != origin) return
        val login = activity.passwords.login(loginId) ?: return
        if (login.origin != origin) return
        val password = activity.passwords.reveal(loginId) ?: return
        tab.view.evaluateJavascript(
            "window.__terraFill&&__terraFill(${JSONObject.quote(login.username)},${JSONObject.quote(password)})",
            null,
        )
    }

    /** The last private tab closed: forget everything it did. */
    fun clearPrivate() {
        if (!privateSupported()) return
        try {
            val profile = ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
            profile.cookieManager.removeAllCookies(null)
            profile.webStorage.deleteAllData()
            profile.geolocationPermissions.clearAll()
        } catch (_: Exception) {
        }
        // Its cache too, once no page uses it any more.
        activity.main.postDelayed({
            if (tabs.values.none { it.private }) {
                try {
                    ProfileStore.getInstance().deleteProfile(PRIVATE_PROFILE)
                } catch (_: Exception) {
                }
            }
        }, 1500)
    }

    // ------------------------------------------------------------ page messages

    /** What the page script (PageScripts) says. */
    private fun onPageMessage(
        tab: Tab,
        text: String,
        origin: String,
        isMainFrame: Boolean,
        reply: JavaScriptReplyProxy,
    ) {
        val message = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        val frame = message.optString("frame")
        when (message.optString("type")) {
            "hello" -> {
                tab.frames.add(reply)
                if (tab.muted) {
                    reply.postMessage(JSONObject().put("type", "mute").put("on", true).toString())
                }
            }
            "audible" -> {
                val before = tab.audibleFrames.isNotEmpty()
                if (message.optBoolean("on")) tab.audibleFrames.add(frame) else tab.audibleFrames.remove(frame)
                val now = tab.audibleFrames.isNotEmpty()
                if (now != before) host.tabEvent(tab.id, "audible", JSONObject().put("on", now))
                if (now != before) updateRunning(tab)
            }
            "loginForm" -> if (isMainFrame && origin.startsWith("http")) {
                host.tabEvent(tab.id, "loginForm", JSONObject().put("origin", origin))
            }
            "loginSubmitted" -> if (isMainFrame && origin.startsWith("http") && !tab.private) {
                val username = message.optString("username")
                val password = message.optString("password")
                if (password.isEmpty()) return
                val passwords = activity.passwords
                val token = passwords.remember(origin, username, password)
                host.tabEvent(
                    tab.id,
                    "loginSubmitted",
                    JSONObject()
                        .put("origin", origin)
                        .put("username", username)
                        .put("token", token)
                        .put("saved", passwords.isSaved(origin, username, password))
                        .put("update", passwords.hasUser(origin, username)),
                )
            }
        }
    }

    // ------------------------------------------------------------ long press

    private fun longPress(tab: Tab): Boolean {
        val hit = tab.view.hitTestResult
        val type = hit.type
        if (type != WebView.HitTestResult.SRC_ANCHOR_TYPE &&
            type != WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE &&
            type != WebView.HitTestResult.IMAGE_TYPE
        ) {
            return false
        }
        tab.view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        val extra = hit.extra ?: ""
        if (type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
            // The image is known; ask the page for the link around it.
            val handler = android.os.Handler(android.os.Looper.getMainLooper()) { message ->
                val link = message.data.getString("url") ?: ""
                host.tabEvent(tab.id, "context", JSONObject().put("link", link).put("image", extra))
                true
            }
            tab.view.requestFocusNodeHref(handler.obtainMessage())
        } else {
            val isLink = type == WebView.HitTestResult.SRC_ANCHOR_TYPE
            host.tabEvent(
                tab.id,
                "context",
                JSONObject().put("link", if (isLink) extra else "").put("image", if (isLink) "" else extra),
            )
        }
        return true
    }

    // ------------------------------------------------------------ other apps

    /** A link for another app (mail, phone, maps, intent:...). */
    private fun outsideLink(tab: Tab, url: String) {
        val scheme = Uri.parse(url).scheme?.lowercase() ?: return
        if (scheme in listOf("mailto", "tel", "sms", "geo")) {
            openExternal(url)
            return
        }
        var app = ""
        if (scheme == "intent") {
            val intent = try {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            } catch (_: Exception) {
                return
            }
            val resolved = activity.packageManager.resolveActivity(intent, 0)
            if (resolved == null) {
                // No app for it: the page's own fallback, if it has one.
                val fallback = intent.getStringExtra("browser_fallback_url")
                if (fallback != null && fallback.startsWith("http")) tab.view.loadUrl(fallback)
                return
            }
            app = resolved.loadLabel(activity.packageManager).toString()
        }
        host.tabEvent(tab.id, "external", JSONObject().put("url", url).put("scheme", scheme).put("app", app))
    }

    fun openExternal(url: String) {
        val intent = if (url.startsWith("intent:", ignoreCase = true)) {
            try {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } catch (_: Exception) {
                return
            }
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            activity.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            android.widget.Toast.makeText(activity, "No app can open this link", android.widget.Toast.LENGTH_SHORT).show()
        } catch (_: SecurityException) {
        }
    }

    // ------------------------------------------------------------ questions

    private var nextRequest = 1
    private val permissionRequests = HashMap<Int, (Boolean) -> Unit>()
    private val authRequests = HashMap<Int, HttpAuthHandler>()

    fun answerPermission(id: Int, allow: Boolean) {
        permissionRequests.remove(id)?.invoke(allow)
    }

    fun answerAuth(id: Int, ok: Boolean, username: String, password: String) {
        val handler = authRequests.remove(id) ?: return
        if (ok) handler.proceed(username, password) else handler.cancel()
    }

    private fun askPermission(tab: Tab, origin: String, names: List<String>, done: (Boolean) -> Unit) {
        val id = nextRequest++
        permissionRequests[id] = done
        host.tabEvent(
            tab.id,
            "permission",
            JSONObject().put("reqId", id).put("origin", origin).put("names", org.json.JSONArray(names)),
        )
    }

    // ------------------------------------------------------------ page events

    private fun state(tab: Tab, url: String? = tab.view.url) = JSONObject()
        .put("url", tab.failedUrl ?: url ?: "")
        .put("back", tab.view.canGoBack())
        .put("forward", tab.view.canGoForward())

    private fun errorPage(tab: Tab, url: String, title: String, description: String) {
        tab.failedUrl = url
        val dark = darkPages()
        val html = PageScripts.errorPage(title, url, description, dark)
        tab.view.loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
        host.tabEvent(tab.id, "failed", state(tab, url).put("loading", false))
    }

    private inner class PageClient(val tab: Tab) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            val scheme = request.url.scheme?.lowercase() ?: return false
            if (scheme in listOf("http", "https", "about", "data", "blob", "javascript", "file")) {
                return false
            }
            if (request.isForMainFrame || request.hasGesture()) outsideLink(tab, url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (tab.failedUrl != null && url != tab.failedUrl) tab.failedUrl = null
            tab.pageUrl = url
            tab.audibleFrames.clear()
            tab.frames.clear()
            updateRunning(tab)
            if (tab.failedUrl == null) host.tabEvent(tab.id, "started", state(tab, url).put("loading", true))
        }

        override fun onPageFinished(view: WebView, url: String) {
            host.tabEvent(tab.id, "finished", state(tab, url).put("loading", false))
            if (tab == shown) activity.sampler.soon()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.pageUrl = url
            if (tab.failedUrl != null) return
            host.tabEvent(tab.id, "visited", state(tab, url))
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            if (error.errorCode == ERROR_UNSUPPORTED_SCHEME) return
            errorPage(tab, request.url.toString(), "Can't reach this page", error.description.toString())
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (error.url == tab.pageUrl) {
                errorPage(
                    tab,
                    error.url,
                    "This connection isn't private",
                    "The site's security certificate isn't trusted, so Terra didn't open it.",
                )
            }
        }

        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
            val id = nextRequest++
            authRequests[id] = handler
            this@Tabs.host.tabEvent(tab.id, "auth", JSONObject().put("reqId", id).put("host", host).put("realm", realm))
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame) return null
            return if (activity.adblock.blocks(request.url, tab.pageUrl)) BLOCKED() else null
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val id = tab.id
            activity.main.post {
                close(id)
                host.tabEvent(id, "crashed")
            }
            return true
        }
    }

    private inner class PageChrome(val tab: Tab) : WebChromeClient() {
        override fun onProgressChanged(view: WebView, progress: Int) {
            host.tabEvent(tab.id, "progress", JSONObject().put("progress", progress))
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (title.isNullOrBlank() || title == view.url) return
            if (tab.failedUrl != null) return
            host.tabEvent(tab.id, "title", JSONObject().put("title", title))
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            icon ?: return
            val size = 32
            val scaled = Bitmap.createScaledBitmap(icon, size, size, true)
            val bytes = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.PNG, 100, bytes)
            val data = "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
            host.tabEvent(tab.id, "favicon", JSONObject().put("favicon", data))
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            // Pop-ups only when the person asked for them (a tap).
            if (!isUserGesture) return false
            val popup = create(nextPopupId++, tab.private)
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = popup.view
            resultMsg.sendToTarget()
            host.tabEvent(popup.id, "popup", JSONObject().put("openerId", tab.id).put("background", false))
            return true
        }

        override fun onCloseWindow(window: WebView) {
            host.tabEvent(tab.id, "closed")
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            activity.enterFullscreen(view, callback)
            host.tabEvent(tab.id, "fullscreen", JSONObject().put("on", true))
        }

        override fun onHideCustomView() {
            activity.exitFullscreen()
            host.tabEvent(tab.id, "fullscreen", JSONObject().put("on", false))
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            activity.main.post {
                val resources = request.resources.toList()
                // Protected video and music (DRM) is allowed, as on the desktop.
                if (resources.all { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }) {
                    request.grant(request.resources)
                    return@post
                }
                val names = mutableListOf<String>()
                val android = mutableListOf<String>()
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in resources) {
                    names.add("camera")
                    android.add(Manifest.permission.CAMERA)
                }
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in resources) {
                    names.add("microphone")
                    android.add(Manifest.permission.RECORD_AUDIO)
                }
                if (PermissionRequest.RESOURCE_MIDI_SYSEX in resources) names.add("midi")
                if (names.isEmpty()) {
                    request.deny()
                    return@post
                }
                askPermission(tab, originOf(request.origin.toString()), names) { allow ->
                    if (!allow) return@askPermission request.deny()
                    activity.requestAndroidPermissions(android.toTypedArray()) { granted ->
                        if (granted) request.grant(request.resources) else request.deny()
                    }
                }
            }
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            askPermission(tab, originOf(origin), listOf("geolocation")) { allow ->
                if (!allow) return@askPermission callback.invoke(origin, false, false)
                activity.requestAndroidPermissions(
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                ) { granted -> callback.invoke(origin, granted, false) }
            }
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            val intent = params.createIntent()
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            activity.chooseFiles(callback, intent)
            return true
        }

        // No grey play button on videos without a picture of their own.
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    companion object {
        private const val PRIVATE_PROFILE = "terra-private"

        /** How far a page slides between tabs: its whole width. */
        private const val SLIDE = 1f
        private const val SLIDE_MS = 420L

        /**
         * The UI's spring (motion.ts: settles without overshoot) as an
         * Android interpolator, so pages move like everything else.
         */
        private val SPRING = android.view.animation.Interpolator { t ->
            val x = 9f * t
            1f - (1f + x) * kotlin.math.exp(-x)
        }

        fun privateSupported() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

        @Suppress("FunctionName")
        private fun BLOCKED() =
            WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        /** "https://example.com" for an address, or "" when it has none. */
        fun originOf(url: String): String {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase() ?: return ""
            if (scheme != "http" && scheme != "https") return ""
            val host = uri.host ?: return ""
            val port = if (uri.port != -1) ":${uri.port}" else ""
            return "$scheme://$host$port"
        }
    }
}
