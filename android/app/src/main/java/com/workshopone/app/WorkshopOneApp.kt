package com.workshopone.app

import android.app.Application
import com.workshopone.app.data.ApiClient
import com.workshopone.app.data.Session
import com.workshopone.app.data.WorkshopApi

/** Plain service locator — small enough that a DI framework would be noise. */
class AppContainer(app: Application) {
    val session: Session = Session(app)
    private val client: ApiClient = ApiClient(session)
    val api: WorkshopApi get() = client.api()
}

class WorkshopOneApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        instance = this
    }

    companion object {
        lateinit var instance: WorkshopOneApp
            private set
    }
}
