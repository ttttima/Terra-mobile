package app.terra.browser

import android.net.Uri
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Ad and tracker blocking by domain, as on the desktop (adblock.ts): the
 * public StevenBlack hosts list, downloaded once a week and kept on the
 * phone. Only what a page loads is blocked, never the page you open, and
 * never on sites you allowed.
 */
class AdBlock(activity: MainActivity) {
    private val file = File(activity.filesDir, "adblock-hosts.txt")

    @Volatile
    private var blocked: Set<String> = STARTER

    @Volatile
    private var enabled = true

    @Volatile
    private var allowed: Set<String> = emptySet()

    init {
        Thread {
            val age = if (file.exists()) System.currentTimeMillis() - file.lastModified() else Long.MAX_VALUE
            try {
                if (file.exists()) {
                    val domains = parse(file.readText())
                    if (domains.size >= 1000) blocked = domains
                }
            } catch (_: Exception) {
            }
            if (age > REFRESH_MS) refresh()
        }.start()
    }

    fun configure(on: Boolean, allowedOrigins: JSONArray?) {
        enabled = on
        allowed = (0 until (allowedOrigins?.length() ?: 0)).map { allowedOrigins!!.getString(it) }.toSet()
    }

    private fun refresh() {
        try {
            val connection = URL(LIST_URL).openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            if (connection.responseCode != 200) return
            val text = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val domains = parse(text)
            // A real list has tens of thousands of entries; ignore broken ones.
            if (domains.size < 1000) return
            blocked = domains
            file.writeText(text)
        } catch (_: Exception) {
            // Offline: keep what we have, try again next start.
        }
    }

    private fun parse(text: String): Set<String> {
        val domains = HashSet<String>(200_000)
        val line = Regex("^\\s*(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1)\\s+([^\\s#]+)")
        for (row in text.lineSequence()) {
            val match = line.find(row) ?: continue
            val domain = match.groupValues[1].lowercase()
            if (domain != "localhost" && domain.contains('.')) domains.add(domain)
        }
        return domains
    }

    /** Is this host, or a domain it belongs to, on the list? */
    private fun listed(host: String): Boolean {
        var domain = host.lowercase()
        val list = blocked
        while (domain.contains('.')) {
            if (domain in list) return true
            domain = domain.substringAfter('.')
        }
        return false
    }

    /** Should this request, made by the page at pageUrl, be blocked? */
    fun blocks(request: Uri, pageUrl: String): Boolean {
        if (!enabled) return false
        val scheme = request.scheme
        if (scheme != "http" && scheme != "https") return false
        val host = request.host ?: return false
        if (Tabs.originOf(pageUrl) in allowed) return false
        val pageHost = Uri.parse(pageUrl).host
        // Visiting a listed site on purpose: let it load its own parts.
        if (pageHost != null && listed(pageHost)) return false
        return listed(host)
    }

    companion object {
        private const val LIST_URL = "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"
        private const val REFRESH_MS = 7L * 24 * 60 * 60 * 1000

        private val STARTER = setOf(
            "doubleclick.net", "googlesyndication.com", "googleadservices.com",
            "google-analytics.com", "googletagmanager.com", "adservice.google.com",
            "adnxs.com", "adsrvr.org", "amazon-adsystem.com", "criteo.com", "criteo.net",
            "taboola.com", "outbrain.com", "scorecardresearch.com", "quantserve.com",
            "moatads.com", "pubmatic.com", "rubiconproject.com", "openx.net",
            "casalemedia.com", "hotjar.com", "mixpanel.com", "segment.io", "facebook.net",
            "ads-twitter.com", "bat.bing.com", "adform.net", "smartadserver.com",
            "yieldmo.com", "teads.tv",
        )
    }
}
