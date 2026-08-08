package com.workshopone.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.workshopone.app.AppContainer
import com.workshopone.app.data.Asset360
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.KeyValue
import com.workshopone.app.ui.common.LoaderViewModel
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.SectionCard
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.StatusPill
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.dash
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.common.qtyText
import com.workshopone.app.ui.common.shortDate
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.TealOk

class AssetDetailViewModel(c: AppContainer, assetId: Long) :
    LoaderViewModel<Asset360>({ c.api.asset360(assetId) })

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssetDetailScreen(
    assetId: Long,
    onOpenJob: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val vm = appViewModel(key = "asset$assetId") { AssetDetailViewModel(it, assetId) }
    val state by vm.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Asset 360", fontWeight = FontWeight.Bold) },
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
            val asset = data.asset
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    SectionCard(
                        asset.code ?: "#${asset.id}",
                        trailing = {
                            when (asset.status) {
                                "under_repair" -> Pill("under repair", Amber)
                                "decommissioned" -> Pill("decommissioned", MaterialTheme.colorScheme.error)
                                else -> Pill(asset.status ?: "active", TealOk)
                            }
                        },
                    ) {
                        KeyValue("Brand / type", listOfNotNull(asset.brand, asset.type).joinToString(" · ").ifEmpty { "—" })
                        if (!asset.registration.isNullOrBlank()) KeyValue("Registration", asset.registration)
                        if (!asset.model_no.isNullOrBlank()) KeyValue("Model", asset.model_no)
                        if (!asset.asset_class.isNullOrBlank()) KeyValue("Class", asset.asset_class)
                        KeyValue("Project", dash(data.current_project?.name))
                        if (asset.running_hours != null) KeyValue("Running hours", qtyText(asset.running_hours))
                        if (!asset.serial_no.isNullOrBlank()) KeyValue("Serial no", asset.serial_no)
                        if (!asset.engine_no.isNullOrBlank()) KeyValue("Engine no", asset.engine_no)
                        if (!asset.notes.isNullOrBlank()) KeyValue("Notes", asset.notes)
                    }
                }

                val due = data.service_due
                if (due != null) {
                    item {
                        SectionCard(
                            "Service",
                            trailing = {
                                if (due.due) Pill("DUE", MaterialTheme.colorScheme.error)
                                else Pill("ok", TealOk)
                            },
                        ) {
                            KeyValue("Interval", "${qtyText(due.interval_hours)} h")
                            KeyValue("Running hours", qtyText(due.running_hours))
                            if (!due.due && due.hours_remaining != null) {
                                KeyValue("Hours remaining", qtyText(due.hours_remaining))
                            }
                            if (due.expected_cost != null) {
                                KeyValue("Expected service cost", money(due.expected_cost))
                            }
                        }
                    }
                }

                item {
                    val lc = data.lifetime_cost
                    SectionCard("Lifetime cost") {
                        KeyValue("Labour", money(lc?.labour))
                        KeyValue("Material", money(lc?.material))
                        KeyValue("Oil", money(lc?.oil))
                        KeyValue("General", money(lc?.general))
                        KeyValue("External", money(lc?.external))
                        KeyValue("TOTAL", money(lc?.total), valueColor = MaterialTheme.colorScheme.primary)
                    }
                }

                val b = data.current_battery
                if (b != null) {
                    item {
                        SectionCard("Current battery") {
                            KeyValue("Serial", dash(b.serial_no))
                            KeyValue("Brand", dash(b.brand))
                            if (b.capacity_ah != null) KeyValue("Capacity", "${qtyText(b.capacity_ah)} Ah")
                            if (!b.warranty_date.isNullOrBlank()) KeyValue("Warranty until", shortDate(b.warranty_date))
                        }
                    }
                }

                item {
                    SectionCard("Open jobs") {
                        if (data.open_jobs.isEmpty()) EmptyHint("No open jobs")
                        data.open_jobs.forEach { job ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenJob(job.id) }
                                    .padding(vertical = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        job.job_no ?: "#${job.id}",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium,
                                    )
                                    Text(
                                        job.description ?: "",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                    )
                                }
                                StatusPill(job.status)
                            }
                        }
                    }
                }

                item {
                    SectionCard("Timeline") {
                        if (data.timeline.isEmpty()) EmptyHint("No history yet")
                        data.timeline.forEach { event ->
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Pill(event.kind ?: "?", kindColor(event.kind))
                                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                    Text(
                                        event.description ?: "",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 2,
                                    )
                                    Text(
                                        listOfNotNull(shortDate(event.date), event.ref)
                                            .joinToString(" · "),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }

                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}

@Composable
private fun kindColor(kind: String?) = when (kind) {
    "job" -> MaterialTheme.colorScheme.primary
    "oil" -> Amber
    "battery" -> TealOk
    "mrn", "mtn" -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.outline
}
