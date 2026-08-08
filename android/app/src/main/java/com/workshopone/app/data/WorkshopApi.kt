package com.workshopone.app.data

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/** Retrofit interface for the WorkshopOne REST API. */
interface WorkshopApi {

    // ---- health / auth ----------------------------------------------------
    @GET("api/health")
    suspend fun health(): HealthResponse

    @POST("api/auth/login")
    suspend fun login(@Body body: LoginRequest): UserInfo

    @POST("api/auth/logout")
    suspend fun logout(): OkResponse

    @GET("api/auth/me")
    suspend fun me(): UserInfo

    @POST("api/auth/change-password")
    suspend fun changePassword(@Body body: ChangePasswordRequest): OkResponse

    // ---- dashboard & reports ---------------------------------------------
    @GET("api/reports/dashboard")
    suspend fun dashboard(): Dashboard

    @GET("api/reports/service-due")
    suspend fun serviceDue(): List<ServiceDueRow>

    @GET("api/reports/anomalies")
    suspend fun anomalies(): AnomaliesResponse

    @GET("api/reports/integrity")
    suspend fun integrity(): IntegrityResponse

    // ---- job cards --------------------------------------------------------
    @GET("api/jobs")
    suspend fun jobs(
        @Query("status") status: String? = null,
        @Query("asset_id") assetId: Long? = null,
        @Query("project_id") projectId: Long? = null,
        @Query("limit") limit: Int = 200,
    ): List<JobSummary>

    @POST("api/jobs")
    suspend fun createJob(@Body body: NewJobRequest): CreateJobResponse

    @GET("api/jobs/{id}")
    suspend fun job(@Path("id") id: Long): JobDetail

    @POST("api/jobs/{id}/transition")
    suspend fun transition(@Path("id") id: Long, @Body body: TransitionRequest): Job

    @POST("api/jobs/{id}/daily-work")
    suspend fun addDailyWork(@Path("id") id: Long, @Body body: DailyWorkRequest): List<DailyWorkLine>

    @DELETE("api/jobs/{id}/daily-work/{lineId}")
    suspend fun deleteDailyWork(@Path("id") id: Long, @Path("lineId") lineId: Long): OkResponse

    @POST("api/jobs/{id}/parts")
    suspend fun addPart(@Path("id") id: Long, @Body body: PartRequest): JobPart

    @PATCH("api/jobs/{id}/parts/{partId}")
    suspend fun updatePart(
        @Path("id") id: Long,
        @Path("partId") partId: Long,
        @Body body: PartPatchRequest,
    ): JobPart

    @DELETE("api/jobs/{id}/parts/{partId}")
    suspend fun deletePart(@Path("id") id: Long, @Path("partId") partId: Long): OkResponse

    @PATCH("api/jobs/{id}/flat-labour")
    suspend fun setFlatLabour(@Path("id") id: Long, @Body body: FlatLabourRequest): Job

    // ---- assets -----------------------------------------------------------
    @GET("api/assets")
    suspend fun assets(
        @Query("q") q: String? = null,
        @Query("status") status: String? = null,
        @Query("asset_class") assetClass: String? = null,
        @Query("limit") limit: Int = 300,
    ): List<AssetRow>

    @GET("api/assets/{id}")
    suspend fun asset360(@Path("id") id: Long): Asset360

    // ---- projects ---------------------------------------------------------
    @GET("api/projects")
    suspend fun projects(): List<Project>

    // ---- oil & lubricant --------------------------------------------------
    @GET("api/oil/forecast")
    suspend fun oilForecast(): OilForecast

    @GET("api/oil/ledger")
    suspend fun oilLedger(
        @Query("product_id") productId: Long? = null,
        @Query("asset_id") assetId: Long? = null,
        @Query("limit") limit: Int = 150,
    ): List<LedgerRow>

    // ---- stores -----------------------------------------------------------
    @GET("api/stores/reorder")
    suspend fun storeReorder(): List<StoreItem>

    // ---- batteries --------------------------------------------------------
    @GET("api/batteries")
    suspend fun batteries(
        @Query("q") q: String? = null,
        @Query("state") state: String? = null,
    ): List<Battery>

    @GET("api/batteries/{id}")
    suspend fun battery(@Path("id") id: Long): BatteryDetail

    // ---- mechanics --------------------------------------------------------
    @GET("api/mechanics")
    suspend fun mechanics(): List<Mechanic>
}
