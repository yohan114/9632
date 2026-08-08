package com.workshopone.app.data

import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Builds the Retrofit service against the currently configured server URL and
 * handles the wo_session cookie: it is attached to every request and captured
 * from login responses. A 401 on any call (except login itself) flips the
 * session to signed-out, which sends the UI back to the login screen.
 */
class ApiClient(private val session: Session) {

    private val gson = Gson()

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val builder = chain.request().newBuilder()
            session.cookie?.let { builder.header("Cookie", "$COOKIE_NAME=$it") }
            val response = chain.proceed(builder.build())
            for (header in response.headers("Set-Cookie")) {
                if (header.startsWith("$COOKIE_NAME=")) {
                    val value = header.substringAfter("$COOKIE_NAME=").substringBefore(';').trim()
                    session.cookie = value.ifEmpty { null }
                }
            }
            if (response.code == 401 &&
                !response.request.url.encodedPath.endsWith("/auth/login")
            ) {
                session.onUnauthorized()
            }
            response
        }
        .build()

    @Volatile private var api: WorkshopApi? = null
    @Volatile private var builtFor: String? = null

    fun api(): WorkshopApi {
        val base = session.baseUrl.ifEmpty { PLACEHOLDER_URL }
        api?.let { if (builtFor == base) return it }
        synchronized(this) {
            api?.let { if (builtFor == base) return it }
            val built = Retrofit.Builder()
                .baseUrl(base)
                .client(http)
                .addConverterFactory(GsonConverterFactory.create(gson))
                .build()
                .create(WorkshopApi::class.java)
            api = built
            builtFor = base
            return built
        }
    }

    companion object {
        const val COOKIE_NAME = "wo_session"

        // Never used for a real request: the setup screen stores a URL before
        // any call is made. It only keeps Retrofit's builder from throwing.
        private const val PLACEHOLDER_URL = "http://192.0.2.1/"
    }
}

/** An API error with the server's own message and closure-gate details. */
class ApiException(
    val code: Int,
    override val message: String,
    val missing: List<String> = emptyList(),
) : Exception(message)

private val errorGson = Gson()

fun Throwable.toApiException(): ApiException = when (this) {
    is ApiException -> this
    is HttpException -> {
        val body = try {
            response()?.errorBody()?.string()
        } catch (_: Exception) {
            null
        }
        val parsed = try {
            if (body.isNullOrBlank()) null else errorGson.fromJson(body, ApiErrorBody::class.java)
        } catch (_: Exception) {
            null
        }
        val message = parsed?.error
            ?: "Server error (HTTP ${code()})"
        ApiException(code(), message, parsed?.missing ?: emptyList())
    }
    is IOException -> ApiException(0, "Cannot reach the server — check the URL and Wi-Fi (${message ?: "network error"})")
    else -> ApiException(-1, message ?: "Unexpected error")
}

/** Runs an API call on IO and wraps any failure as [ApiException]. */
suspend fun <T> apiCall(block: suspend () -> T): Result<T> = withContext(Dispatchers.IO) {
    try {
        Result.success(block())
    } catch (e: Throwable) {
        Result.failure(e.toApiException())
    }
}
