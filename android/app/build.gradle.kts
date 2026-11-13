import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// The version in package.json.
@Suppress("UNCHECKED_CAST")
val packageJson = JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<String, Any>
val terraVersion = packageJson["version"] as String
val terraVersionCode = terraVersion.split(".").map { it.takeWhile(Char::isDigit).toInt() }
    .let { (major, minor, patch) -> major * 10_000 + minor * 100 + patch }

// The release key lives next to the project but is never committed
// (scripts/build-apk.mjs makes one the first time). Keep it: an update
// must be signed with the same key as the installed app.
val keystoreProperties = Properties().apply {
    val file = rootDir.resolve("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "app.terra.browser"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "app.terra.browser"
        minSdk = 29
        targetSdk = 37
        versionCode = terraVersionCode
        versionName = terraVersion
    }

    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                storeFile = rootDir.resolve(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
}
