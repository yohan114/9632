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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import com.workshopone.app.AppContainer
import com.workshopone.app.data.DailyWorkLine
import com.workshopone.app.data.DailyWorkRequest
import com.workshopone.app.data.FlatLabourRequest
import com.workshopone.app.data.JobDetail
import com.workshopone.app.data.JobPart
import com.workshopone.app.data.JobStates
import com.workshopone.app.data.Mechanic
import com.workshopone.app.data.PartPatchRequest
import com.workshopone.app.data.PartRequest
import com.workshopone.app.data.Roles
import com.workshopone.app.data.TransitionAction
import com.workshopone.app.data.TransitionRequest
import com.workshopone.app.data.apiCall
import com.workshopone.app.data.hasRole
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate

class JobDetailViewModel(private val c: AppContainer, private val jobId: Long) :
    LoaderViewModel<JobDetail>({ c.api.job(jobId) }) {

    val user get() = c.session.user

    private val _mechanics = MutableStateFlow<List<Mechanic>>(emptyList())
    val mechanics: StateFlow<List<Mechanic>> = _mechanics

    init {
        viewModelScope.launch {
            apiCall { c.api.mechanics() }.onSuccess { _mechanics.value = it }
        }
    }

    fun transition(to: String, reason: String?) =
        mutate { c.api.transition(jobId, TransitionRequest(to, reason?.takeIf { it.isNotBlank() })) }

    fun addDailyWork(request: DailyWorkRequest, onDone: () -> Unit) =
        mutate(onDone) { c.api.addDailyWork(jobId, request) }

    fun deleteDailyWork(lineId: Long) =
        mutate { c.api.deleteDailyWork(jobId, lineId) }

    fun addPart(request: PartRequest, onDone: () -> Unit) =
        mutate(onDone) { c.api.addPart(jobId, request) }

    fun updatePart(partId: Long, qty: Double?, unitPrice: Double?, onDone: () -> Unit) =
        mutate(onDone) { c.api.updatePart(jobId, partId, PartPatchRequest(unit_price = unitPrice, qty = qty)) }

    fun deletePart(partId: Long) =
        mutate { c.api.deletePart(jobId, partId) }

    fun setFlatLabour(amount: Double?, onDone: () -> Unit) =
        mutate(onDone) { c.api.setFlatLabour(jobId, FlatLabourRequest(amount)) }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun JobDetailScreen(
    jobId: Long,
    onOpenAsset: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val vm = appViewModel(key = "job$jobId") { JobDetailViewModel(it, jobId) }
    val state by vm.state.collectAsState()
    val notice by vm.notice.collectAsState()
    val user by vm.user.collectAsState()
    val mechanics by vm.mechanics.collectAsState()

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(notice) {
        notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }

    var transitionAsk by remember { mutableStateOf<TransitionAction?>(null) }
    var showDailyWork by remember { mutableStateOf(false) }
    var showAddPart by remember { mutableStateOf(false) }
    var editPart by remember { mutableStateOf<JobPart?>(null) }
    var showFlatLabour by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Job Card", fontWeight = FontWeight.Bold) },
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
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        StateContent(state, onRetry = { vm.refresh() }) { detail ->
            val job = detail.job
            val closed = job.status == JobStates.CLOSED
            val editable = !closed || user.hasRole(Roles.ADMIN)
            val isWorkshop = user.hasRole(Roles.WORKSHOP)
            val canEditParts = user.hasRole(Roles.WORKSHOP, Roles.STOREKEEPER)
            val actions = JobStates.availableFor(user, job.status)

            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // ---- header -------------------------------------------------
                item {
                    SectionCard(job.job_no ?: "#${job.id}", trailing = { StatusPill(job.status) }) {
                        Text(
                            job.description ?: "",
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(bottom = 6.dp),
                        )
                        KeyValue("Type", listOfNotNull(job.type, job.severity).joinToString(" · ").ifEmpty { "—" })
                        val assetId = job.asset_id
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .let { m ->
                                    if (assetId != null) m.clickable { onOpenAsset(assetId) } else m
                                }
                                .padding(vertical = 3.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "Asset",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                dash(job.asset_code),
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = if (job.asset_id != null) MaterialTheme.colorScheme.primary
                                else androidx.compose.ui.graphics.Color.Unspecified,
                            )
                        }
                        KeyValue("Project", dash(job.project_name))
                        if (!job.site.isNullOrBlank()) KeyValue("Site", job.site)
                        KeyValue("Requested", "${dash(job.requested_by)} · ${shortDate(job.requested_at)}")
                        if (job.started_at != null) KeyValue("Started", shortDate(job.started_at))
                        if (job.completed_at != null) KeyValue("Completed", shortDate(job.completed_at))
                        if (job.closed_at != null) KeyValue("Closed", shortDate(job.closed_at))
                    }
                }

                // ---- actions ------------------------------------------------
                if (actions.isNotEmpty()) {
                    item {
                        SectionCard("Actions") {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                actions.forEach { action ->
                                    Button(
                                        onClick = { transitionAsk = action },
                                        colors = if (action.destructive) {
                                            ButtonDefaults.buttonColors(
                                                containerColor = MaterialTheme.colorScheme.error,
                                                contentColor = MaterialTheme.colorScheme.onError,
                                            )
                                        } else ButtonDefaults.buttonColors(),
                                    ) { Text(action.label) }
                                }
                            }
                        }
                    }
                }

                // ---- cost ---------------------------------------------------
                item {
                    val cost = detail.cost
                    SectionCard(
                        "Cost",
                        trailing = {
                            if (closed && detail.snapshot != null) Pill("frozen snapshot", MaterialTheme.colorScheme.tertiary)
                        },
                    ) {
                        KeyValue("Labour", money(cost?.labour_cost ?: job.labour_cost))
                        KeyValue("Material", money(cost?.material_cost ?: job.material_cost))
                        KeyValue("Oil", money(cost?.oil_cost ?: job.oil_cost))
                        KeyValue("General", money(cost?.general_cost ?: job.general_cost))
                        KeyValue("External", money(cost?.external_cost ?: job.external_cost))
                        KeyValue(
                            "TOTAL",
                            money(cost?.total_cost ?: job.total_cost),
                            valueColor = MaterialTheme.colorScheme.primary,
                        )
                    }
                }

                // ---- closure readiness -------------------------------------
                val readiness = detail.readiness
                if (readiness != null && !readiness.ready && !closed && job.status != JobStates.REJECTED) {
                    item {
                        SectionCard("Blocking closure", trailing = { Pill("${readiness.missing.size}", Amber) }) {
                            readiness.missing.forEach { line ->
                                Text(
                                    "• $line",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(vertical = 2.dp),
                                )
                            }
                        }
                    }
                }

                // ---- labour -------------------------------------------------
                item {
                    SectionCard(
                        "Labour",
                        trailing = {
                            if (job.type == "service" && editable && user.hasRole(Roles.WORKSHOP, Roles.OPS)) {
                                TextButton(onClick = { showFlatLabour = true }) { Text("Set flat charge") }
                            }
                        },
                    ) {
                        val lines = detail.labour.ifEmpty { detail.cost?.labourLines ?: emptyList() }
                        if (lines.isEmpty()) EmptyHint("No labour recorded")
                        lines.forEach { l ->
                            KeyValue(
                                "${shortDate(l.work_date)} · ${dash(l.mechanic)}" +
                                    if ((l.hours ?: 0.0) > 0.0) " · ${qtyText(l.hours)} h" else "",
                                if (l.rate != null) "${money(l.rate)}/h → ${money(l.amount)}" else money(l.amount),
                            )
                        }
                    }
                }

                // ---- daily work --------------------------------------------
                item {
                    SectionCard(
                        "Daily work",
                        trailing = {
                            if (isWorkshop && editable) {
                                TextButton(onClick = { showDailyWork = true }) { Text("Add") }
                            }
                        },
                    ) {
                        if (detail.dailyWork.isEmpty()) EmptyHint("No daily work entries")
                        detail.dailyWork.forEach { w ->
                            DailyWorkRow(
                                w,
                                canDelete = isWorkshop && editable,
                                onDelete = { vm.deleteDailyWork(w.id) },
                            )
                        }
                    }
                }

                // ---- parts --------------------------------------------------
                item {
                    SectionCard(
                        "Parts & external repairs",
                        trailing = {
                            if (canEditParts && editable) {
                                TextButton(onClick = { showAddPart = true }) { Text("Add") }
                            }
                        },
                    ) {
                        if (detail.parts.isEmpty()) EmptyHint("No part lines")
                        detail.parts.forEach { p ->
                            PartRow(
                                p,
                                canEdit = canEditParts && editable,
                                onEdit = { editPart = p },
                                onDelete = { vm.deletePart(p.id) },
                            )
                        }
                    }
                }

                // ---- oil issues --------------------------------------------
                item {
                    SectionCard("Oil & lubricant issues") {
                        if (detail.oilIssues.isEmpty()) EmptyHint("No oil issued to this job")
                        detail.oilIssues.forEach { o ->
                            KeyValue(
                                "${shortDate(o.txn_date)} · ${dash(o.product_name)}",
                                "${qtyText(Math.abs(o.qty ?: 0.0))} ${o.unit ?: ""}" +
                                    (o.unit_price?.let { " @ ${money(it)}" } ?: ""),
                            )
                        }
                    }
                }

                // ---- general issues ----------------------------------------
                item {
                    SectionCard("General items") {
                        if (detail.generalIssues.isEmpty()) EmptyHint("No general items issued")
                        detail.generalIssues.forEach { g ->
                            KeyValue(
                                "${shortDate(g.txn_date)} · ${dash(g.item_name)}",
                                "${qtyText(Math.abs(g.qty ?: 0.0))}" +
                                    (g.unit_price?.let { " @ ${money(it)}" } ?: ""),
                            )
                        }
                    }
                }

                // ---- approvals ---------------------------------------------
                if (detail.approvals.isNotEmpty()) {
                    item {
                        SectionCard("Approvals") {
                            detail.approvals.forEach { a ->
                                KeyValue(
                                    "${dash(a.role)} · ${dash(a.decision)}",
                                    a.reason?.takeIf { it.isNotBlank() } ?: shortDate(a.created_at),
                                )
                            }
                        }
                    }
                }

                item { Spacer(Modifier.height(24.dp)) }
            }

            // ---- dialogs ---------------------------------------------------
            transitionAsk?.let { action ->
                TransitionDialog(
                    action = action,
                    onConfirm = { reason ->
                        vm.transition(action.target, reason)
                        transitionAsk = null
                    },
                    onDismiss = { transitionAsk = null },
                )
            }
            if (showDailyWork) {
                DailyWorkDialog(
                    mechanics = mechanics,
                    onSubmit = { req -> vm.addDailyWork(req) { showDailyWork = false } },
                    onDismiss = { showDailyWork = false },
                )
            }
            if (showAddPart) {
                AddPartDialog(
                    onSubmit = { req -> vm.addPart(req) { showAddPart = false } },
                    onDismiss = { showAddPart = false },
                )
            }
            editPart?.let { part ->
                EditPartDialog(
                    part = part,
                    onSubmit = { qty, price -> vm.updatePart(part.id, qty, price) { editPart = null } },
                    onDismiss = { editPart = null },
                )
            }
            if (showFlatLabour) {
                FlatLabourDialog(
                    current = job.flat_labour,
                    onSubmit = { amount -> vm.setFlatLabour(amount) { showFlatLabour = false } },
                    onDismiss = { showFlatLabour = false },
                )
            }
        }
    }
}

@Composable
private fun DailyWorkRow(w: DailyWorkLine, canDelete: Boolean, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "${shortDate(w.work_date)} · " +
                    if (w.is_external == 1) "External repair" else dash(w.mechanic),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            if (!w.description.isNullOrBlank()) {
                Text(
                    w.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            if (w.is_external == 1) money(w.external_value) else "${qtyText(w.hours)} h",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (canDelete) {
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "Delete",
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun PartRow(p: JobPart, canEdit: Boolean, onEdit: () -> Unit, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                dash(p.description),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill(p.source_type ?: "?", MaterialTheme.colorScheme.primary)
                if (p.is_external_repair == 1) Pill("external repair", Amber)
                if (p.unit_price == null) Pill("awaiting price", MaterialTheme.colorScheme.error)
            }
        }
        Text(
            "${qtyText(p.qty)} × ${p.unit_price?.let { money(it) } ?: "—"}",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (canEdit) {
            IconButton(onClick = onEdit) {
                Icon(Icons.Filled.Edit, contentDescription = "Edit")
            }
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "Delete",
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun TransitionDialog(
    action: TransitionAction,
    onConfirm: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(action.label) },
        text = {
            Column {
                if (action.target == JobStates.CLOSED) {
                    Text(
                        "Closing freezes the cost snapshot. The server refuses if any line is unpriced.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                if (action.asksReason) {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("Reason") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text("Confirm: ${action.label}?")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(reason.takeIf { it.isNotBlank() }) }) { Text("Confirm") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DailyWorkDialog(
    mechanics: List<Mechanic>,
    onSubmit: (DailyWorkRequest) -> Unit,
    onDismiss: () -> Unit,
) {
    var workDate by remember { mutableStateOf(LocalDate.now().toString()) }
    var mechanic by remember { mutableStateOf("") }
    var hours by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var external by remember { mutableStateOf(false) }
    var externalValue by remember { mutableStateOf("") }

    val valid = if (external) externalValue.toDoubleOrNull() != null
    else mechanic.isNotBlank() && (hours.toDoubleOrNull() ?: 0.0) > 0.0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add daily work") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = workDate,
                    onValueChange = { workDate = it },
                    label = { Text("Date (YYYY-MM-DD)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = external, onCheckedChange = { external = it })
                    Text("External repair", modifier = Modifier.padding(start = 8.dp))
                }
                if (external) {
                    OutlinedTextField(
                        value = externalValue,
                        onValueChange = { externalValue = it },
                        label = { Text("External value (Rs)") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = mechanic,
                        onValueChange = { mechanic = it },
                        label = { Text("Mechanic(s), comma-separated") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (mechanics.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            mechanics.take(8).forEach { m ->
                                AssistChip(
                                    onClick = {
                                        val name = m.name ?: return@AssistChip
                                        mechanic =
                                            if (mechanic.isBlank()) name else "$mechanic, $name"
                                    },
                                    label = { Text(m.name ?: "?") },
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = hours,
                        onValueChange = { hours = it },
                        label = { Text("Total crew hours") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Work description") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = {
                    onSubmit(
                        DailyWorkRequest(
                            work_date = workDate.takeIf { it.isNotBlank() },
                            mechanic = if (external) null else mechanic,
                            hours = if (external) null else hours.toDoubleOrNull(),
                            description = description.takeIf { it.isNotBlank() },
                            is_external = if (external) true else null,
                            external_value = if (external) externalValue.toDoubleOrNull() else null,
                        )
                    )
                },
            ) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AddPartDialog(
    onSubmit: (PartRequest) -> Unit,
    onDismiss: () -> Unit,
) {
    var sourceType by remember { mutableStateOf("grn") }
    var description by remember { mutableStateOf("") }
    var qty by remember { mutableStateOf("1") }
    var price by remember { mutableStateOf("") }
    var externalRepair by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add part line") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Source", style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("grn", "issue", "external").forEach { s ->
                        androidx.compose.material3.FilterChip(
                            selected = sourceType == s,
                            onClick = { sourceType = s },
                            label = { Text(s) },
                        )
                    }
                }
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Description") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = qty,
                    onValueChange = { qty = it },
                    label = { Text("Quantity") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text("Unit price (blank = price later)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = externalRepair, onCheckedChange = { externalRepair = it })
                    Text("External repair line", modifier = Modifier.padding(start = 8.dp))
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = description.isNotBlank(),
                onClick = {
                    onSubmit(
                        PartRequest(
                            source_type = sourceType,
                            description = description,
                            qty = qty.toDoubleOrNull() ?: 1.0,
                            unit_price = price.toDoubleOrNull(),
                            is_external_repair = if (externalRepair) true else null,
                        )
                    )
                },
            ) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun EditPartDialog(
    part: JobPart,
    onSubmit: (Double?, Double?) -> Unit,
    onDismiss: () -> Unit,
) {
    var qty by remember { mutableStateOf(part.qty?.let { qtyText(it) } ?: "") }
    var price by remember { mutableStateOf(part.unit_price?.toString() ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit part line") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(dash(part.description), fontWeight = FontWeight.Medium)
                OutlinedTextField(
                    value = qty,
                    onValueChange = { qty = it },
                    label = { Text("Quantity") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = price,
                    onValueChange = { price = it },
                    label = { Text("Unit price") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(qty.toDoubleOrNull(), price.toDoubleOrNull()) }) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun FlatLabourDialog(
    current: Double?,
    onSubmit: (Double?) -> Unit,
    onDismiss: () -> Unit,
) {
    var amount by remember { mutableStateOf(current?.toString() ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Service flat labour charge") },
        text = {
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it },
                label = { Text("Amount (Rs)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(amount.toDoubleOrNull()) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
