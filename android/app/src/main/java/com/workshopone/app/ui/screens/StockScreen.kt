package com.workshopone.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
import com.workshopone.app.AppContainer
import com.workshopone.app.data.ForecastRow
import com.workshopone.app.data.LedgerRow
import com.workshopone.app.data.OilForecast
import com.workshopone.app.data.StoreItem
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.KeyValue
import com.workshopone.app.ui.common.LoaderViewModel
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.dash
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.common.qtyText
import com.workshopone.app.ui.common.shortDate
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.TealOk

data class StockPayload(
    val forecast: OilForecast,
    val ledger: List<LedgerRow>,
    val reorder: List<StoreItem>,
)

class StockViewModel(c: AppContainer) : LoaderViewModel<StockPayload>({
    StockPayload(
        forecast = c.api.oilForecast(),
        ledger = c.api.oilLedger(limit = 100),
        reorder = try {
            c.api.storeReorder()
        } catch (_: Exception) {
            emptyList()
        },
    )
})

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StockScreen() {
    val vm = appViewModel { StockViewModel(it) }
    val state by vm.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Stock", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Lubricants") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Oil ledger") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("Store reorder") })
            }
            StateContent(state, onRetry = { vm.refresh() }) { data ->
                when (tab) {
                    0 -> ForecastList(data.forecast)
                    1 -> LedgerList(data.ledger)
                    else -> ReorderList(data.reorder)
                }
            }
        }
    }
}

@Composable
private fun ForecastList(forecast: OilForecast) {
    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Text(
                "Consumption window: ${forecast.window_days} days · low-stock threshold: ${forecast.low_stock_days} days of cover",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (forecast.products.isEmpty()) {
            item { EmptyHint("No lubricant products") }
        }
        forecast.products.forEach { p ->
            item {
                ForecastCard(p)
            }
        }
    }
}

@Composable
private fun ForecastCard(p: ForecastRow) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    p.name ?: "#${p.product_id}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                if (p.low) Pill("LOW — reorder", MaterialTheme.colorScheme.error)
                else Pill("ok", TealOk)
            }
            KeyValue("Balance", "${qtyText(p.balance)} ${p.unit ?: ""}")
            KeyValue("Daily rate", "${qtyText(p.daily_rate)} ${p.unit ?: ""}/day")
            KeyValue(
                "Days of cover",
                p.days_of_cover?.let { qtyText(it) } ?: "∞",
                valueColor = if (p.low) MaterialTheme.colorScheme.error else androidx.compose.ui.graphics.Color.Unspecified,
            )
            if ((p.reorder_level ?: 0.0) > 0.0) {
                KeyValue("Reorder level", qtyText(p.reorder_level))
            }
        }
    }
}

@Composable
private fun LedgerList(ledger: List<LedgerRow>) {
    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (ledger.isEmpty()) item { EmptyHint("No ledger entries") }
        ledger.forEach { row ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                dash(row.product_name),
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                            )
                            Pill(row.kind ?: "?", kindPillColor(row.kind))
                        }
                        Row(
                            Modifier.fillMaxWidth().padding(top = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                listOfNotNull(
                                    shortDate(row.txn_date),
                                    row.asset_code,
                                    row.consumer,
                                ).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                "${qtyText(row.qty)} → ${qtyText(row.balance_after)} ${row.unit ?: ""}",
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun kindPillColor(kind: String?) = when (kind) {
    "issue" -> Amber
    "receipt", "transfer" -> TealOk
    "adjustment", "opening" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun ReorderList(items: List<StoreItem>) {
    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                "General store items at or below their minimum stock",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (items.isEmpty()) item { EmptyHint("Nothing needs reordering") }
        items.forEach { itemRow ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        Text(
                            dash(itemRow.name),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                        Row(
                            Modifier.fillMaxWidth().padding(top = 2.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                listOfNotNull(itemRow.part_number, itemRow.rack)
                                    .joinToString(" · ").ifEmpty { "—" },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                "${qtyText(itemRow.balance)} / min ${qtyText(itemRow.min_stock)} ${itemRow.unit ?: ""}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                }
            }
        }
    }
}
