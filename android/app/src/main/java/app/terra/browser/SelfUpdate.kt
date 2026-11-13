package app.terra.browser

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Terra updating itself, without leaving the app:
 *
 *  1. the new APK is downloaded here (the UI shows how far it is);
 *  2. it is handed to Android's installer as a session. On Android 12 and
 *     newer an app may update itself this way without the "Do you want to
 *     update?" dialog, once the user has allowed Terra to install apps
 *     (asked the first time, on Android's own page); Android 10 and 11
 *     still ask every time, and we show their question;
 *  3. Android closes Terra to swap it, and the new Terra opens again
 *     ([UpdateReceiver]).
 *
 * Android checks that the new APK is signed with the same key as this one;
 * we check that it really is Terra and really is newer before handing it
 * over.
 */
class SelfUpdate(private val activity: MainActivity) {
    private val running = AtomicBoolean(false)

    init {
        listener = { state, message -> report(state, message = message) }
        File(activity.cacheDir, FOLDER).deleteRecursively()
    }

    private fun report(state: String, percent: Int = 0, message: String? = null) {
        if (state == "failed") running.set(false)
        activity.host.send(
            "update.progress",
            JSONObject().put("state", state).put("percent", percent)
                .put("message", message ?: JSONObject.NULL),
        )
    }

    /** Whether Android lets the new Terra open by itself after the swap. */
    fun canReopen() = Settings.canDrawOverlays(activity)

    /** Android's own switch for that ("Display over other apps"). */
    fun askToReopen() {
        try {
            activity.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${activity.packageName}"),
                ),
            )
        } catch (_: Exception) {
        }
    }

    /** The update waiting for the user to allow Terra to install apps. */
    private var waiting: String? = null

    /** Back in Terra: was it allowed? Then the update carries on. */
    fun resumed() {
        val url = waiting ?: return
        waiting = null
        if (activity.packageManager.canRequestPackageInstalls()) {
            start(url)
        } else {
            report("failed", message = "Terra isn't allowed to install its updates")
        }
    }

    fun start(url: String) {
        // Only ever Terra's own releases.
        if (!url.startsWith(RELEASES)) return report("failed", message = "Not a Terra release")
        if (!activity.packageManager.canRequestPackageInstalls()) {
            // Android asks this once, on its own page; then we carry on.
            waiting = url
            report("permission")
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}"),
                    ),
                )
            } catch (_: Exception) {
                waiting = null
                report("failed", message = "Terra isn't allowed to install its updates")
            }
            return
        }
        if (!running.compareAndSet(false, true)) return
        Thread {
            try {
                val apk = download(url)
                check(apk)
                report("installing", 100)
                // The UI saves the open tabs before Android closes Terra.
                Thread.sleep(600)
                install(apk)
            } catch (error: Exception) {
                report("failed", message = error.message ?: "The update couldn't be installed")
            }
        }.start()
    }

    private fun download(url: String): File {
        val folder = File(activity.cacheDir, FOLDER).apply { mkdirs() }
        val file = File(folder, "Terra.apk")
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("User-Agent", "Terra")
        try {
            if (connection.responseCode != 200) throw Exception("The download didn't start")
            val total = connection.contentLengthLong
            var received = 0L
            var shown = -1
            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        received += count
                        val percent = if (total > 0) (received * 100 / total).toInt() else 0
                        if (percent != shown) {
                            shown = percent
                            report("downloading", percent)
                        }
                    }
                }
            }
            if (total > 0 && received != total) throw Exception("The download was cut off")
        } finally {
            connection.disconnect()
        }
        return file
    }

    /** It has to be Terra, and newer than this one. */
    private fun check(apk: File) {
        val manager = activity.packageManager
        val info: PackageInfo = manager.getPackageArchiveInfo(apk.path, 0)
            ?: throw Exception("The download isn't an app")
        if (info.packageName != activity.packageName) throw Exception("The download isn't Terra")
        val current = manager.getPackageInfo(activity.packageName, 0).longVersionCode
        if (info.longVersionCode <= current) throw Exception("The download isn't newer")
    }

    private fun install(apk: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(activity.packageName)
        params.setSize(apk.length())
        params.setInstallReason(PackageManager.INSTALL_REASON_USER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // An app updating itself needs no confirmation dialog.
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("terra.apk", 0, apk.length()).use { output ->
                apk.inputStream().use { it.copyTo(output, 64 * 1024) }
                session.fsync(output)
            }
            apk.delete()
            // Remembered across the swap: the new Terra opens again.
            activity.getSharedPreferences("terra", Context.MODE_PRIVATE)
                .edit().putBoolean(REOPEN, true).commit()
            val status = Intent(activity, UpdateReceiver::class.java).setAction(STATUS)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            session.commit(PendingIntent.getBroadcast(activity, id, status, flags).intentSender)
        }
    }

    companion object {
        private const val RELEASES = "https://github.com/ttttima/Terra-mobile/releases/download/"
        private const val FOLDER = "update"
        const val STATUS = "app.terra.browser.UPDATE_STATUS"
        const val REOPEN = "reopenAfterUpdate"

        /** The running app, told how the installation went. */
        var listener: ((state: String, message: String?) -> Unit)? = null
    }
}

/**
 * What Android says about the installation, and the moment after it: the
 * new Terra has just replaced the old one.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences("terra", Context.MODE_PRIVATE)
        when (intent.action) {
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // Only after an update Terra made itself, with the app open.
                if (!prefs.getBoolean(SelfUpdate.REOPEN, false)) return
                prefs.edit().remove(SelfUpdate.REOPEN).apply()
                try {
                    context.startActivity(
                        Intent(context, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (_: Exception) {
                }
            }
            SelfUpdate.STATUS -> when (
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            ) {
                PackageInstaller.STATUS_SUCCESS -> Unit
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    // Android wants to ask first (an older Android, or Terra
                    // isn't allowed to install apps yet): show its question.
                    @Suppress("DEPRECATION")
                    val question = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                    SelfUpdate.listener?.invoke("confirm", null)
                    try {
                        context.startActivity(question?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (_: Exception) {
                        fail(prefs, "Android couldn't ask to install the update")
                    }
                }
                else -> fail(
                    prefs,
                    if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                        "The update was cancelled"
                    } else {
                        intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                            ?: "The update couldn't be installed"
                    },
                )
            }
        }
    }

    private fun fail(prefs: android.content.SharedPreferences, message: String) {
        prefs.edit().remove(SelfUpdate.REOPEN).apply()
        SelfUpdate.listener?.invoke("failed", message)
    }
}
