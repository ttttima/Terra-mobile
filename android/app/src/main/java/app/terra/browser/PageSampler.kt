package app.terra.browser

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Colors of the open web page, from small pictures of it (nothing leaves
 * the phone), as main.ts does on the desktop:
 *  - its edge colors, so "Smooth dividers" fade exactly into the page;
 *  - its main colors, for liquid glass in the open website's colors:
 *    every 250 ms while they change, 750 ms while they don't.
 */
class PageSampler(private val activity: MainActivity) {
    private val handler = Handler(Looper.getMainLooper())
    private var wantColors = false
    private var wantEdges = false
    private var busy = false
    private var lastColors = ""
    private var lastEdges = ""
    private var changedAt = 0L
    private val loop = Runnable { tick() }

    fun configure(colors: Boolean, edges: Boolean) {
        val was = wantColors || wantEdges
        wantColors = colors
        wantEdges = edges
        if (!colors && lastColors != "none") {
            lastColors = "none"
            activity.host.send("pageColors", null)
        }
        if (!was && (colors || edges)) soon()
    }

    /** Something changed (a page loaded, another tab): look again soon. */
    fun soon() {
        if (!wantColors && !wantEdges) return
        changedAt = System.currentTimeMillis()
        handler.removeCallbacks(loop)
        handler.postDelayed(loop, 80)
    }

    private fun tick() {
        // Stops while Terra is in the background; onResume starts it again.
        if (!wantColors && !wantEdges || !activity.resumed) return
        sample {
            val changing = System.currentTimeMillis() - changedAt < FAST_FOR_MS
            val delay = when {
                wantColors -> if (changing) FAST_MS else SLOW_MS
                changing -> 600L
                else -> 2000L
            }
            handler.removeCallbacks(loop)
            handler.postDelayed(loop, delay)
        }
    }

    private fun sample(done: () -> Unit) {
        val view = activity.tabs.shownView()
        val rect = activity.pageRect
        // Not while covered by a menu or drawer (it would be in the picture).
        if (busy || !activity.resumed || view == null || activity.root.capture ||
            rect.width() < 64 || rect.height() < 64
        ) {
            if (view == null && wantColors && lastColors != "none") {
                lastColors = "none"
                activity.host.send("pageColors", null)
            }
            return done()
        }
        busy = true
        val width = 48
        val height = max(1, (width.toFloat() * rect.height() / rect.width()).roundToInt())
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(activity.window, Rect(rect), bitmap, { result ->
                busy = false
                if (result == PixelCopy.SUCCESS) use(bitmap)
                done()
            }, handler)
        } catch (_: Exception) {
            busy = false
            done()
        }
    }

    private fun use(bitmap: Bitmap) {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        if (wantEdges) {
            // Rows just inside the page, away from its rounded corners.
            val inset = max(1, bitmap.width / 8)
            val top = dominant(pixels, bitmap.width, 1, inset)
            val bottom = dominant(pixels, bitmap.width, bitmap.height - 2, inset)
            val edges = JSONObject().put("top", top).put("bottom", bottom)
            val key = edges.toString()
            if (key != lastEdges) {
                lastEdges = key
                activity.host.send("pageEdges", edges)
            }
        }
        if (wantColors) {
            val colors = palette(pixels)
            val key = colors.joinToString("|") { hex ->
                listOf(1, 3, 5).joinToString(",") { (hex.substring(it, it + 2).toInt(16) / 12).toString() }
            }
            if (key != lastColors) {
                lastColors = key
                changedAt = System.currentTimeMillis()
                activity.host.send("pageColors", JSONArray(colors))
            }
        }
    }

    private fun hex(r: Double, g: Double, b: Double) =
        "#%02x%02x%02x".format(r.roundToInt(), g.roundToInt(), b.roundToInt())

    /** Most common color in one row. */
    private fun dominant(pixels: IntArray, width: Int, row: Int, inset: Int): String? {
        if (row < 0) return null
        val counts = HashMap<Int, Int>()
        var best = -1
        var bestCount = 0
        for (x in inset until width - inset) {
            val rgb = pixels[row * width + x] and 0xffffff
            val count = (counts[rgb] ?: 0) + 1
            counts[rgb] = count
            if (count > bestCount) {
                best = rgb
                bestCount = count
            }
        }
        return if (best < 0) null else "#%06x".format(best)
    }

    private fun hue(r: Double, g: Double, b: Double): Double {
        val maximum = max(r, max(g, b))
        val delta = maximum - min(r, min(g, b))
        if (delta == 0.0) return 0.0
        val h = when (maximum) {
            r -> ((g - b) / delta) % 6
            g -> (b - r) / delta + 2
            else -> (r - g) / delta + 4
        }
        return (h * 60 + 360) % 360
    }

    /** The page's vivid main colors, up to three with clearly different hues. */
    private fun palette(pixels: IntArray): List<String> {
        class Bucket(var n: Int = 0, var r: Double = 0.0, var g: Double = 0.0, var b: Double = 0.0)
        val buckets = HashMap<Int, Bucket>()
        for (pixel in pixels) {
            val r = (pixel shr 16) and 255
            val g = (pixel shr 8) and 255
            val b = pixel and 255
            val key = ((r shr 4) shl 8) or ((g shr 4) shl 4) or (b shr 4)
            val bucket = buckets.getOrPut(key) { Bucket() }
            bucket.n++
            bucket.r += r
            bucket.g += g
            bucket.b += b
        }
        data class Color(val r: Double, val g: Double, val b: Double, val n: Int, val saturation: Double, val value: Double, val hue: Double)
        val colors = buckets.values.map {
            val r = it.r / it.n
            val g = it.g / it.n
            val b = it.b / it.n
            val maximum = max(r, max(g, b))
            Color(r, g, b, it.n, if (maximum > 0) (maximum - min(r, min(g, b))) / maximum else 0.0, maximum / 255, hue(r, g, b))
        }
        val total = pixels.size
        val vivid = colors
            .filter { it.saturation > 0.25 && it.value > 0.2 && it.n >= total * 0.002 }
            .sortedByDescending { it.n * it.saturation }
        val picked = mutableListOf<Color>()
        for (color in vivid) {
            val apart = picked.all {
                val distance = abs(it.hue - color.hue)
                min(distance, 360 - distance) > 30
            }
            if (apart) picked.add(color)
            if (picked.size == 3) break
        }
        if (picked.isNotEmpty()) return picked.map { hex(it.r, it.g, it.b) }
        val main = colors.maxByOrNull { it.n } ?: return emptyList()
        return listOf(hex(main.r, main.g, main.b))
    }

    companion object {
        private const val FAST_MS = 250L
        private const val SLOW_MS = 750L
        private const val FAST_FOR_MS = 3000L
    }
}
