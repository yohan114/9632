package com.workshopone.app.ui.common

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workshopone.app.data.ApiException
import com.workshopone.app.data.apiCall
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Base for screens that load one payload and run occasional mutations.
 * Mutations reload the payload on success and surface errors via [notice].
 */
open class LoaderViewModel<T>(private val loader: suspend () -> T) : ViewModel() {

    private val _state = MutableStateFlow<UiState<T>>(UiState.Loading)
    val state: StateFlow<UiState<T>> = _state

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            if (_state.value !is UiState.Ready) _state.value = UiState.Loading
            apiCall(loader)
                .onSuccess { _state.value = UiState.Ready(it) }
                .onFailure { _state.value = UiState.Error(it.message ?: "Something went wrong") }
        }
    }

    /** Runs [block] against the API, reloads on success, reports failures. */
    fun mutate(onDone: (() -> Unit)? = null, block: suspend () -> Unit) {
        viewModelScope.launch {
            _busy.value = true
            apiCall(block)
                .onSuccess {
                    refresh()
                    onDone?.invoke()
                }
                .onFailure { error ->
                    _notice.value = describe(error)
                }
            _busy.value = false
        }
    }

    fun clearNotice() {
        _notice.value = null
    }

    private fun describe(error: Throwable): String {
        val api = error as? ApiException
        if (api != null && api.missing.isNotEmpty()) {
            return api.message + "\n• " + api.missing.joinToString("\n• ")
        }
        return error.message ?: "Something went wrong"
    }
}
