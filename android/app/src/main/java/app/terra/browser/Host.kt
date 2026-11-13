package app.terra.browser

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.util.Log
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * The bridge to Terra's UI page (src/phone/host.ts). The UI decides
 * (brain.ts); this does what needs Android: web pages, files, passwords,
 * downloads. Commands come in through [post] and [call]; events go out
 * through [send].
 */
class Host(private val activity: MainActivity) {
    /** The UI listens: events go straight to it (before, they wait). */
    @Volatile
    var ready = false
        private set
    private val waiting = mutableListOf<String>()
    private val io = Executors.newSingleThreadExecutor()
    private val network = Executors.newFixedThreadPool(2)
    private val files = File(activity.filesDir, "terra").apply { mkdirs() }

    // ------------------------------------------------------------ to the UI

    fun send(type: String, data: Any?) {
        val message = JSONObject().put("type", type).put("data", data ?: JSONObject.NULL).toString()
        activity.main.post {
            if (!ready) {
                waiting.add(message)
                return@post
            }
            deliver(message)
        }
    }

    private fun deliver(message: String) {
        activity.ui.evaluateJavascript(
            "window.terraNative&&terraNative.receive(${JSONObject.quote(message)})",
            null,
        )
    }

    fun tabEvent(id: Int, kind: String, data: JSONObject = JSONObject()) {
        send("tab", data.put("id", id).put("kind", kind))
    }

    // ------------------------------------------------------------ from the UI

    @JavascriptInterface
    fun post(message: String) {
        activity.main.post {
            try {
                val json = JSONObject(message)
                handle(json.getString("type"), json.optJSONObject("data") ?: JSONObject())
            } catch (error: Exception) {
                Log.e(MainActivity.TAG, "Command failed: $message", error)
            }
        }
    }

    @JavascriptInterface
    fun call(message: String): String = try {
        val json = JSONObject(message)
        answer(json.getString("type"), json.optJSONObject("data") ?: JSONObject())
    } catch (error: Exception) {
        Log.e(MainActivity.TAG, "Call failed: $message", error)
        ""
    }

    private fun safeFile(name: String): File? =
        if (Regex("^[a-z0-9-]+\\.json$").matches(name)) File(files, name) else null

    /** Questions the UI waits for (on a binder thread, not the main one). */
    private fun answer(type: String, data: JSONObject): String = when (type) {
        "fs.read" -> {
            val file = safeFile(data.getString("name"))
            if (file != null && file.exists()) JSONObject.quote(file.readText()) else "null"
        }
        "app.info" -> JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("privateIsolated", Tabs.privateSupported())
            .toString()
        "logins.list" -> JSONObject()
            .put("available", passwords().available)
            .put("logins", passwords().list())
            .toString()
        "logins.for" -> passwords().loginsFor(data.getString("origin")).toString()
        "login.reveal" -> passwords().reveal(data.getString("id"))?.let { JSONObject.quote(it) } ?: "null"
        "login.delete" -> {
            passwords().delete(data.getString("id"))
            "true"
        }
        "default.get" -> JSONObject()
            .put("supported", true)
            .put("isDefault", activity.isDefaultBrowser())
            .toString()
        else -> ""
    }

    private fun passwords() = activity.passwords

    private fun handle(type: String, data: JSONObject) {
        val tabs = activity.tabs
        when (type) {
            "ui.ready" -> {
                if (!ready) {
                    ready = true
                    waiting.forEach(::deliver)
                    waiting.clear()
                    activity.root.requestApplyInsets()
                }
            }
            "ui.painted" -> Unit
            "fs.write" -> {
                val file = safeFile(data.getString("name")) ?: return
                val text = data.getString("text")
                io.execute {
                    // Written next to it first, so a crash never leaves half a file.
                    val temp = File(file.parentFile, "${file.name}.tmp")
                    temp.writeText(text)
                    temp.renameTo(file)
                }
            }
            "config" -> {
                tabs.configure(data)
                activity.adblock.configure(data.optBoolean("blockAds", true), data.optJSONArray("allowAds"))
                activity.sampler.configure(data.optBoolean("pageColors"), data.optBoolean("pageEdges"))
                activity.applyColors(
                    android.graphics.Color.parseColor(data.optString("panel", "#191c23")),
                    data.optString("theme") == "light",
                )
            }
            "layout" -> activity.setLayout(
                data.getDouble("x"),
                data.getDouble("y"),
                data.getDouble("width"),
                data.getDouble("height"),
                data.optDouble("dpr", 1.0),
                data.optBoolean("capture", true),
            )
            "tab.load" -> tabs.load(
                data.getInt("id"),
                data.getString("url"),
                data.optBoolean("private"),
                data.optBoolean("desktop"),
                data.optInt("textZoom", 100),
            )
            "tab.close" -> tabs.close(data.getInt("id"))
            "tab.show" -> tabs.show(if (data.isNull("id")) null else data.getInt("id"))
            "tab.back" -> tabs.get(data)?.view?.goBack()
            "tab.forward" -> tabs.get(data)?.view?.goForward()
            "tab.reload" -> tabs.get(data)?.let { tabs.reload(it) }
            "tab.stop" -> tabs.get(data)?.view?.stopLoading()
            "tab.find" -> tabs.get(data)?.let {
                if (data.optBoolean("newSearch")) it.view.findAllAsync(data.getString("text"))
                else it.view.findNext(data.optBoolean("forward", true))
            }
            "tab.findStop" -> tabs.get(data)?.view?.clearMatches()
            "tab.textZoom" -> tabs.get(data)?.view?.settings?.textZoom = data.getInt("percent")
            "tab.desktop" -> tabs.get(data)?.let { tabs.setDesktop(it, data.getBoolean("on")) }
            "tab.mute" -> tabs.get(data)?.let { tabs.setMuted(it, data.getBoolean("on")) }
            "tab.print" -> tabs.get(data)?.let { tabs.print(it, data.optString("title")) }
            "tab.fill" -> tabs.get(data)?.let {
                tabs.fill(it, data.getString("loginId"), data.getString("origin"))
            }
            "permission.answer" -> tabs.answerPermission(data.getInt("id"), data.getBoolean("allow"))
            "auth.answer" -> tabs.answerAuth(
                data.getInt("id"),
                data.optBoolean("ok"),
                data.optString("username"),
                data.optString("password"),
            )
            "external.open" -> tabs.openExternal(data.getString("url"))
            "download.url" -> activity.downloads.startLink(
                data.getString("url"),
                data.optString("page"),
                data.optBoolean("private"),
            )
            "download.action" -> activity.downloads.action(data.optString("id"), data.getString("action"))
            "downloads.clear" -> activity.downloads.clear()
            "share" -> share(data.getString("url"), data.optString("title"))
            "clipboard" -> {
                activity.getSystemService(ClipboardManager::class.java)
                    ?.setPrimaryClip(ClipData.newPlainText("Link", data.getString("text")))
            }
            "default.request" -> activity.requestDefaultBrowser()
            "data.clear" -> clearData()
            "site.clear" -> clearSite(data.getString("origin"))
            "private.clear" -> tabs.clearPrivate()
            "logins.import" -> activity.importPasswords()
            "login.save" -> {
                if (passwords().savePending(data.getString("token"))) send("logins.changed", null)
            }
            "update.check" -> network.execute { send("update.result", Updater.check()) }
            "update.install" -> activity.downloads.startUpdate(data.getString("url"))
            "fetch" -> {
                val id = data.getInt("id")
                val url = data.getString("url")
                network.execute { send("fetch.result", JSONObject().put("id", id).put("text", fetch(url))) }
            }
            "keyboard.show" -> activity.showKeyboard()
            "keyboard.hide" -> activity.hideKeyboard()
            "app.minimize" -> activity.moveTaskToBack(true)
            else -> Log.w(MainActivity.TAG, "Unknown command $type")
        }
    }

    // ------------------------------------------------------------ helpers

    private fun share(url: String, title: String) {
        val intent = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, url)
        if (title.isNotBlank()) intent.putExtra(Intent.EXTRA_SUBJECT, title)
        activity.startActivity(Intent.createChooser(intent, null))
    }

    /** Search suggestions: a small GET without cookies. */
    private fun fetch(url: String): String? = try {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 1500
        connection.readTimeout = 1500
        connection.setRequestProperty("Accept", "application/json")
        connection.useCaches = false
        if (connection.responseCode in 200..299) {
            connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } else {
            null
        }
    } catch (_: Exception) {
        null
    }

    /** Settings > Clear browsing data: cookies, site storage and cache. */
    private fun clearData() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        GeolocationPermissions.getInstance().clearAll()
        val any = activity.tabs.anyView()
        if (any != null) {
            any.clearCache(true)
        } else {
            WebView(activity).apply {
                clearCache(true)
                destroy()
            }
        }
        @Suppress("DEPRECATION")
        android.webkit.WebViewDatabase.getInstance(activity).clearHttpAuthUsernamePassword()
    }

    /** "Delete cookies and data for this site". */
    private fun clearSite(origin: String) {
        WebStorage.getInstance().deleteOrigin(origin)
        val cookies = CookieManager.getInstance()
        val host = android.net.Uri.parse(origin).host ?: return
        val names = (cookies.getCookie(origin) ?: "").split(";")
            .mapNotNull { it.substringBefore('=').trim().takeIf(String::isNotEmpty) }
        val domains = mutableListOf(host)
        var domain = host
        while (domain.count { it == '.' } > 1) {
            domain = domain.substringAfter('.')
            domains.add(domain)
        }
        for (name in names) {
            cookies.setCookie(origin, "$name=; Max-Age=0; Path=/")
            for (d in domains) {
                cookies.setCookie(origin, "$name=; Max-Age=0; Path=/; Domain=$d")
                cookies.setCookie(origin, "$name=; Max-Age=0; Path=/; Domain=.$d")
            }
        }
        cookies.flush()
        Toast.makeText(activity, "Deleted data for $host", Toast.LENGTH_SHORT).show()
    }

    fun toJson(list: List<JSONObject>) = JSONArray(list)
}
