package com.workshopone.app.data

// ---------------------------------------------------------------------------
// DTOs mirroring the WorkshopOne REST API JSON exactly. Most payloads come
// straight from SQLite rows, so field names are snake_case; the auth
// endpoints return camelCase (fullName / mustChangePassword).
// ---------------------------------------------------------------------------

data class HealthResponse(val ok: Boolean = false, val name: String? = null)

data class OkResponse(val ok: Boolean = false)

data class LoginRequest(val username: String, val password: String)

data class ChangePasswordRequest(
    val current_password: String? = null,
    val new_password: String,
)

data class UserInfo(
    val id: Long = 0,
    val username: String = "",
    val fullName: String? = null,
    val roles: List<String> = emptyList(),
    val mustChangePassword: Boolean = false,
)

data class ApiErrorBody(
    val error: String? = null,
    val missing: List<String>? = null,
    val need: List<String>? = null,
)

// ---- dashboard ------------------------------------------------------------

data class StatusCount(val status: String? = null, val count: Int = 0)

data class AwaitingPriceJob(
    val id: Long = 0,
    val job_no: String? = null,
    val asset_code: String? = null,
    val missing_count: Int = 0,
)

data class LowStockOil(
    val id: Long = 0,
    val name: String? = null,
    val unit: String? = null,
    val balance: Double = 0.0,
    val reorder_level: Double? = null,
)

data class WarrantyRow(
    val serial_no: String? = null,
    val warranty_date: String? = null,
    val asset_code: String? = null,
)

data class ProjectCostRow(val project: String? = null, val total: Double = 0.0)

data class NeedsAttentionSummary(
    val service_due: Int = 0,
    val unusual_consumption: Int = 0,
    val duplicate_mrn: Int = 0,
    val grn_price_spikes: Int = 0,
    val integrity_issues: Int = 0,
) {
    val total: Int
        get() = service_due + unusual_consumption + duplicate_mrn + grn_price_spikes + integrity_issues
}

data class Dashboard(
    val jobs_by_status: List<StatusCount> = emptyList(),
    val awaiting_price: List<AwaitingPriceJob> = emptyList(),
    val low_stock_oil: List<LowStockOil> = emptyList(),
    val batteries_warranty: List<WarrantyRow> = emptyList(),
    val month_cost_by_project: List<ProjectCostRow> = emptyList(),
    val open_jobs_count: Int = 0,
    val closed_this_month_count: Int = 0,
    val needs_attention: NeedsAttentionSummary? = null,
)

// ---- job cards ------------------------------------------------------------

data class JobSummary(
    val id: Long = 0,
    val job_no: String? = null,
    val type: String? = null,
    val severity: String? = null,
    val status: String? = null,
    val description: String? = null,
    val total_cost: Double? = null,
    val requested_at: String? = null,
    val closed_at: String? = null,
    val asset_code: String? = null,
    val project_name: String? = null,
)

data class Job(
    val id: Long = 0,
    val job_no: String? = null,
    val ref: String? = null,
    val asset_id: Long? = null,
    val project_id: Long? = null,
    val site: String? = null,
    val type: String? = null,
    val severity: String? = null,
    val description: String? = null,
    val status: String? = null,
    val requested_by: String? = null,
    val flat_labour: Double? = null,
    val labour_cost: Double? = null,
    val material_cost: Double? = null,
    val oil_cost: Double? = null,
    val general_cost: Double? = null,
    val external_cost: Double? = null,
    val total_cost: Double? = null,
    val requested_at: String? = null,
    val approved_transport_at: String? = null,
    val approved_ops_at: String? = null,
    val started_at: String? = null,
    val completed_at: String? = null,
    val closed_at: String? = null,
    val updated_at: String? = null,
    val asset_code: String? = null,
    val project_name: String? = null,
    // present on the transition response ({...job, nextStates})
    val nextStates: List<String>? = null,
)

data class JobApproval(
    val id: Long = 0,
    val job_id: Long = 0,
    val role: String? = null,
    val approver_id: Long? = null,
    val decision: String? = null,
    val reason: String? = null,
    val created_at: String? = null,
)

data class DailyWorkLine(
    val id: Long = 0,
    val job_id: Long = 0,
    val work_date: String? = null,
    val mechanic: String? = null,
    val description: String? = null,
    val hours: Double? = null,
    val is_external: Int? = null,
    val external_value: Double? = null,
)

data class JobPart(
    val id: Long = 0,
    val job_id: Long = 0,
    val source_type: String? = null,
    val source_id: Long? = null,
    val description: String? = null,
    val qty: Double? = null,
    val unit_price: Double? = null,
    val is_external_repair: Int? = null,
)

data class LabourLine(
    val mechanic: String? = null,
    val hours: Double? = null,
    val rate: Double? = null,
    val amount: Double? = null,
    val work_date: String? = null,
    val flat: Boolean? = null,
)

data class OilIssueLine(
    val id: Long = 0,
    val product_id: Long = 0,
    val kind: String? = null,
    val qty: Double? = null,
    val unit_price: Double? = null,
    val txn_date: String? = null,
    val note: String? = null,
    val product_name: String? = null,
    val unit: String? = null,
)

data class GeneralIssueLine(
    val id: Long = 0,
    val store_item_id: Long = 0,
    val txn_type: String? = null,
    val qty: Double? = null,
    val unit_price: Double? = null,
    val txn_date: String? = null,
    val ref: String? = null,
    val item_name: String? = null,
)

data class JobCost(
    val labour_cost: Double = 0.0,
    val material_cost: Double = 0.0,
    val oil_cost: Double = 0.0,
    val general_cost: Double = 0.0,
    val external_cost: Double = 0.0,
    val total_cost: Double = 0.0,
    val labourLines: List<LabourLine> = emptyList(),
)

data class ClosureReadiness(
    val ready: Boolean = false,
    val missing: List<String> = emptyList(),
)

data class JobDetail(
    val job: Job = Job(),
    val approvals: List<JobApproval> = emptyList(),
    val dailyWork: List<DailyWorkLine> = emptyList(),
    val parts: List<JobPart> = emptyList(),
    val labour: List<LabourLine> = emptyList(),
    val oilIssues: List<OilIssueLine> = emptyList(),
    val generalIssues: List<GeneralIssueLine> = emptyList(),
    val cost: JobCost? = null,
    val readiness: ClosureReadiness? = null,
    val snapshot: Map<String, Any?>? = null,
    val nextStates: List<String> = emptyList(),
)

data class NewJobRequest(
    val description: String,
    val asset: String? = null,
    val asset_id: Long? = null,
    val type: String? = null,
    val severity: String? = null,
    val site: String? = null,
    val project_id: Long? = null,
    val ref: String? = null,
)

data class UnresolvedAlias(val aliasId: Long? = null, val raw: String? = null)

data class CreateJobResponse(val job: Job = Job(), val unresolved: UnresolvedAlias? = null)

data class TransitionRequest(val to: String, val reason: String? = null)

data class DailyWorkRequest(
    val work_date: String? = null,
    val mechanic: String? = null,
    val mechanics: List<String>? = null,
    val hours: Double? = null,
    val description: String? = null,
    val is_external: Boolean? = null,
    val external_value: Double? = null,
)

data class PartRequest(
    val source_type: String,
    val description: String,
    val source_id: Long? = null,
    val qty: Double? = null,
    val unit_price: Double? = null,
    val is_external_repair: Boolean? = null,
)

data class PartPatchRequest(
    val unit_price: Double? = null,
    val qty: Double? = null,
)

data class FlatLabourRequest(val flat_labour: Double?)

// ---- assets ---------------------------------------------------------------

data class Asset(
    val id: Long = 0,
    val code: String? = null,
    val registration: String? = null,
    val ec_code: String? = null,
    val brand: String? = null,
    val type: String? = null,
    val model_no: String? = null,
    val capacity: String? = null,
    val yom: String? = null,
    val serial_no: String? = null,
    val chassis_no: String? = null,
    val engine_no: String? = null,
    val asset_class: String? = null,
    val home_project_id: Long? = null,
    val current_project_id: Long? = null,
    val status: String? = null,
    val running_hours: Double? = null,
    val notes: String? = null,
)

data class AssetRow(
    val id: Long = 0,
    val code: String? = null,
    val registration: String? = null,
    val brand: String? = null,
    val type: String? = null,
    val asset_class: String? = null,
    val status: String? = null,
    val running_hours: Double? = null,
    val current_project: String? = null,
    val open_jobs: Int? = null,
    val current_battery: String? = null,
    val lifetime_cost: Double? = null,
)

data class CostBuckets(
    val labour: Double = 0.0,
    val material: Double = 0.0,
    val oil: Double = 0.0,
    val general: Double = 0.0,
    val external: Double = 0.0,
    val total: Double = 0.0,
)

data class ServiceDueInfo(
    val interval_hours: Double? = null,
    val running_hours: Double? = null,
    val due: Boolean = false,
    val hours_remaining: Double? = null,
    val expected_cost: Double? = null,
)

data class TimelineEvent(
    val date: String? = null,
    val kind: String? = null,
    val ref: String? = null,
    val description: String? = null,
)

data class Asset360(
    val asset: Asset = Asset(),
    val current_project: Project? = null,
    val current_battery: Battery? = null,
    val open_jobs: List<JobSummary> = emptyList(),
    val lifetime_cost: CostBuckets? = null,
    val service_due: ServiceDueInfo? = null,
    val timeline: List<TimelineEvent> = emptyList(),
)

// ---- projects -------------------------------------------------------------

data class Project(
    val id: Long = 0,
    val code: String? = null,
    val name: String? = null,
    val location: String? = null,
    val active: Int? = null,
    val asset_count: Int? = null,
    val month_cost: Double? = null,
)

// ---- oil & lubricant ------------------------------------------------------

data class ForecastRow(
    val product_id: Long = 0,
    val name: String? = null,
    val unit: String? = null,
    val balance: Double = 0.0,
    val reorder_level: Double? = null,
    val consumption_window: Double? = null,
    val daily_rate: Double? = null,
    val days_of_cover: Double? = null,
    val low: Boolean = false,
    val suggested_reorder: Boolean = false,
)

data class OilForecast(
    val window_days: Int = 0,
    val low_stock_days: Int = 0,
    val products: List<ForecastRow> = emptyList(),
)

data class LedgerRow(
    val id: Long = 0,
    val product_id: Long = 0,
    val kind: String? = null,
    val qty: Double? = null,
    val balance_after: Double? = null,
    val unit_price: Double? = null,
    val asset_id: Long? = null,
    val job_id: Long? = null,
    val consumer: String? = null,
    val txn_date: String? = null,
    val note: String? = null,
    val product_name: String? = null,
    val unit: String? = null,
    val asset_code: String? = null,
)

// ---- stores ---------------------------------------------------------------

data class StoreItem(
    val id: Long = 0,
    val name: String? = null,
    val part_number: String? = null,
    val category: String? = null,
    val unit: String? = null,
    val rack: String? = null,
    val min_stock: Double? = null,
    val is_general: Int? = null,
    val balance: Double? = null,
)

// ---- batteries ------------------------------------------------------------

data class Battery(
    val id: Long = 0,
    val serial_no: String? = null,
    val brand: String? = null,
    val capacity_ah: Double? = null,
    val condition: String? = null,
    val purchase_date: String? = null,
    val warranty_date: String? = null,
    val current_asset_id: Long? = null,
    val state: String? = null,
    val current_asset_code: String? = null,
)

data class BatteryEvent(
    val id: Long = 0,
    val event_type: String? = null,
    val from_asset_id: Long? = null,
    val to_asset_id: Long? = null,
    val reason: String? = null,
    val mtn_ref: String? = null,
    val event_date: String? = null,
    val from_asset_code: String? = null,
    val to_asset_code: String? = null,
    val username: String? = null,
)

data class BatteryDetail(
    val battery: Battery = Battery(),
    val events: List<BatteryEvent> = emptyList(),
)

// ---- mechanics ------------------------------------------------------------

data class Mechanic(
    val id: Long = 0,
    val name: String? = null,
    val rate: Double? = null,
)

// ---- needs attention (advisory intelligence) ------------------------------

data class ServiceDueRow(
    val asset_id: Long = 0,
    val asset_code: String? = null,
    val machine_label: String? = null,
    val project: String? = null,
    val running_hours: Double? = null,
    val interval_hours: Double? = null,
    val due: Boolean = false,
    val overdue_by: Double? = null,
    val hours_remaining: Double? = null,
    val expected_cost: Double? = null,
)

data class UnusualConsumptionRow(
    val asset_code: String? = null,
    val product_name: String? = null,
    val unit: String? = null,
    val recent_qty: Double? = null,
    val recent_rate: Double? = null,
    val baseline_rate: Double? = null,
    val ratio: Double? = null,
)

data class DuplicateMrnNumber(val mrn_no: String? = null, val c: Int = 0)

data class DoubleEntryRow(
    val asset_code: String? = null,
    val description: String? = null,
    val qty: Double? = null,
    val req_date: String? = null,
    val c: Int = 0,
    val mrn_nos: String? = null,
)

data class DuplicateMrn(
    val duplicate_numbers: List<DuplicateMrnNumber> = emptyList(),
    val likely_double_entries: List<DoubleEntryRow> = emptyList(),
)

data class PriceSpikeRow(
    val grn_id: Long = 0,
    val item: String? = null,
    val unit_price: Double? = null,
    val baseline_avg: Double? = null,
    val ratio: Double? = null,
)

data class AnomaliesResponse(
    val unusual_consumption: List<UnusualConsumptionRow> = emptyList(),
    val duplicate_mrn: DuplicateMrn = DuplicateMrn(),
    val grn_price_spikes: List<PriceSpikeRow> = emptyList(),
)

data class IntegrityIssue(val type: String? = null, val detail: String? = null)

data class IntegrityResponse(
    val issues: List<IntegrityIssue> = emptyList(),
    val count: Int = 0,
)
