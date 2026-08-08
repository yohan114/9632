package com.workshopone.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.workshopone.app.WorkshopOneApp
import com.workshopone.app.ui.screens.AssetDetailScreen
import com.workshopone.app.ui.screens.AssetsScreen
import com.workshopone.app.ui.screens.AttentionScreen
import com.workshopone.app.ui.screens.AuthScreen
import com.workshopone.app.ui.screens.BatteriesScreen
import com.workshopone.app.ui.screens.BatteryDetailScreen
import com.workshopone.app.ui.screens.DashboardScreen
import com.workshopone.app.ui.screens.JobDetailScreen
import com.workshopone.app.ui.screens.JobsScreen
import com.workshopone.app.ui.screens.MoreScreen
import com.workshopone.app.ui.screens.NewJobScreen
import com.workshopone.app.ui.screens.StockScreen
import com.workshopone.app.ui.theme.WorkshopOneTheme

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab("dashboard", "Home", Icons.Filled.Dashboard),
    Tab("jobs", "Jobs", Icons.Filled.Assignment),
    Tab("assets", "Assets", Icons.Filled.LocalShipping),
    Tab("stock", "Stock", Icons.Filled.Inventory2),
    Tab("more", "More", Icons.Filled.MoreHoriz),
)

@Composable
fun WorkshopOneRoot() {
    WorkshopOneTheme {
        val session = WorkshopOneApp.instance.container.session
        val user by session.user.collectAsState()
        if (user == null) {
            AuthScreen()
        } else {
            MainNav()
        }
    }
}

@Composable
private fun MainNav() {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    Scaffold(
        bottomBar = {
            NavigationBar {
                TABS.forEach { tab ->
                    NavigationBarItem(
                        selected = currentRoute == tab.route,
                        onClick = {
                            navController.navigate(tab.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = "dashboard",
            modifier = Modifier.padding(padding),
        ) {
            composable("dashboard") {
                DashboardScreen(
                    onOpenJob = { navController.navigate("job/$it") },
                    onOpenJobs = { navController.navigate("jobs") { launchSingleTop = true } },
                    onOpenAttention = { navController.navigate("attention") },
                )
            }
            composable("jobs") {
                JobsScreen(
                    onOpenJob = { navController.navigate("job/$it") },
                    onNewJob = { navController.navigate("jobs/new") },
                )
            }
            composable("jobs/new") {
                NewJobScreen(
                    onCreated = { id ->
                        navController.navigate("job/$id") {
                            popUpTo("jobs")
                        }
                    },
                    onBack = { navController.popBackStack() },
                )
            }
            composable(
                "job/{id}",
                arguments = listOf(navArgument("id") { type = NavType.LongType }),
            ) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                JobDetailScreen(
                    jobId = id,
                    onOpenAsset = { navController.navigate("asset/$it") },
                    onBack = { navController.popBackStack() },
                )
            }
            composable("assets") {
                AssetsScreen(onOpenAsset = { navController.navigate("asset/$it") })
            }
            composable(
                "asset/{id}",
                arguments = listOf(navArgument("id") { type = NavType.LongType }),
            ) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                AssetDetailScreen(
                    assetId = id,
                    onOpenJob = { navController.navigate("job/$it") },
                    onBack = { navController.popBackStack() },
                )
            }
            composable("stock") {
                StockScreen()
            }
            composable("more") {
                MoreScreen(
                    onOpenBatteries = { navController.navigate("batteries") },
                    onOpenAttention = { navController.navigate("attention") },
                )
            }
            composable("batteries") {
                BatteriesScreen(
                    onOpenBattery = { navController.navigate("battery/$it") },
                    onBack = { navController.popBackStack() },
                )
            }
            composable(
                "battery/{id}",
                arguments = listOf(navArgument("id") { type = NavType.LongType }),
            ) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                BatteryDetailScreen(
                    batteryId = id,
                    onOpenAsset = { navController.navigate("asset/$it") },
                    onBack = { navController.popBackStack() },
                )
            }
            composable("attention") {
                AttentionScreen(onBack = { navController.popBackStack() })
            }
        }
    }
}
