package com.workshopone.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.workshopone.app.AppContainer
import com.workshopone.app.data.AnomaliesResponse
import com.workshopone.app.data.IntegrityResponse
import com.workshopone.app.data.ServiceDueRow
import com.workshopone.app.ui.common.EmptyHint
import com.workshopone.app.ui.common.KeyValue
import com.workshopone.app.ui.common.LoaderViewModel
import com.workshopone.app.ui.common.Pill
import com.workshopone.app.ui.common.SectionCard
import com.workshopone.app.ui.common.StateContent
import com.workshopone.app.ui.common.appViewModel
import com.workshopone.app.ui.common.dash
import com.workshopone.app.ui.common.money
import com.workshopone.app.ui.common.qtyText
import com.workshopone.app.ui.theme.Amber
import com.workshopone.app.ui.theme.TealOk

data class AttentionPayload(
    val serviceDue: List<ServiceDueRow>,
    val anomalies: AnomaliesResponse,
    val integrity: IntegrityResponse,
)

class AttentionViewModel(c: AppContainer) : LoaderViewModel<AttentionPayload>({
    AttentionPayload(
        serviceDue = c.api.serviceDue(),
        anomalies = c.api.anomalies(),
        integrity = c.api.integrity(),
    )
})

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttentionScreen(onBack: () -> Unit) {
    val vm = appViewModel { AttentionViewModel(it) }
    val state by vm.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Needs Attention", fontWeight = FontWeight.Bold) },
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
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Text(
                        "Advisory only — the system flags, a human decides.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                item {
                    val due = data.serviceDue.filter { it.due }
                    SectionCard("Service due", trailing = { Pill("${due.size}", if (due.isEmpty()) TealOk else Amber) }) {
                        if (due.isEmpty()) EmptyHint("Nothing due")
                        due.forEach { row ->
                            KeyValue(
                                "${dash(row.asset_code)} · ${dash(row.machine_label ?: row.project)}",
                                if ((row.overdue_by ?: 0.0) > 0.0)
                                    "overdue ${qtyText(row.overdue_by)} h" +
                                        (row.expected_cost?.let { " · ~${money(it)}" } ?: "")
                                else "due now",
                                valueColor = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }

                item {
                    val rows = data.anomalies.unusual_consumption
                    SectionCard("Unusual consumption", trailing = { Pill("${rows.size}", if (rows.isEmpty()) TealOk else Amber) }) {
                        if (rows.isEmpty()) EmptyHint("No anomalies")
                        rows.forEach { r ->
                            KeyValue(
                                "${dash(r.asset_code)} · ${dash(r.product_name)}",
                                "×${qtyText(r.ratio)} vs own history (${qtyText(r.recent_rate)} ${r.unit ?: ""}/day)",
                                valueColor = Amber,
                            )
                        }
                    }
                }

                item {
                    val dup = data.anomalies.duplicate_mrn
                    val count = dup.duplicate_numbers.size + dup.likely_double_entries.size
                    SectionCard("Duplicate MRN", trailing = { Pill("$count", if (count == 0) TealOk else Amber) }) {
                        if (count == 0) EmptyHint("No duplicates found")
                        dup.duplicate_numbers.forEach { d ->
                            KeyValue("MRN ${dash(d.mrn_no)}", "used ${d.c}×", valueColor = Amber)
                        }
                        dup.likely_double_entries.forEach { d ->
                            KeyValue(
                                "${dash(d.asset_code)} · ${dash(d.description)}",
                                "${d.c}× on ${dash(d.req_date)} (${dash(d.mrn_nos)})",
                                valueColor = Amber,
                            )
                        }
                    }
                }

                item {
                    val rows = data.anomalies.grn_price_spikes
                    SectionCard("GRN price spikes", trailing = { Pill("${rows.size}", if (rows.isEmpty()) TealOk else Amber) }) {
                        if (rows.isEmpty()) EmptyHint("No price spikes")
                        rows.forEach { r ->
                            KeyValue(
                                dash(r.item),
                                "${money(r.unit_price)} vs avg ${money(r.baseline_avg)} (×${qtyText(r.ratio)})",
                                valueColor = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }

                item {
                    val integrity = data.integrity
                    SectionCard(
                        "Integrity check",
                        trailing = {
                            Pill("${integrity.count}", if (integrity.count == 0) TealOk else MaterialTheme.colorScheme.error)
                        },
                    ) {
                        if (integrity.issues.isEmpty()) EmptyHint("Everything reconciles ✓")
                        integrity.issues.forEach { issue ->
                            Text(
                                "• ${issue.detail ?: issue.type ?: "issue"}",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(vertical = 2.dp),
                            )
                        }
                    }
                }

                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}
