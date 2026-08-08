package com.workshopone.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.workshopone.app.data.AssetRow
import com.workshopone.app.data.apiCall
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.UiState
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.TealOk
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class AssetsViewModel(private val c: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow<UiState<List<AssetRow>>>(UiState.Loading)
    val state: StateFlow<UiState<List<AssetRow>>> = _state

    private var lastQuery: String? = null

    init {
        search(null)
    }

    fun search(query: String?) {
        lastQuery = query
        viewModelScope.launch {
            _state.value = UiState.Loading
            apiCall { c.api.assets(q = query?.takeIf { it.isNotBlank() }) }
                .onSuccess { _state.value = UiState.Ready(it) }
                .onFailure { _state.value = UiState.Error(it.message ?: "Failed to load assets") }
        }
    }

    fun refresh() = search(lastQuery)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssetsScreen(onOpenAsset: (Long) -> Unit) {
    val vm = appViewModel { AssetsViewModel(it) }
    val state by vm.state.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }

    // Debounced server-side search on the code/brand/type/registration columns.
    LaunchedEffect(query) {
        delay(350)
        vm.search(query)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Assets", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search code, brand, type, registration…") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            )
            StateContent(state, onRetry = { vm.refresh() }) { assets ->
                if (assets.isEmpty()) {
                    EmptyHint("No assets match")
                } else {
                    LazyColumn(
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(assets, key = { it.id }) { asset ->
                            AssetCard(asset, onClick = { onOpenAsset(asset.id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AssetCard(asset: AssetRow, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable { onClick() }) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    asset.code ?: "#${asset.id}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                when (asset.status) {
                    "under_repair" -> Pill("under repair", Amber)
                    "decommissioned" -> Pill("decommissioned", MaterialTheme.colorScheme.error)
                    else -> Pill(asset.status ?: "active", TealOk)
                }
            }
            Text(
                listOfNotNull(asset.brand, asset.type, asset.asset_class)
                    .joinToString(" · ").ifEmpty { "—" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    listOfNotNull(
                        asset.current_project,
                        asset.open_jobs?.takeIf { it > 0 }?.let { "$it open job${if (it > 1) "s" else ""}" },
                    ).joinToString(" · ").ifEmpty { "no open jobs" },
                    style = MaterialTheme.typography.bodySmall,
                    color = if ((asset.open_jobs ?: 0) > 0) Amber
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    money(asset.lifetime_cost),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}
