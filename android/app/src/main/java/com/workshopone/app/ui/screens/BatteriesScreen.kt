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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
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
import com.workshopone.app.data.Battery
import com.workshopone.app.data.BatteryDetail
import com.workshopone.app.data.apiCall
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.KeyValue
import com.workshopone.app.ui.common.LoaderViewModel
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.SectionCard
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.UiState
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.dash
import com.workshopone.app.ui.common.qtyText
import com.workshopone.app.ui.common.shortDate
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.TealOk
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

private val BATTERY_STATES = listOf("installed", "in_store", "handed_over", "decommissioned")

class BatteriesViewModel(private val c: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow<UiState<List<Battery>>>(UiState.Loading)
    val state: StateFlow<UiState<List<Battery>>> = _state

    private val _stateFilter = MutableStateFlow<String?>(null)
    val stateFilter: StateFlow<String?> = _stateFilter

    private var lastQuery: String? = null

    init {
        load(null, null)
    }

    fun setStateFilter(state: String?) {
        _stateFilter.value = state
        load(lastQuery, state)
    }

    fun search(query: String?) = load(query, _stateFilter.value)

    fun refresh() = load(lastQuery, _stateFilter.value)

    private fun load(query: String?, state: String?) {
        lastQuery = query
        viewModelScope.launch {
            _state.value = UiState.Loading
            apiCall { c.api.batteries(q = query?.takeIf { it.isNotBlank() }, state = state) }
                .onSuccess { _state.value = UiState.Ready(it) }
                .onFailure { _state.value = UiState.Error(it.message ?: "Failed to load batteries") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BatteriesScreen(
    onOpenBattery: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val vm = appViewModel { BatteriesViewModel(it) }
    val state by vm.state.collectAsState()
    val stateFilter by vm.stateFilter.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(query) {
        delay(350)
        vm.search(query)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Batteries", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
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
                placeholder = { Text("Find by serial or brand…") },
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
                        selected = stateFilter == null,
                        onClick = { vm.setStateFilter(null) },
                        label = { Text("All") },
                    )
                }
                items(BATTERY_STATES) { s ->
                    FilterChip(
                        selected = stateFilter == s,
                        onClick = { vm.setStateFilter(if (stateFilter == s) null else s) },
                        label = { Text(s.replace('_', ' ')) },
                    )
                }
            }
            StateContent(state, onRetry = { vm.refresh() }) { batteries ->
                if (batteries.isEmpty()) {
                    EmptyHint("No batteries match")
                } else {
                    LazyColumn(
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(batteries, key = { it.id }) { battery ->
                            BatteryCard(battery, onClick = { onOpenBattery(battery.id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun batteryStatePill(state: String?) = when (state) {
    "installed" -> TealOk
    "in_store" -> MaterialTheme.colorScheme.primary
    "handed_over" -> Amber
    "decommissioned" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun BatteryCard(battery: Battery, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable { onClick() }) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    battery.serial_no ?: "#${battery.id}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Pill(
                    (battery.state ?: "?").replace('_', ' '),
                    batteryStatePill(battery.state),
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    listOfNotNull(
                        battery.brand,
                        battery.capacity_ah?.let { "${qtyText(it)} Ah" },
                        battery.current_asset_code?.let { "on $it" },
                    ).joinToString(" · ").ifEmpty { "—" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!battery.warranty_date.isNullOrBlank()) {
                    Text(
                        "warranty ${shortDate(battery.warranty_date)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

class BatteryDetailViewModel(c: AppContainer, batteryId: Long) :
    LoaderViewModel<BatteryDetail>({ c.api.battery(batteryId) })

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BatteryDetailScreen(
    batteryId: Long,
    onOpenAsset: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val vm = appViewModel(key = "battery$batteryId") { BatteryDetailViewModel(it, batteryId) }
    val state by vm.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Battery", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        StateContent(state, onRetry = { vm.refresh() }) { data ->
            val battery = data.battery
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    SectionCard(
                        battery.serial_no ?: "#${battery.id}",
                        trailing = {
                            Pill(
                                (battery.state ?: "?").replace('_', ' '),
                                batteryStatePill(battery.state),
                            )
                        },
                    ) {
                        KeyValue("Brand", dash(battery.brand))
                        if (battery.capacity_ah != null) KeyValue("Capacity", "${qtyText(battery.capacity_ah)} Ah")
                        KeyValue("Condition", dash(battery.condition))
                        if (!battery.purchase_date.isNullOrBlank()) KeyValue("Purchased", shortDate(battery.purchase_date))
                        if (!battery.warranty_date.isNullOrBlank()) KeyValue("Warranty until", shortDate(battery.warranty_date))
                        val currentAssetId = battery.current_asset_id
                        if (currentAssetId != null) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenAsset(currentAssetId) }
                                    .padding(vertical = 3.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    "Installed on",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    dash(battery.current_asset_code),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                }

                item {
                    SectionCard("History") {
                        if (data.events.isEmpty()) EmptyHint("No events recorded")
                        data.events.forEach { event ->
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Pill(event.event_type ?: "?", MaterialTheme.colorScheme.primary)
                                    Text(
                                        shortDate(event.event_date),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                val move = listOfNotNull(
                                    event.from_asset_code?.let { "from $it" },
                                    event.to_asset_code?.let { "to $it" },
                                ).joinToString(" ")
                                if (move.isNotBlank() || !event.reason.isNullOrBlank()) {
                                    Text(
                                        listOfNotNull(
                                            move.takeIf { it.isNotBlank() },
                                            event.reason,
                                            event.username?.let { "by $it" },
                                        ).joinToString(" · "),
                                        style = MaterialTheme.typography.bodySmall,
                                        modifier = Modifier.padding(top = 2.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
