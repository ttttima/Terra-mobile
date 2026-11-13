package app.terra.browser

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.SearchManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Terra's one window. Three layers, bottom to top:
 *  - [pages]: the web pages of the tabs (only the open one shows), placed
 *    where the UI's #page-area is;
 *  - [ui]: Terra's own UI (assets/ui/phone.html), see-through where the
 *    page shows;
 *  - a video in full screen, when there is one.
 * [RootLayout] hands each touch to the page or to the UI.
 */
class MainActivity : Activity() {
    lateinit var root: RootLayout
    lateinit var pages: FrameLayout
    lateinit var ui: WebView
    lateinit var host: Host
    lateinit var tabs: Tabs
    lateinit var downloads: Downloads
    lateinit var passwords: Passwords
    lateinit var adblock: AdBlock
    lateinit var sampler: PageSampler

    val main = Handler(Looper.getMainLooper())
    var resumed = false
        private set

    /** Where the page is, in pixels; set by the UI (layout). */
    val pageRect = Rect()

    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var permissionWaiter: ((Boolean) -> Unit)? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val prefs = getSharedPreferences("terra", MODE_PRIVATE)
        val panel = prefs.getInt("panel", Color.parseColor("#191c23"))
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(panel))

        host = Host(this)
        passwords = Passwords(this)
        adblock = AdBlock(this)
        downloads = Downloads(this)
        sampler = PageSampler(this)

        root = RootLayout(this)
        pages = FrameLayout(this)
        pages.visibility = View.INVISIBLE
        root.addView(pages, FrameLayout.LayoutParams(0, 0))
        tabs = Tabs(this)

        ui = WebView(this)
        ui.setBackgroundColor(Color.TRANSPARENT)
        ui.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            setSupportZoom(false)
            mediaPlaybackRequiresUserGesture = true
        }
        // Terra's own UI stays responsive while pages are busy.
        ui.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        ui.isVerticalScrollBarEnabled = false
        ui.overScrollMode = View.OVER_SCROLL_NEVER
        ui.addJavascriptInterface(host, "TerraHost")
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        ui.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

            // Terra's own page never goes anywhere else.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ) = request.url.host != UI_HOST

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                // Everything starts again from what was saved.
                Log.w(TAG, "UI renderer gone (crash: ${detail.didCrash()})")
                main.post { recreate() }
                return true
            }
        }
        ui.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "UI: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        root.addView(ui, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(root)
        edgeToEdge(prefs.getBoolean("light", false))

        root.setOnApplyWindowInsetsListener { _, insets ->
            sendInsets(insets)
            WindowInsets.CONSUMED
        }

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { back() }
        }

        handleIntent(intent)
        ui.loadUrl("https://$UI_HOST/assets/ui/phone.html")
    }

    // ------------------------------------------------------------ window

    private fun edgeToEdge(lightBars: Boolean) {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.isNavigationBarContrastEnforced = false
        window.isStatusBarContrastEnforced = false
        window.attributes.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        setLightBars(lightBars)
    }

    /** Dark icons in the status and gesture bars on a light Terra. */
    fun setLightBars(light: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) flags else 0, flags)
        } else {
            @Suppress("DEPRECATION")
            var visibility = window.decorView.systemUiVisibility
            @Suppress("DEPRECATION")
            val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            visibility = if (light) visibility or flags else visibility and flags.inv()
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = visibility
        }
    }

    /** The app's colors from the settings, kept for the next start. */
    fun applyColors(panel: Int, light: Boolean) {
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(panel))
        setLightBars(light)
        getSharedPreferences("terra", MODE_PRIVATE).edit()
            .putInt("panel", panel)
            .putBoolean("light", light)
            .apply()
    }

    private fun sendInsets(insets: WindowInsets) {
        val density = resources.displayMetrics.density
        val bars: IntArray
        val ime: Int
        if (Build.VERSION.SDK_INT >= 30) {
            val system = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            bars = intArrayOf(system.top, system.bottom, system.left, system.right)
            ime = insets.getInsets(WindowInsets.Type.ime()).bottom
        } else {
            @Suppress("DEPRECATION")
            bars = intArrayOf(
                insets.stableInsetTop,
                insets.stableInsetBottom,
                insets.stableInsetLeft,
                insets.stableInsetRight,
            )
            @Suppress("DEPRECATION")
            ime = maxOf(0, insets.systemWindowInsetBottom - insets.stableInsetBottom)
        }
        host.send(
            "insets",
            JSONObject()
                .put("top", bars[0] / density)
                .put("bottom", bars[1] / density)
                .put("left", bars[2] / density)
                .put("right", bars[3] / density)
                .put("ime", ime / density),
        )
    }

    /** The UI says where the page goes and whether it takes the touches. */
    fun setLayout(x: Double, y: Double, width: Double, height: Double, dpr: Double, capture: Boolean) {
        val left = Math.round(x * dpr).toInt()
        val top = Math.round(y * dpr).toInt()
        val right = Math.round((x + width) * dpr).toInt()
        val bottom = Math.round((y + height) * dpr).toInt()
        pageRect.set(left, top, right, bottom)
        root.capture = capture
        val params = pages.layoutParams as FrameLayout.LayoutParams
        if (params.leftMargin != left || params.topMargin != top ||
            params.width != right - left || params.height != bottom - top
        ) {
            params.leftMargin = left
            params.topMargin = top
            params.width = maxOf(0, right - left)
            params.height = maxOf(0, bottom - top)
            pages.layoutParams = params
            sampler.soon()
        }
    }

    fun showKeyboard() {
        main.postDelayed({
            ui.requestFocus()
            getSystemService(InputMethodManager::class.java)
                ?.showSoftInput(ui, InputMethodManager.SHOW_IMPLICIT)
        }, 60)
    }

    fun hideKeyboard() {
        getSystemService(InputMethodManager::class.java)
            ?.hideSoftInputFromWindow(root.windowToken, 0)
    }

    // ------------------------------------------------------------ full screen

    fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        exitFullscreen()
        fullscreenView = view
        fullscreenCallback = callback
        view.setBackgroundColor(Color.BLACK)
        root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
        root.fullscreen = view
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
    }

    fun exitFullscreen() {
        val view = fullscreenView ?: return
        fullscreenView = null
        root.fullscreen = null
        root.removeView(view)
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.show(WindowInsets.Type.systemBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility and
                (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY).inv()
        }
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
    }

    // ------------------------------------------------------------ back

    private fun back() {
        if (fullscreenView != null) {
            exitFullscreen()
            return
        }
        if (host.ready) host.send("back", null) else moveTaskToBack(true)
    }

    @Deprecated("Android 12 and older")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT >= 33) super.onBackPressed() else back()
    }

    // ------------------------------------------------------------ links from other apps

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val urls = mutableListOf<String>()
        var text: String? = null
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.let { urls.add(it) }
            Intent.ACTION_WEB_SEARCH -> text = intent.getStringExtra(SearchManager.QUERY)
            Intent.ACTION_SEND -> {
                val shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return
                val link = Regex("https?://\\S+").find(shared)?.value
                if (link != null) urls.add(link) else text = shared
            }
            else -> return
        }
        if (urls.isEmpty() && text.isNullOrBlank()) return
        host.send(
            "open",
            JSONObject()
                .put("urls", org.json.JSONArray(urls))
                .put("text", text ?: JSONObject.NULL),
        )
    }

    // ------------------------------------------------------------ system screens

    fun chooseFiles(callback: ValueCallback<Array<Uri>>, intent: Intent) {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQUEST_FILES)
        } catch (error: Exception) {
            fileCallback = null
            callback.onReceiveValue(null)
        }
    }

    /** Asks Android for permissions a website was just allowed to use. */
    fun requestAndroidPermissions(names: Array<String>, done: (Boolean) -> Unit) {
        val missing = names.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) return done(true)
        permissionWaiter?.invoke(false)
        permissionWaiter = done
        requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        if (requestCode != REQUEST_PERMISSIONS) return
        val waiter = permissionWaiter
        permissionWaiter = null
        val results = permissions.indices.associate {
            permissions[it] to (grantResults.getOrNull(it) == PackageManager.PERMISSION_GRANTED)
        }
        // Location works with either precise or approximate.
        val granted = results.isNotEmpty() && results.all { (name, ok) ->
            ok || (name == Manifest.permission.ACCESS_FINE_LOCATION &&
                results[Manifest.permission.ACCESS_COARSE_LOCATION] == true)
        }
        waiter?.invoke(granted)
    }

    fun requestDefaultBrowser() {
        try {
            val roles = getSystemService(android.app.role.RoleManager::class.java)
            if (roles != null && roles.isRoleAvailable(android.app.role.RoleManager.ROLE_BROWSER)) {
                @Suppress("DEPRECATION")
                startActivityForResult(
                    roles.createRequestRoleIntent(android.app.role.RoleManager.ROLE_BROWSER),
                    REQUEST_ROLE,
                )
                return
            }
        } catch (_: Exception) {
        }
        openDefaultAppsSettings()
    }

    private fun openDefaultAppsSettings() {
        try {
            startActivity(Intent(android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        } catch (_: Exception) {
        }
    }

    fun importPasswords() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("text/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel"),
            )
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQUEST_PASSWORDS)
        } catch (_: Exception) {
            host.send("logins.imported", null)
        }
    }

    @Deprecated("Simple enough without the Activity Result API")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_FILES -> {
                val callback = fileCallback
                fileCallback = null
                callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            }
            REQUEST_ROLE -> {
                // Some phones say no without asking: show the settings instead.
                if (resultCode != RESULT_OK && !isDefaultBrowser()) openDefaultAppsSettings()
                host.send("default.changed", null)
            }
            REQUEST_PASSWORDS -> {
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null) {
                    host.send("logins.imported", null)
                    return
                }
                Thread {
                    val count = try {
                        val text = contentResolver.openInputStream(uri)?.use {
                            it.readBytes().toString(Charsets.UTF_8)
                        } ?: ""
                        passwords.importCsv(text)
                    } catch (_: Exception) {
                        null
                    }
                    host.send("logins.imported", count)
                    host.send("logins.changed", null)
                }.start()
            }
        }
    }

    fun isDefaultBrowser(): Boolean = try {
        getSystemService(android.app.role.RoleManager::class.java)
            ?.isRoleHeld(android.app.role.RoleManager.ROLE_BROWSER) == true
    } catch (_: Exception) {
        false
    }

    // ------------------------------------------------------------ lifecycle

    /**
     * Android is short of memory: background tabs go to sleep (they reload
     * when opened) before the system has to close Terra.
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= TRIM_MEMORY_BACKGROUND) host.send("memory", null)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        tabs.resumeAll()
        host.send("lifecycle", JSONObject().put("state", "resume"))
        sampler.soon()
    }

    override fun onPause() {
        resumed = false
        host.send("lifecycle", JSONObject().put("state", "pause"))
        tabs.pauseAll()
        android.webkit.CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        exitFullscreen()
        tabs.destroyAll()
        downloads.stop()
        ui.removeJavascriptInterface("TerraHost")
        ui.destroy()
        super.onDestroy()
    }

    companion object {
        const val TAG = "Terra"
        const val UI_HOST = "appassets.androidplatform.net"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val REQUEST_FILES = 1
        private const val REQUEST_PERMISSIONS = 2
        private const val REQUEST_ROLE = 3
        private const val REQUEST_PASSWORDS = 4
    }
}

/**
 * Hands each touch to the web page or to Terra's UI. A touch that starts on
 * the page goes to the page (all of it: scrolling, pinching), unless the UI
 * has a drawer, menu or settings open; everything else goes to the UI.
 */
class RootLayout(private val activity: MainActivity) : FrameLayout(activity) {
    var capture = true
    var fullscreen: View? = null
    private var target: View? = null

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            target = when {
                fullscreen != null -> fullscreen
                !capture && activity.pages.visibility == View.VISIBLE &&
                    activity.pageRect.contains(event.x.toInt(), event.y.toInt()) -> activity.pages
                else -> activity.ui
            }
        }
        val view = target ?: return false
        val copy = MotionEvent.obtain(event)
        copy.offsetLocation(-view.left.toFloat(), -view.top.toFloat())
        val handled = view.dispatchTouchEvent(copy)
        copy.recycle()
        if (event.actionMasked == MotionEvent.ACTION_UP ||
            event.actionMasked == MotionEvent.ACTION_CANCEL
        ) {
            target = null
        }
        return handled
    }
}
