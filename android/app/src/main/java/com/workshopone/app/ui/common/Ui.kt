package com.workshopone.app.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import com.workshopone.app.AppContainer
import com.workshopone.app.WorkshopOneApp
import com.workshopone.app.ui.theme.statusColor
import com.workshopone.app.data.JobStates
import java.text.DecimalFormat

// ---------------------------------------------------------------------------
// ViewModel plumbing
// ---------------------------------------------------------------------------

/** Creates a ViewModel with access to the app's service container. */
@Composable
inline fun <reified VM : ViewModel> appViewModel(
    key: String? = null,
    crossinline create: (AppContainer) -> VM,
): VM = viewModel(key = key) { create(WorkshopOneApp.instance.container) }

/** Loading / error / ready for a whole screen. */
sealed interface UiState<out T> {
    data object Loading : UiState<Nothing>
    data class Error(val message: String) : UiState<Nothing>
    data class Ready<T>(val data: T) : UiState<T>
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

fun money(value: Double?): String =
    "Rs " + DecimalFormat("#,##0.00").format(value ?: 0.0)

fun qtyText(value: Double?): String {
    val v = value ?: 0.0
    return if (v % 1.0 == 0.0) v.toLong().toString() else DecimalFormat("#,##0.##").format(v)
}

fun shortDate(value: String?): String {
    val s = value?.trim().orEmpty()
    return if (s.length >= 10) s.take(10) else s.ifEmpty { "—" }
}

fun dash(value: String?): String = value?.takeIf { it.isNotBlank() } ?: "—"

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

@Composable
fun LoadingBox(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
fun ErrorBox(message: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    Column(
        modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            message,
            color = MaterialTheme.colorScheme.error,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyLarge,
        )
        if (onRetry != null) {
            Button(onClick = onRetry, modifier = Modifier.padding(top = 16.dp)) {
                Text("Retry")
            }
        }
    }
}

/** Renders loading / error states, and hands ready data to [content]. */
@Composable
fun <T> StateContent(
    state: UiState<T>,
    onRetry: () -> Unit,
    content: @Composable (T) -> Unit,
) {
    when (state) {
        is UiState.Loading -> LoadingBox()
        is UiState.Error -> ErrorBox(state.message, onRetry = onRetry)
        is UiState.Ready -> content(state.data)
    }
}

@Composable
fun SectionCard(
    title: String,
    modifier: Modifier = Modifier,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                if (trailing != null) trailing()
            }
            Column(Modifier.padding(top = 8.dp), content = { content() })
        }
    }
}

@Composable
fun KeyValue(label: String, value: String, valueColor: Color = Color.Unspecified) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(end = 12.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = valueColor,
            textAlign = TextAlign.End,
        )
    }
}

/** Small tinted pill, used for job states and other badges. */
@Composable
fun Pill(text: String, color: Color) {
    Box(
        Modifier
            .background(color.copy(alpha = 0.16f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 3.dp)
    ) {
        Text(
            text,
            color = color,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun StatusPill(state: String?) {
    Pill(JobStates.label(state), statusColor(state))
}

@Composable
fun EmptyHint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        textAlign = TextAlign.Center,
    )
}
