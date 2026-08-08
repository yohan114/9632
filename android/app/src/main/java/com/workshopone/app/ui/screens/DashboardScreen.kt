package com.workshopone.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import com.workshopone.app.data.Dashboard
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.KeyValue
import com.workshopone.app.ui.common.LoaderViewModel
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.SectionCard
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.common.qtyText
import com.workshopone.app.ui.common.shortDate
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.statusColor
import com.workshopone.app.data.JobStates

class DashboardViewModel(c: AppContainer) :
    LoaderViewModel<Dashboard>({ c.api.dashboard() })

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    onOpenJob: (Long) -> Unit,
    onOpenJobs: () -> Unit,
    onOpenAttention: () -> Unit,
) {
    val vm = appViewModel { DashboardViewModel(it) }
    val state by vm.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("WorkshopOne", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        StateContent(state, onRetry = { vm.refresh() }) { data ->
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        StatCard("Open jobs", data.open_jobs_count.toString())
                        StatCard("Closed this month", data.closed_this_month_count.toString())
                    }
                }

                val attention = data.needs_attention
                if (attention != null && attention.total > 0) {
                    item {
                        SectionCard(
                            "Needs attention",
                            modifier = Modifier.clickable { onOpenAttention() },
                            trailing = { Pill("${attention.total}", Amber) },
                        ) {
                            if (attention.service_due > 0)
                                KeyValue("Service due", attention.service_due.toString())
                            if (attention.unusual_consumption > 0)
                                KeyValue("Unusual consumption", attention.unusual_consumption.toString())
                            if (attention.duplicate_mrn > 0)
                                KeyValue("Duplicate MRN", attention.duplicate_mrn.toString())
                            if (attention.grn_price_spikes > 0)
                                KeyValue("GRN price spikes", attention.grn_price_spikes.toString())
                            if (attention.integrity_issues > 0)
                                KeyValue("Integrity issues", attention.integrity_issues.toString())
                            Text(
                                "Tap to review",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                item {
                    SectionCard("Jobs by status", modifier = Modifier.clickable { onOpenJobs() }) {
                        if (data.jobs_by_status.isEmpty()) EmptyHint("No job cards yet")
                        data.jobs_by_status.forEach { row ->
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Pill(JobStates.label(row.status), statusColor(row.status))
                                Text(
                                    row.count.toString(),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                    }
                }

                item {
                    SectionCard("Awaiting price (work complete)") {
                        if (data.awaiting_price.isEmpty()) EmptyHint("Nothing awaiting pricing")
                        data.awaiting_price.forEach { job ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenJob(job.id) }
                                    .padding(vertical = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Column {
                                    Text(
                                        job.job_no ?: "#${job.id}",
                                        fontWeight = FontWeight.Medium,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    Text(
                                        job.asset_code ?: "—",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (job.missing_count > 0) {
                                    Pill("${job.missing_count} missing", MaterialTheme.colorScheme.error)
                                } else {
                                    Pill("ready", MaterialTheme.colorScheme.tertiary)
                                }
                            }
                        }
                    }
                }

                item {
                    SectionCard("Low-stock lubricants") {
                        if (data.low_stock_oil.isEmpty()) EmptyHint("All lubricant stocks are healthy")
                        data.low_stock_oil.forEach { p ->
                            KeyValue(
                                p.name ?: "—",
                                "${qtyText(p.balance)} ${p.unit ?: ""} (reorder at ${qtyText(p.reorder_level)})",
                                valueColor = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }

                item {
                    SectionCard("Battery warranties expiring (60 days)") {
                        if (data.batteries_warranty.isEmpty()) EmptyHint("No warranties expiring soon")
                        data.batteries_warranty.forEach { b ->
                            KeyValue(
                                "${b.serial_no ?: "—"} · ${b.asset_code ?: "in store"}",
                                shortDate(b.warranty_date),
                            )
                        }
                    }
                }

                item {
                    SectionCard("This month's cost by project") {
                        if (data.month_cost_by_project.isEmpty()) EmptyHint("No costs recorded this month")
                        data.month_cost_by_project.forEach { p ->
                            KeyValue(p.project ?: "(unassigned)", money(p.total))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RowScope.StatCard(label: String, value: String) {
    Card(Modifier.weight(1f)) {
        Column(Modifier.padding(14.dp)) {
            Text(
                value,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
