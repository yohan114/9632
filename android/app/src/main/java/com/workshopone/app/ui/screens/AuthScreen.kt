package com.workshopone.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workshopone.app.AppContainer
import com.workshopone.app.data.ChangePasswordRequest
import com.workshopone.app.data.LoginRequest
import com.workshopone.app.data.Session
import com.workshopone.app.data.UserInfo
import com.workshopone.app.data.apiCall
import com.workshopone.app.ui.common.appViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class AuthViewModel(private val c: AppContainer) : ViewModel() {

    enum class Phase { LOGIN, CHANGE_PASSWORD }

    private val _phase = MutableStateFlow(Phase.LOGIN)
    val phase: StateFlow<Phase> = _phase

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private val _info = MutableStateFlow<String?>(null)
    val info: StateFlow<String?> = _info

    val savedServer: String get() = c.session.baseUrl

    private var pendingUser: UserInfo? = null

    fun testConnection(serverUrl: String) {
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            _info.value = null
            c.session.baseUrl = Session.normalizeBaseUrl(serverUrl)
            apiCall { c.api.health() }
                .onSuccess { _info.value = "Connected to ${it.name ?: "server"} ✓" }
                .onFailure { _error.value = it.message }
            _busy.value = false
        }
    }

    fun login(serverUrl: String, username: String, password: String) {
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            _info.value = null
            c.session.baseUrl = Session.normalizeBaseUrl(serverUrl)
            apiCall { c.api.login(LoginRequest(username.trim(), password)) }
                .onSuccess { user ->
                    if (user.mustChangePassword) {
                        pendingUser = user
                        _phase.value = Phase.CHANGE_PASSWORD
                    } else {
                        c.session.setUser(user)
                    }
                }
                .onFailure { _error.value = it.message }
            _busy.value = false
        }
    }

    fun changePassword(newPassword: String) {
        val user = pendingUser ?: return
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            apiCall { c.api.changePassword(ChangePasswordRequest(new_password = newPassword)) }
                .onSuccess { c.session.setUser(user.copy(mustChangePassword = false)) }
                .onFailure { _error.value = it.message }
            _busy.value = false
        }
    }
}

@Composable
fun AuthScreen() {
    val vm = appViewModel { AuthViewModel(it) }
    val phase by vm.phase.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val info by vm.info.collectAsState()

    var server by rememberSaveable { mutableStateOf(vm.savedServer) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var newPassword by rememberSaveable { mutableStateOf("") }
    var newPassword2 by rememberSaveable { mutableStateOf("") }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "WorkshopOne",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                "Edward & Christie — Central Workshop",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    if (phase == AuthViewModel.Phase.LOGIN) {
                        OutlinedTextField(
                            value = server,
                            onValueChange = { server = it },
                            label = { Text("Server address") },
                            placeholder = { Text("e.g. 192.168.1.50:3000") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        TextButton(
                            onClick = { vm.testConnection(server) },
                            enabled = !busy && server.isNotBlank(),
                        ) { Text("Test connection") }

                        OutlinedTextField(
                            value = username,
                            onValueChange = { username = it },
                            label = { Text("Username") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(16.dp))
                        Button(
                            onClick = { vm.login(server, username, password) },
                            enabled = !busy && server.isNotBlank() && username.isNotBlank() && password.isNotBlank(),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (busy) "Signing in…" else "Sign in") }
                    } else {
                        Text(
                            "Password change required",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "This account must set a new password before continuing.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                        OutlinedTextField(
                            value = newPassword,
                            onValueChange = { newPassword = it },
                            label = { Text("New password (min 6 characters)") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = newPassword2,
                            onValueChange = { newPassword2 = it },
                            label = { Text("Repeat new password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(16.dp))
                        Button(
                            onClick = { vm.changePassword(newPassword) },
                            enabled = !busy && newPassword.length >= 6 && newPassword == newPassword2,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (busy) "Saving…" else "Set password & continue") }
                    }

                    if (busy) {
                        Spacer(Modifier.height(12.dp))
                        CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                    }
                    info?.let {
                        Spacer(Modifier.height(10.dp))
                        Text(it, color = MaterialTheme.colorScheme.tertiary)
                    }
                    error?.let {
                        Spacer(Modifier.height(10.dp))
                        Text(it, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}
