// Terra for Android: a native shell (WebViews for the tabs) around the same
// HTML UI as the desktop app, laid out for a phone. Build it with
// `npm run apk` from the repository root.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Terra"
include(":app")
