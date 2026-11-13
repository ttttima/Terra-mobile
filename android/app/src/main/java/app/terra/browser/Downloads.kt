package app.terra.browser

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
import androidx.webkit.ProfileStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Downloads go through Android's download manager: into the phone's
 * Downloads folder, with its notification. This keeps the list the
 * Downloads page shows (downloads.json) and reports progress to the UI.
 */
class Downloads(private val activity: MainActivity) {
    private data class Item(
        val id: String,
        val system: Long,
        val filename: String,
        val url: String,
        val mime: String,
        val started: Long,
        /** For the update installer: open it when done. */
        val install: Boolean = false,
        /** Saved straight away (data: links), not by the download manager. */
        val saved: String? = null,
        var state: String = "progressing",
    )

    private val manager = activity.getSystemService(DownloadManager::class.java)
    private val file = File(activity.filesDir, "downloads.json")
    private val items = mutableListOf<Item>()
    private var polling = false
    private var stopped = false
    private val opened = mutableSetOf<String>()

    init {
        load()
        activity.main.post { poll() }
    }

    // ------------------------------------------------------------ starting

    fun start(
        url: String,
        agent: String?,
        disposition: String?,
        mime: String?,
        @Suppress("UNUSED_PARAMETER") length: Long,
        page: String?,
        private: Boolean,
        install: Boolean = false,
    ) {
        if (url.startsWith("data:", ignoreCase = true)) return saveData(url)
        if (!url.startsWith("http", ignoreCase = true)) {
            Toast.makeText(activity, "Terra can't download this kind of file", Toast.LENGTH_SHORT).show()
            return
        }
        val type = mime?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(url))
            ?: mime ?: "application/octet-stream"
        val filename = URLUtil.guessFileName(url, disposition, type)
        val request = DownloadManager.Request(Uri.parse(url))
            .setMimeType(type)
            .setTitle(filename)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (install) {
            request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, filename)
        } else {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
        }
        request.addRequestHeader("User-Agent", agent ?: android.webkit.WebSettings.getDefaultUserAgent(activity))
        cookies(private).getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        if (!page.isNullOrBlank() && page.startsWith("http")) request.addRequestHeader("Referer", page)
        val system = try {
            manager.enqueue(request)
        } catch (error: Exception) {
            Toast.makeText(activity, "Couldn't download $filename", Toast.LENGTH_SHORT).show()
            return
        }
        items.add(0, Item(newId(), system, filename, url, type, System.currentTimeMillis(), install))
        if (items.size > 500) items.subList(500, items.size).clear()
        save()
        Toast.makeText(activity, "Downloading $filename", Toast.LENGTH_SHORT).show()
        poll()
    }

    /** "Download link" and "Download image" in a page's long-press menu. */
    fun startLink(url: String, page: String, private: Boolean) =
        start(url, null, null, null, 0, page, private)

    /** A new Terra: download the APK and open the installer when done. */
    fun startUpdate(url: String) = start(url, null, "attachment; filename=Terra.apk",
        "application/vnd.android.package-archive", 0, null, false, install = true)

    private fun cookies(private: Boolean): CookieManager =
        if (private && Tabs.privateSupported()) {
            ProfileStore.getInstance().getOrCreateProfile("terra-private").cookieManager
        } else {
            CookieManager.getInstance()
        }

    /** A picture made by the page (data: link): saved straight away. */
    private fun saveData(url: String) {
        val match = Regex("^data:([^;,]+)?(;base64)?,(.*)$", RegexOption.DOT_MATCHES_ALL).find(url) ?: return
        val mime = match.groupValues[1].ifBlank { "application/octet-stream" }
        val bytes = try {
            if (match.groupValues[2].isNotEmpty()) Base64.decode(match.groupValues[3], Base64.DEFAULT)
            else Uri.decode(match.groupValues[3]).toByteArray()
        } catch (_: Exception) {
            return
        }
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"
        val filename = "download-${System.currentTimeMillis()}.$extension"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, mime)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return
        resolver.openOutputStream(uri)?.use { it.write(bytes) }
        items.add(
            0,
            Item(newId(), -1, filename, "", mime, System.currentTimeMillis(), saved = uri.toString(), state = "completed"),
        )
        save()
        Toast.makeText(activity, "Saved $filename to Downloads", Toast.LENGTH_SHORT).show()
        report()
    }

    // ------------------------------------------------------------ progress

    private fun info(item: Item, row: Map<String, Long>?): JSONObject {
        var state = item.state
        var exists = item.saved != null
        var received = 0L
        var total = 0L
        if (item.saved == null) {
            if (row == null) {
                if (state != "completed" && state != "interrupted") state = "cancelled"
            } else {
                received = row["received"] ?: 0
                total = maxOf(0, row["total"] ?: 0)
                state = when (row["status"]?.toInt()) {
                    DownloadManager.STATUS_SUCCESSFUL -> "completed"
                    DownloadManager.STATUS_FAILED -> "interrupted"
                    DownloadManager.STATUS_PAUSED -> "paused"
                    else -> "progressing"
                }
                exists = state == "completed"
            }
        }
        item.state = state
        if (state == "completed" && item.saved == null) total = maxOf(total, received)
        return JSONObject()
            .put("id", item.id)
            .put("filename", item.filename)
            .put("url", item.url)
            .put("path", "")
            .put("received", if (state == "completed") total else received)
            .put("total", total)
            .put("state", state)
            .put("started", item.started)
            .put("canResume", false)
            .put("exists", exists)
    }

    private fun rows(): Map<Long, Map<String, Long>> {
        val ids = items.filter { it.saved == null && it.system >= 0 }.map { it.system }
        if (ids.isEmpty()) return emptyMap()
        val result = HashMap<Long, Map<String, Long>>()
        try {
            manager.query(DownloadManager.Query().setFilterById(*ids.toLongArray()))?.use { cursor ->
                val idColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)
                val status = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
                val received = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                val total = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                while (cursor.moveToNext()) {
                    result[cursor.getLong(idColumn)] = mapOf(
                        "status" to cursor.getInt(status).toLong(),
                        "received" to cursor.getLong(received),
                        "total" to cursor.getLong(total),
                    )
                }
            }
        } catch (_: Exception) {
        }
        return result
    }

    private fun report(): Boolean {
        val rows = rows()
        val list = JSONArray()
        var running = false
        for (item in items) {
            val before = item.state
            val info = info(item, rows[item.system])
            list.put(info)
            val state = info.getString("state")
            if (state == "progressing" || state == "paused") running = true
            if (before != state) save()
            if (item.install && state == "completed" && opened.add(item.id)) open(item)
        }
        activity.host.send("downloads", list)
        return running
    }

    private fun poll() {
        if (polling || stopped) return
        polling = true
        val running = report()
        polling = false
        if (running) activity.main.postDelayed({ poll() }, 500)
    }

    fun stop() {
        stopped = true
    }

    // ------------------------------------------------------------ actions

    fun action(id: String, action: String) {
        if (action == "show") {
            try {
                activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
            }
            return
        }
        val item = items.find { it.id == id } ?: return
        when (action) {
            "open" -> open(item)
            "cancel" -> {
                if (item.system >= 0) manager.remove(item.system)
                item.state = "cancelled"
            }
            "remove" -> {
                if (item.state == "progressing" || item.state == "paused") manager.remove(item.system)
                items.remove(item)
            }
            "retry" -> {
                items.remove(item)
                startLink(item.url, "", false)
                return
            }
        }
        save()
        poll()
    }

    /** "Clear list": forgets the downloads that are done (not the files). */
    fun clear() {
        items.removeAll { it.state != "progressing" && it.state != "paused" }
        save()
        report()
    }

    private fun open(item: Item) {
        val uri = item.saved?.let(Uri::parse) ?: try {
            manager.getUriForDownloadedFile(item.system)
        } catch (_: Exception) {
            null
        } ?: return
        val type = if (item.install) "application/vnd.android.package-archive" else item.mime
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (item.install && !activity.packageManager.canRequestPackageInstalls()) {
            // Android asks once whether Terra may install its own updates.
            Toast.makeText(activity, "Allow Terra to install the update, then open it from Downloads", Toast.LENGTH_LONG).show()
            try {
                activity.startActivity(
                    Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            } catch (_: Exception) {
            }
            return
        }
        try {
            activity.startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(activity, "No app can open ${item.filename}", Toast.LENGTH_SHORT).show()
        }
    }

    // ------------------------------------------------------------ storage

    private fun newId() = java.lang.Long.toString(System.currentTimeMillis(), 36) +
        java.lang.Long.toString((Math.random() * 1e8).toLong(), 36)

    private fun load() {
        try {
            if (!file.exists()) return
            val array = JSONArray(file.readText())
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                items.add(
                    Item(
                        o.getString("id"),
                        o.getLong("system"),
                        o.getString("filename"),
                        o.optString("url"),
                        o.optString("mime"),
                        o.optLong("started"),
                        o.optBoolean("install"),
                        if (o.isNull("saved")) null else o.optString("saved"),
                        o.optString("state", "progressing"),
                    ),
                )
            }
        } catch (_: Exception) {
        }
    }

    private fun save() {
        val array = JSONArray()
        for (item in items) {
            array.put(
                JSONObject()
                    .put("id", item.id)
                    .put("system", item.system)
                    .put("filename", item.filename)
                    .put("url", item.url)
                    .put("mime", item.mime)
                    .put("started", item.started)
                    .put("install", item.install)
                    .put("saved", item.saved ?: JSONObject.NULL)
                    .put("state", item.state),
            )
        }
        file.writeText(array.toString())
    }
}
