package com.workshopone.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.NotificationImportant
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workshopone.app.AppContainer
import com.workshopone.app.data.ChangePasswordRequest
import com.workshopone.app.data.apiCall
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.appViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class MoreViewModel(private val c: AppContainer) : ViewModel() {

    val user get() = c.session.user
    val serverUrl: String get() = c.session.baseUrl

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun changePassword(current: String, new: String, onDone: () -> Unit) {
        viewModelScope.launch {
            apiCall {
                c.api.changePassword(
                    ChangePasswordRequest(current_password = current, new_password = new)
                )
            }
                .onSuccess {
                    _message.value = "Password changed"
                    onDone()
                }
                .onFailure { _message.value = it.message }
        }
    }

    fun clearMessage() {
        _message.value = null
    }

    fun logout() {
        viewModelScope.launch {
            apiCall { c.api.logout() }
            c.session.signOut()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MoreScreen(
    onOpenBatteries: () -> Unit,
    onOpenAttention: () -> Unit,
) {
    val vm = appViewModel { MoreViewModel(it) }
    val user by vm.user.collectAsState()
    val message by vm.message.collectAsState()
    var showChangePassword by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("More", fontWeight = FontWeight.Bold) })
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        user?.fullName ?: user?.username ?: "—",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "@${user?.username ?: "—"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(top = 8.dp),
                    ) {
                        (user?.roles ?: emptyList()).forEach { role ->
                            Pill(role.replace('_', ' '), MaterialTheme.colorScheme.primary)
                        }
                    }
                    Text(
                        "Server: ${vm.serverUrl.ifEmpty { "not set" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }

            MenuRow(Icons.Filled.BatteryChargingFull, "Batteries", "Lifecycle, warranty radar, whereis-serial") {
                onOpenBatteries()
            }
            MenuRow(Icons.Filled.NotificationImportant, "Needs attention", "Service due, anomalies, integrity") {
                onOpenAttention()
            }
            MenuRow(Icons.Filled.Key, "Change password", "Update your sign-in password") {
                showChangePassword = true
            }
            MenuRow(Icons.AutoMirrored.Filled.Logout, "Sign out", "End this session") {
                vm.logout()
            }

            message?.let {
                Text(it, color = MaterialTheme.colorScheme.primary)
            }

            Spacer(Modifier.height(8.dp))
            Text(
                "WorkshopOne Mobile — Edward & Christie (Pvt) Ltd, Central Work Shop, Badalgama.\n" +
                    "Works over the workshop LAN against the WorkshopOne server.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (showChangePassword) {
        ChangePasswordDialog(
            onSubmit = { current, new ->
                vm.changePassword(current, new) { showChangePassword = false }
            },
            onDismiss = {
                showChangePassword = false
                vm.clearMessage()
            },
        )
    }
}

@Composable
private fun MenuRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.padding(start = 14.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ChangePasswordDialog(
    onSubmit: (String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var current by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text("Current password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("New password (min 6)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = repeat,
                    onValueChange = { repeat = it },
                    label = { Text("Repeat new password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = current.isNotBlank() && newPassword.length >= 6 && newPassword == repeat,
                onClick = { onSubmit(current, newPassword) },
            ) { Text("Change") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
