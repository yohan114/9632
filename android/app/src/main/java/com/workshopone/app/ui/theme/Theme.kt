package com.workshopone.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Workshop palette: steel blue + amber, with status accents used across the app.
val SteelBlue = Color(0xFF0F5C8C)
val SteelBlueDark = Color(0xFF0B4368)
val Amber = Color(0xFFE8930C)
val TealOk = Color(0xFF2E7D6B)
val DangerRed = Color(0xFFB3261E)

private val LightColors = lightColorScheme(
    primary = SteelBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD3E7F5),
    onPrimaryContainer = Color(0xFF07293F),
    secondary = Amber,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFBE6C4),
    onSecondaryContainer = Color(0xFF4A2E00),
    tertiary = TealOk,
    onTertiary = Color.White,
    error = DangerRed,
    surface = Color(0xFFFBFBFD),
    background = Color(0xFFF4F6F8),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8CC5E8),
    onPrimary = Color(0xFF06304A),
    primaryContainer = SteelBlueDark,
    onPrimaryContainer = Color(0xFFD3E7F5),
    secondary = Color(0xFFF2BB66),
    onSecondary = Color(0xFF3F2A00),
    secondaryContainer = Color(0xFF5C420A),
    onSecondaryContainer = Color(0xFFFBE6C4),
    tertiary = Color(0xFF7FC0B0),
    onTertiary = Color(0xFF00382D),
)

@Composable
fun WorkshopOneTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        content = content,
    )
}

/** Chip/badge color for a job-card state. */
@Composable
fun statusColor(state: String?): Color = when (state) {
    "REQUESTED" -> Color(0xFF6A7B8C)
    "APPROVED_TRANSPORT" -> Color(0xFF4C6FB0)
    "APPROVED_OPERATIONS" -> Color(0xFF6C55A8)
    "IN_WORKSHOP" -> Color(0xFFB56A18)
    "IN_PROGRESS" -> Amber
    "WORK_COMPLETE" -> TealOk
    "CLOSED" -> Color(0xFF3B7D3B)
    "REJECTED" -> DangerRed
    else -> MaterialTheme.colorScheme.outline
}
