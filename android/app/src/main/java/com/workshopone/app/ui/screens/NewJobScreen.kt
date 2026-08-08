package com.workshopone.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workshopone.app.AppContainer
import com.workshopone.app.data.NewJobRequest
import com.workshopone.app.data.Project
import com.workshopone.app.data.apiCall
import com.workshopone.app.ui.common.appViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class NewJobViewModel(private val c: AppContainer) : ViewModel() {

    private val _projects = MutableStateFlow<List<Project>>(emptyList())
    val projects: StateFlow<List<Project>> = _projects

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private val _warning = MutableStateFlow<String?>(null)
    val warning: StateFlow<String?> = _warning

    init {
        viewModelScope.launch {
            apiCall { c.api.projects() }.onSuccess { _projects.value = it }
        }
    }

    fun create(request: NewJobRequest, onCreated: (Long) -> Unit) {
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            apiCall { c.api.createJob(request) }
                .onSuccess { response ->
                    if (response.unresolved != null) {
                        _warning.value =
                            "Asset \"${response.unresolved.raw}\" was not recognised — queued for alias linking."
                    }
                    onCreated(response.job.id)
                }
                .onFailure { _error.value = it.message }
            _busy.value = false
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewJobScreen(
    onCreated: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val vm = appViewModel { NewJobViewModel(it) }
    val projects by vm.projects.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()

    var description by rememberSaveable { mutableStateOf("") }
    var asset by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableStateOf("repair") }
    var severity by rememberSaveable { mutableStateOf("") }
    var site by rememberSaveable { mutableStateOf("") }
    var ref by rememberSaveable { mutableStateOf("") }
    var projectId by rememberSaveable { mutableStateOf<Long?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New Job Card", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
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
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text("Problem / work description *") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = asset,
                onValueChange = { asset = it },
                label = { Text("Asset (code or name, e.g. 28-4314)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Text("Type", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = type == "repair",
                    onClick = { type = "repair" },
                    label = { Text("Repair") },
                )
                FilterChip(
                    selected = type == "service",
                    onClick = { type = "service" },
                    label = { Text("Service") },
                )
            }

            Text("Severity", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = severity == "minor",
                    onClick = { severity = if (severity == "minor") "" else "minor" },
                    label = { Text("Minor") },
                )
                FilterChip(
                    selected = severity == "major",
                    onClick = { severity = if (severity == "major") "" else "major" },
                    label = { Text("Major") },
                )
            }

            if (projects.isNotEmpty()) {
                Text("Project", style = MaterialTheme.typography.labelLarge)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    projects.forEach { p ->
                        FilterChip(
                            selected = projectId == p.id,
                            onClick = { projectId = if (projectId == p.id) null else p.id },
                            label = { Text(p.name ?: "#${p.id}") },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = site,
                onValueChange = { site = it },
                label = { Text("Site (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = ref,
                onValueChange = { ref = it },
                label = { Text("Reference (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }

            Button(
                onClick = {
                    vm.create(
                        NewJobRequest(
                            description = description.trim(),
                            asset = asset.trim().takeIf { it.isNotEmpty() },
                            type = type,
                            severity = severity.takeIf { it.isNotEmpty() },
                            site = site.trim().takeIf { it.isNotEmpty() },
                            project_id = projectId,
                            ref = ref.trim().takeIf { it.isNotEmpty() },
                        ),
                        onCreated = onCreated,
                    )
                },
                enabled = !busy && description.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Creating…" else "Raise job card") }
        }
    }
}
