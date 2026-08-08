package com.workshopone.app.data

/**
 * Role names and the job-card transition map, mirroring the server's
 * src/lib/auth.js and src/lib/jobstate.js. The server enforces all of this on
 * every mutation — the client copy only decides which buttons to show.
 */
object Roles {
    const val ADMIN = "admin"
    const val STOREKEEPER = "storekeeper"
    const val TRANSPORT = "transport_manager"
    const val OPS = "operational_manager"
    const val WORKSHOP = "workshop"
    const val MANAGER = "manager"
    const val VIEWER = "viewer"
}

fun UserInfo?.hasRole(vararg roles: String): Boolean {
    if (this == null) return false
    if (this.roles.contains(Roles.ADMIN)) return true
    return roles.any { this.roles.contains(it) }
}

/** One transition button on the job card. */
data class TransitionAction(
    val target: String,
    val label: String,
    val roles: List<String>,
    val asksReason: Boolean = false,
    val destructive: Boolean = false,
    val adminOnly: Boolean = false,
)

object JobStates {
    const val REQUESTED = "REQUESTED"
    const val APPROVED_TRANSPORT = "APPROVED_TRANSPORT"
    const val APPROVED_OPERATIONS = "APPROVED_OPERATIONS"
    const val IN_WORKSHOP = "IN_WORKSHOP"
    const val IN_PROGRESS = "IN_PROGRESS"
    const val WORK_COMPLETE = "WORK_COMPLETE"
    const val CLOSED = "CLOSED"
    const val REJECTED = "REJECTED"

    val ALL = listOf(
        REQUESTED, APPROVED_TRANSPORT, APPROVED_OPERATIONS, IN_WORKSHOP,
        IN_PROGRESS, WORK_COMPLETE, CLOSED, REJECTED,
    )

    fun label(state: String?): String = when (state) {
        REQUESTED -> "Requested"
        APPROVED_TRANSPORT -> "Transport OK"
        APPROVED_OPERATIONS -> "Operations OK"
        IN_WORKSHOP -> "In Workshop"
        IN_PROGRESS -> "In Progress"
        WORK_COMPLETE -> "Work Complete"
        CLOSED -> "Closed"
        REJECTED -> "Rejected"
        else -> state ?: "—"
    }

    /** Transitions available from a state (mirrors jobstate.js TRANSITIONS). */
    fun transitionsFrom(state: String?): List<TransitionAction> = when (state) {
        REQUESTED -> listOf(
            TransitionAction(APPROVED_TRANSPORT, "Approve (Transport)", listOf(Roles.TRANSPORT)),
            TransitionAction(REJECTED, "Reject", listOf(Roles.TRANSPORT, Roles.OPS), asksReason = true, destructive = true),
        )
        APPROVED_TRANSPORT -> listOf(
            TransitionAction(APPROVED_OPERATIONS, "Approve (Operations)", listOf(Roles.OPS)),
            TransitionAction(REQUESTED, "Return to Requested", listOf(Roles.TRANSPORT, Roles.OPS), asksReason = true),
            TransitionAction(REJECTED, "Reject", listOf(Roles.TRANSPORT, Roles.OPS), asksReason = true, destructive = true),
        )
        APPROVED_OPERATIONS -> listOf(
            TransitionAction(IN_WORKSHOP, "Move into Workshop", listOf(Roles.WORKSHOP)),
        )
        IN_WORKSHOP -> listOf(
            TransitionAction(IN_PROGRESS, "Start Work", listOf(Roles.WORKSHOP)),
        )
        IN_PROGRESS -> listOf(
            TransitionAction(WORK_COMPLETE, "Mark Complete", listOf(Roles.WORKSHOP)),
        )
        WORK_COMPLETE -> listOf(
            TransitionAction(CLOSED, "Close Job", listOf(Roles.OPS, Roles.WORKSHOP)),
            TransitionAction(IN_PROGRESS, "Resume Work", listOf(Roles.WORKSHOP)),
        )
        CLOSED -> listOf(
            TransitionAction(IN_PROGRESS, "Reopen (admin)", listOf(Roles.ADMIN), asksReason = true, adminOnly = true),
        )
        REJECTED -> listOf(
            TransitionAction(REQUESTED, "Return to Requested", listOf(Roles.TRANSPORT, Roles.OPS), asksReason = true),
        )
        else -> emptyList()
    }

    /** Which of the transitions this user may perform (admin can do all). */
    fun availableFor(user: UserInfo?, state: String?): List<TransitionAction> =
        transitionsFrom(state).filter { action ->
            if (action.adminOnly) user.hasRole(Roles.ADMIN)
            else user.hasRole(*action.roles.toTypedArray())
        }
}
