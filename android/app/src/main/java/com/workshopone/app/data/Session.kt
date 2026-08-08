package com.workshopone.app.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Persists the server URL, the wo_session cookie and the signed-in user, and
 * exposes the auth state to the UI. The server keeps sessions in its DB, so a
 * persisted cookie survives app restarts until it expires server-side.
 */
class Session(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("workshopone", Context.MODE_PRIVATE)
    private val gson = Gson()

    private val _user = MutableStateFlow(loadUser())
    val user: StateFlow<UserInfo?> = _user

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_BASE_URL, normalizeBaseUrl(value)).apply()
        }

    var cookie: String?
        get() = prefs.getString(KEY_COOKIE, null)
        set(value) {
            if (value == null) prefs.edit().remove(KEY_COOKIE).apply()
            else prefs.edit().putString(KEY_COOKIE, value).apply()
        }

    fun setUser(user: UserInfo?) {
        if (user == null) prefs.edit().remove(KEY_USER).apply()
        else prefs.edit().putString(KEY_USER, gson.toJson(user)).apply()
        _user.value = user
    }

    /** Called by the HTTP layer whenever the server answers 401. */
    fun onUnauthorized() {
        cookie = null
        setUser(null)
    }

    fun signOut() {
        cookie = null
        setUser(null)
    }

    private fun loadUser(): UserInfo? {
        val json = prefs.getString(KEY_USER, null) ?: return null
        return try {
            gson.fromJson(json, UserInfo::class.java)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_COOKIE = "wo_session"
        private const val KEY_USER = "user_json"

        /** "192.168.1.50:3000" -> "http://192.168.1.50:3000/". */
        fun normalizeBaseUrl(input: String): String {
            var url = input.trim()
            if (url.isEmpty()) return url
            if (!url.contains("://")) url = "http://$url"
            if (!url.endsWith("/")) url = "$url/"
            return url
        }
    }
}
