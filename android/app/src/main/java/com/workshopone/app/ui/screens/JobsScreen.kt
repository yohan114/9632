package com.workshopone.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workshopone.app.AppContainer
import com.workshopone.app.data.JobStates
import com.workshopone.app.data.JobSummary
import com.workshopone.app.data.Roles
import com.workshopone.app.data.apiCall
import com.workshopone.app.data.hasRole
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.StatusPill
import com.workshopone.app.ui.common.UiState
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.common.shortDate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class JobsViewModel(private val c: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow<UiState<List<JobSummary>>>(UiState.Loading)
    val state: StateFlow<UiState<List<JobSummary>>> = _state

    private val _statusFilter = MutableStateFlow<String?>(null)
    val statusFilter: StateFlow<String?> = _statusFilter

    val user get() = c.session.user

    init {
        refresh()
    }

    fun setStatus(status: String?) {
        _statusFilter.value = status
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.value = UiState.Loading
            apiCall { c.api.jobs(status = _statusFilter.value) }
                .onSuccess { _state.value = UiState.Ready(it) }
                .onFailure { _state.value = UiState.Error(it.message ?: "Failed to load jobs") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JobsScreen(
    onOpenJob: (Long) -> Unit,
    onNewJob: () -> Unit,
) {
    val vm = appViewModel { JobsViewModel(it) }
    val state by vm.state.collectAsState()
    val statusFilter by vm.statusFilter.collectAsState()
    val user by vm.user.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }

    val canCreate = user.hasRole(Roles.TRANSPORT, Roles.WORKSHOP)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Job Cards", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        floatingActionButton = {
            if (canCreate) {
                FloatingActionButton(onClick = onNewJob) {
                    Icon(Icons.Filled.Add, contentDescription = "New job card")
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search job no, asset, description…") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            )
            LazyRow(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    FilterChip(
                        selected = statusFilter == null,
                        onClick = { vm.setStatus(null) },
                        label = { Text("All") },
                    )
                }
                items(JobStates.ALL) { s ->
                    FilterChip(
                        selected = statusFilter == s,
                        onClick = { vm.setStatus(if (statusFilter == s) null else s) },
                        label = { Text(JobStates.label(s)) },
                    )
                }
            }

            StateContent(state, onRetry = { vm.refresh() }) { jobs ->
                val q = query.trim().lowercase()
                val filtered = if (q.isEmpty()) jobs else jobs.filter { j ->
                    listOf(j.job_no, j.asset_code, j.description, j.project_name)
                        .any { it?.lowercase()?.contains(q) == true }
                }
                if (filtered.isEmpty()) {
                    EmptyHint("No job cards match")
                } else {
                    LazyColumn(
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(filtered, key = { it.id }) { job ->
                            JobRow(job, onClick = { onOpenJob(job.id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun JobRow(job: JobSummary, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable { onClick() }) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    job.job_no ?: "#${job.id}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                StatusPill(job.status)
            }
            Text(
                job.description ?: "",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 4.dp),
                maxLines = 2,
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    listOfNotNull(
                        job.asset_code,
                        job.project_name,
                        job.type,
                        job.severity,
                    ).joinToString(" · ").ifEmpty { "—" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    if ((job.total_cost ?: 0.0) > 0.0) money(job.total_cost) else shortDate(job.requested_at),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}
