package app.terra.browser

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * New versions come from Terra-mobile's GitHub releases: the newest release
 * (previews included, like the desktop's updater.ts) with an .apk in it,
 * when it is newer than this one.
 */
object Updater {
    private const val RELEASES = "https://api.github.com/repos/ttttima/Terra-mobile/releases"

    /** {version, url} of a newer Terra for Android, or null. */
    fun check(): JSONObject? = try {
        val connection = URL(RELEASES).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.setRequestProperty("Accept", "application/vnd.github+json")
        connection.setRequestProperty("User-Agent", "Terra")
        if (connection.responseCode != 200) {
            null
        } else {
            val releases = JSONArray(connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) })
            var found: JSONObject? = null
            for (i in 0 until releases.length()) {
                val release = releases.getJSONObject(i)
                if (release.optBoolean("draft")) continue
                val url = apkOf(release) ?: continue
                val version = release.optString("tag_name").removePrefix("v")
                if (newer(version, BuildConfig.VERSION_NAME)) {
                    found = JSONObject().put("version", version).put("url", url)
                }
                break
            }
            found
        }
    } catch (_: Exception) {
        null
    }

    private fun apkOf(release: JSONObject): String? {
        val assets = release.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val asset = assets.getJSONObject(i)
            if (asset.optString("name").endsWith(".apk", ignoreCase = true)) {
                return asset.optString("browser_download_url")
            }
        }
        return null
    }

    private fun parts(version: String) =
        version.split('.', '-').map { part -> part.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }

    private fun newer(candidate: String, current: String): Boolean {
        val a = parts(candidate)
        val b = parts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }
}
