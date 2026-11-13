package app.terra.browser

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Saved passwords, encrypted with a key in Android's keystore (the phone's
 * safeStorage) and kept in the app's private storage. Passwords leave this
 * class only to be filled into their own site, or shown and copied by the
 * person in Settings.
 */
class Passwords(activity: MainActivity) {
    data class Login(
        val id: String,
        val origin: String,
        val username: String,
        val time: Long,
        val iv: String,
        val secret: String,
    )

    private val file = File(activity.filesDir, "logins.json")
    private val logins = mutableListOf<Login>()
    private val pending = HashMap<String, Triple<String, String, String>>()

    val available: Boolean = try {
        key()
        true
    } catch (_: Exception) {
        false
    }

    init {
        load()
    }

    // ------------------------------------------------------------ the key

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(text: String): Pair<String, String> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val secret = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) to
            Base64.encodeToString(secret, Base64.NO_WRAP)
    }

    private fun decrypt(login: Login): String? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(login.iv, Base64.NO_WRAP)))
        cipher.doFinal(Base64.decode(login.secret, Base64.NO_WRAP)).toString(Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }

    // ------------------------------------------------------------ storage

    private fun load() {
        try {
            if (!file.exists()) return
            val array = JSONArray(file.readText())
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                logins.add(
                    Login(
                        o.getString("id"),
                        o.getString("origin"),
                        o.optString("username"),
                        o.optLong("time"),
                        o.getString("iv"),
                        o.getString("secret"),
                    ),
                )
            }
        } catch (_: Exception) {
        }
    }

    private fun save() {
        val array = JSONArray()
        for (login in logins) {
            array.put(
                JSONObject()
                    .put("id", login.id)
                    .put("origin", login.origin)
                    .put("username", login.username)
                    .put("time", login.time)
                    .put("iv", login.iv)
                    .put("secret", login.secret),
            )
        }
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeText(array.toString())
        temp.renameTo(file)
    }

    private fun summary(login: Login) = JSONObject()
        .put("id", login.id)
        .put("origin", login.origin)
        .put("username", login.username)
        .put("time", login.time)

    // ------------------------------------------------------------ the API

    @Synchronized
    fun list(): JSONArray = JSONArray(
        logins.sortedWith(compareBy({ it.origin }, { it.username })).map(::summary),
    )

    @Synchronized
    fun loginsFor(origin: String): JSONArray =
        JSONArray(logins.filter { it.origin == origin }.map(::summary))

    @Synchronized
    fun login(id: String): Login? = logins.find { it.id == id }

    @Synchronized
    fun reveal(id: String): String? = logins.find { it.id == id }?.let(::decrypt)

    @Synchronized
    fun delete(id: String) {
        logins.removeAll { it.id == id }
        save()
    }

    @Synchronized
    fun hasUser(origin: String, username: String) =
        logins.any { it.origin == origin && it.username == username }

    @Synchronized
    fun isSaved(origin: String, username: String, password: String) =
        logins.any { it.origin == origin && it.username == username && decrypt(it) == password }

    /** Keeps a submitted login until the person says Save (or not). */
    @Synchronized
    fun remember(origin: String, username: String, password: String): String {
        if (pending.size > 20) pending.clear()
        val token = UUID.randomUUID().toString()
        pending[token] = Triple(origin, username, password)
        return token
    }

    @Synchronized
    fun savePending(token: String): Boolean {
        val (origin, username, password) = pending.remove(token) ?: return false
        save(origin, username, password)
        return true
    }

    @Synchronized
    fun save(origin: String, username: String, password: String) {
        if (!available) return
        val (iv, secret) = encrypt(password)
        logins.removeAll { it.origin == origin && it.username == username }
        logins.add(Login(UUID.randomUUID().toString(), origin, username, System.currentTimeMillis(), iv, secret))
        save()
    }

    /**
     * A CSV from another browser or password manager: a header row naming
     * url / username / password (Chrome, Edge, Firefox, Bitwarden...).
     * Returns how many were added.
     */
    @Synchronized
    fun importCsv(text: String): Int {
        val rows = parseCsv(text.removePrefix("﻿"))
        if (rows.isEmpty()) return 0
        val header = rows[0].map { it.trim().lowercase() }
        val urlColumn = header.indexOfFirst { it == "url" || it == "login_uri" || it == "website" || it == "origin" }
        val userColumn = header.indexOfFirst { it == "username" || it == "login_username" || it == "user" || it == "email" }
        val passwordColumn = header.indexOfFirst { it == "password" || it == "login_password" }
        if (urlColumn < 0 || passwordColumn < 0) return 0
        var added = 0
        for (row in rows.drop(1)) {
            val origin = Tabs.originOf(row.getOrNull(urlColumn)?.trim() ?: continue)
            val password = row.getOrNull(passwordColumn) ?: continue
            if (origin.isEmpty() || password.isEmpty()) continue
            val username = if (userColumn >= 0) row.getOrNull(userColumn) ?: "" else ""
            if (logins.any { it.origin == origin && it.username == username && decrypt(it) == password }) continue
            val (iv, secret) = encrypt(password)
            logins.removeAll { it.origin == origin && it.username == username }
            logins.add(Login(UUID.randomUUID().toString(), origin, username, System.currentTimeMillis(), iv, secret))
            added++
        }
        if (added > 0) save()
        return added
    }

    private fun parseCsv(text: String): List<List<String>> {
        val rows = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        val field = StringBuilder()
        var quoted = false
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                quoted && c == '"' && text.getOrNull(i + 1) == '"' -> {
                    field.append('"')
                    i++
                }
                c == '"' -> quoted = !quoted
                !quoted && c == ',' -> {
                    row.add(field.toString())
                    field.clear()
                }
                !quoted && (c == '\n' || c == '\r') -> {
                    if (c == '\r' && text.getOrNull(i + 1) == '\n') i++
                    row.add(field.toString())
                    field.clear()
                    if (row.any { it.isNotEmpty() }) rows.add(row)
                    row = mutableListOf()
                }
                else -> field.append(c)
            }
            i++
        }
        if (field.isNotEmpty() || row.isNotEmpty()) {
            row.add(field.toString())
            if (row.any { it.isNotEmpty() }) rows.add(row)
        }
        return rows
    }

    companion object {
        private const val ALIAS = "terra-passwords"
    }
}
