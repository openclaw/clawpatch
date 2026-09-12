import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("maps Kotlin Android semantic roles from framework evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-role-map-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.application").version("1.0").apply(false) }\n',
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/RootController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.GetMapping",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class RootController {",
        '  @GetMapping("/root")',
        '  fun root(): String = "ok"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      "plugins { alias(libs.plugins.android.application) }\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.activity.ComponentActivity",
        "import androidx.compose.runtime.Composable",
        "import androidx.hilt.navigation.compose.hiltViewModel",
        "",
        "class MainActivity : ComponentActivity()",
        "",
        "@Composable",
        "fun HomeScreen() { hiltViewModel<MainViewModel>() }",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/ProfileFragment.kt",
      [
        "package com.example.ui",
        "",
        "import dagger.hilt.android.AndroidEntryPoint",
        "",
        "@AndroidEntryPoint",
        "class ProfileFragment : BaseFragment()",
        "",
        "open class BaseFragment",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/SettingsActivity.kt",
      "package com.example.ui\nclass SettingsActivity : androidx.activity.ComponentActivity()\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.*",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/data/AppDatabase.kt",
      [
        "package com.example.data",
        "",
        "import androidx.room.Database",
        "import androidx.room.RoomDatabase",
        "",
        "@Database(entities = [], version = 1)",
        "abstract class AppDatabase : RoomDatabase()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/data/UserRepository.kt",
      [
        "package com.example.data",
        "",
        "import javax.inject.Inject",
        "",
        "class UserRepository @Inject constructor()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/network/ApiClient.kt",
      [
        "package com.example.network",
        "",
        "import retrofit2.Retrofit",
        "",
        "class ApiClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/di/AppGraph.kt",
      [
        "package com.example.di",
        "",
        "import dev.zacsweers.metro.BindingContainer",
        "import dev.zacsweers.metro.DependencyGraph",
        "import dev.zacsweers.metro.Provides",
        "",
        "@DependencyGraph",
        "interface AppGraph",
        "",
        "@BindingContainer",
        "object AppBindings {",
        '  @Provides fun provideName(): String = "app"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/UseCase.kt",
      "package com.example.domain\nclass UseCase\n",
    );
    await writeFixture(
      root,
      "app/src/test/kotlin/com/example/ui/MainActivityTest.kt",
      "package com.example.ui\nclass MainActivityTest\n",
    );
    await writeFixture(
      root,
      "app/build/generated/source/kapt/debug/com/example/Ignored.kt",
      "package com.example\nclass Ignored\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const gradleModule = result.features.find((feature) => feature.title === "Gradle module app");
    const ui = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role UI entrypoint "),
    );
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );
    const data = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role data boundary "),
    );
    const client = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role external client "),
    );
    const di = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role dependency injection "),
    );
    const rootModule = result.features.find((feature) => feature.title === "Gradle module .");
    const rootWeb = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/RootController.kt",
        ),
    );

    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(titles).toContain("Gradle module app");
    expect(rootModule?.tags).not.toContain("android");
    expect(rootWeb?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(gradleModule?.tags).toEqual(expect.arrayContaining(["gradle", "kotlin", "android"]));
    expect(ui?.source).toBe("kotlin-android-role-ui-entrypoint");
    expect(ui?.kind).toBe("ui-flow");
    expect(ui?.confidence).toBe("high");
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
    );
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/ProfileFragment.kt",
    );
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/SettingsActivity.kt",
    );
    expect(ui?.tests).toEqual([
      { path: "app/src/test/kotlin/com/example/ui/MainActivityTest.kt", command: null },
    ]);
    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(viewModel?.ownedFiles.map((file) => file.path)).not.toContain(
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
    );
    expect(data?.trustBoundaries).toEqual(expect.arrayContaining(["database", "serialization"]));
    expect(data?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/data/UserRepository.kt",
    );
    expect(client?.trustBoundaries).toEqual(
      expect.arrayContaining(["network", "external-api", "serialization"]),
    );
    expect(di?.source).toBe("kotlin-android-role-dependency-injection");
    expect(di?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/di/AppGraph.kt",
    );
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("app/build/generated/source/kapt/debug/com/example/Ignored.kt");
  });

  it("maps server-side Kotlin roles and path fallback evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-server-role-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.GetMapping",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController {",
        '  @GetMapping("/orders")',
        '  fun list(): String = "ok"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/QualifiedController.kt",
      [
        "package com.example.api",
        "",
        "@org.springframework.web.bind.annotation.RestController",
        "class QualifiedController",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/BillingService.kt",
      [
        "package com.example.app",
        "",
        "import jakarta.inject.Singleton",
        "",
        "@Singleton",
        "class BillingService",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/db/OrderRepository.kt",
      [
        "package com.example.db",
        "",
        "import org.springframework.data.repository.CrudRepository",
        "",
        "interface OrderRepository : CrudRepository<Order, String>",
        "class Order",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/RemoteClient.kt",
      [
        "package com.example.client",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class RemoteClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/GitHubApi.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.http.GET",
        "",
        "interface GitHubApi {",
        '  @GET("/users")',
        "  fun users(): String",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/PaymentClient.kt",
      "package com.example.network\ninterface PaymentClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/config/AppConfig.kt",
      [
        "package com.example.config",
        "",
        "import org.springframework.context.annotation.Bean",
        "import org.springframework.context.annotation.Configuration",
        "",
        "@Configuration",
        "class AppConfig {",
        '  @Bean fun name(): String = "orders"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/test/kotlin/com/example/api/OrderControllerTest.kt",
      "package com.example.api\nclass OrderControllerTest\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );
    const service = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role application service "),
    );
    const persistence = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role persistence boundary "),
    );
    const clientFeatures = result.features.filter((feature) =>
      feature.title.startsWith("Kotlin server role external client "),
    );
    const configuration = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role configuration "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(web?.ownedFiles.map((file) => file.path)).not.toContain(
      "src/main/kotlin/com/example/client/GitHubApi.kt",
    );
    expect(web?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/api/QualifiedController.kt",
    );
    expect(web?.tests).toEqual([
      { path: "src/test/kotlin/com/example/api/OrderControllerTest.kt", command: null },
    ]);
    expect(service?.source).toBe("kotlin-server-role-application-service");
    expect(persistence?.source).toBe("kotlin-server-role-persistence-boundary");
    expect(configuration?.source).toBe("kotlin-server-role-configuration");
    expect(configuration?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/config/AppConfig.kt",
    );
    const clientFiles = clientFeatures.flatMap((feature) =>
      feature.ownedFiles.map((file) => file.path),
    );
    expect(clientFeatures).toHaveLength(1);
    expect(clientFeatures[0]?.confidence).toBe("high");
    expect(clientFiles).toEqual(
      expect.arrayContaining([
        "src/main/kotlin/com/example/client/GitHubApi.kt",
        "src/main/kotlin/com/example/client/RemoteClient.kt",
        "src/main/kotlin/com/example/network/FallbackClient.kt",
        "src/main/kotlin/com/example/network/PaymentClient.kt",
      ]),
    );
  });

  it("does not add path-only roles to strong Kotlin server roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-strong-role-path-fallback-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/OrderController.kt",
      [
        "package com.example.network",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/OrderController.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/OrderController.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin Spring configuration imports as configuration roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-spring-config-import-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/config/PropsConfig.kt",
      [
        "package com.example.config",
        "",
        "import org.springframework.boot.context.properties.EnableConfigurationProperties",
        "",
        "@EnableConfigurationProperties(AppProps::class)",
        "class PropsConfig",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const configuration = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-configuration" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/config/PropsConfig.kt",
        ),
    );

    expect(configuration?.ownedFiles[0]?.reason).toContain(
      "configuration import org.springframework.boot.context.properties.EnableConfigurationProperties",
    );
  });

  it("keeps Kotlin feature IDs stable when confidence changes", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-role-id-stability-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/BackupClient.kt",
      "package com.example.network\nclass BackupClient\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const fallbackBefore = first.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/FallbackClient.kt",
        ),
    );

    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      [
        "package com.example.network",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class FallbackClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );

    const second = await mapFeatures(root, project, first.features);
    const fallbackAfter = second.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/FallbackClient.kt",
        ),
    );

    expect(fallbackBefore?.confidence).toBe("medium");
    expect(fallbackAfter?.confidence).toBe("high");
    expect(fallbackAfter?.featureId).toBe(fallbackBefore?.featureId);
    expect(fallbackAfter?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/main/kotlin/com/example/network/BackupClient.kt",
      "src/main/kotlin/com/example/network/FallbackClient.kt",
    ]);
  });

  it("does not infer Android roles from non-Android Gradle module paths", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-path-leak-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "apps/android/build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "plugins {",
        "  alias(libs.plugins.android.application)",
        "    .apply(false)",
        "}",
        '// id("com.android.application")',
        '/* android { namespace = "example" } */',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/android/src/main/kotlin/com/example/di/Injector.kt",
      "package com.example.di\nclass Injector\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
    expect(
      result.features.find((feature) => feature.title === "Gradle module apps/android")?.tags,
    ).not.toContain("android");
  });

  it("detects legacy Android Gradle plugin application syntax", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-legacy-gradle-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", 'apply plugin: "com.android.library"\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.activity.ComponentActivity",
        "",
        "class MainActivity : ComponentActivity()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Gradle module .")?.tags).toContain(
      "android",
    );
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not treat non-entrypoint Android framework imports as UI roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-non-ui-import-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/alerts/Notifier.kt",
      [
        "package com.example.alerts",
        "",
        "import android.app.Notification",
        "import android.app.PendingIntent",
        "",
        "class Notifier(private val notification: Notification, private val intent: PendingIntent)",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/alerts/Notifier.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat project-local Android supertype names as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-local-supertype-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/Service.kt",
      "package com.example.domain\nopen class Service\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/Billing.kt",
      "package com.example.domain\nclass Billing : Service()\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/domain/Billing.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat Compose runtime state imports as UI roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-compose-state-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/state/CounterState.kt",
      [
        "package com.example.state",
        "",
        "import androidx.compose.runtime.mutableStateOf",
        "",
        "class CounterState {",
        "  val count = mutableStateOf(0)",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/state/CounterState.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin role evidence from wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-wildcard-imports-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/RemoteClient.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.*",
        "",
        "class RemoteClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(root, "app/src/main/AndroidManifest.xml", "<manifest />\n");
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/bootstrap/AppModule.kt",
      [
        "package com.example.bootstrap",
        "",
        "import org.koin.dsl.*",
        "",
        'fun appModule() = module { single { "value" } }',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const client = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/client/RemoteClient.kt",
        ),
    );
    const di = result.features.find(
      (feature) =>
        feature.source === "kotlin-android-role-dependency-injection" &&
        feature.ownedFiles.some(
          (file) => file.path === "app/src/main/kotlin/com/example/bootstrap/AppModule.kt",
        ),
    );

    expect(client?.ownedFiles[0]?.reason).toContain("retrofit2.*");
    expect(di?.ownedFiles[0]?.reason).toContain("org.koin.dsl.*");
  });

  it("maps server-side Kotlin declaration role evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-declaration-role-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ports/PaymentPort.kt",
      "package com.example.ports\nfun interface PaymentPort { fun pay() }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/domain/Job.kt",
      "package com.example.domain\nclass Job\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import kotlin.time.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : LocalBase(), JobFactoryBase<Job>() {",
        "  fun buildJob(): Job = TODO()",
        "  fun local(): LocalBase = TODO()",
        '  fun label(): String = "job"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/LocalBase.kt",
      "package com.example.jobs\nopen class LocalBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const extension = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role extension boundary "),
    );
    const framework = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role framework component "),
    );

    expect(extension?.source).toBe("kotlin-server-role-extension-boundary");
    expect(extension?.confidence).toBe("medium");
    expect(extension?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/ports/PaymentPort.kt",
    );
    expect(
      extension?.ownedFiles.find(
        (file) => file.path === "src/main/kotlin/com/example/ports/PaymentPort.kt",
      )?.reason,
    ).toContain("interface declaration PaymentPort");
    expect(framework?.source).toBe("kotlin-server-role-framework-component");
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
    );
    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
    expect(framework?.ownedFiles[0]?.reason).not.toContain("org.scheduler.LocalBase");
    expect(framework?.ownedFiles[0]?.reason).not.toContain("org.scheduler.String");
  });

  it("does not let settings-only root sources suppress module Kotlin wildcard evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-settings-root-src-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(
      root,
      "src/main/kotlin/org/scheduler/Unused.kt",
      "package org.scheduler\nclass Unused\n",
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "app/src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("org.scheduler.JobFactoryBase");
  });

  it("does not let nested Gradle roots suppress outer Kotlin wildcard evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-root-local-type-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "nested/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "nested/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "nested/src/main/kotlin/org/scheduler/JobFactoryBase.kt",
      "package org.scheduler\nclass JobFactoryBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps nested Gradle roots under settings builds independently", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-settings-nested-root-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "nested/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "nested/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "nested/src/main/kotlin/org/scheduler/JobFactoryBase.kt",
      "package org.scheduler\nclass JobFactoryBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const nestedModule = result.features.find(
      (feature) => feature.title === "Gradle module nested",
    );
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(nestedModule?.source).toBe("gradle-module");
    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("does not treat Kotlin stdlib return types as framework components", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-stdlib-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/util/Timeouts.kt",
      [
        "package com.example.util",
        "",
        "import kotlin.time.Duration",
        "",
        "fun timeout(): Duration = Duration.ZERO",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/util/Timeouts.kt",
          ),
      ),
    ).toBe(false);
  });

  it("filters mixed Java/Kotlin module types from Kotlin framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-local-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/framework/BaseHandler.java",
      "package com.example.framework; public class BaseHandler {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Handler.kt",
      [
        "package com.example.api",
        "",
        "import com.example.framework.BaseHandler",
        "",
        "class Handler : BaseHandler()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/Handler.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin supertypes with constructor arguments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-args-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Handler.kt",
      [
        "package com.example.jobs",
        "",
        "import org.framework.FrameworkBase",
        "",
        "class Handler(callback: () -> Unit) : FrameworkBase(dep = dep, config = config)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/InjectedHandler.kt",
      [
        "package com.example.jobs",
        "",
        "import jakarta.inject.Inject",
        "import org.framework.FrameworkBase",
        "",
        "class InjectedHandler @Inject constructor(dep: Any) : FrameworkBase(dep)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/InternalHandler.kt",
      [
        "package com.example.jobs",
        "",
        "import org.framework.FrameworkBase",
        "",
        "class InternalHandler internal constructor(dep: Any) : FrameworkBase(dep)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/QualifiedHandler.kt",
      [
        "package com.example.jobs",
        "",
        "class QualifiedHandler : org.framework.FrameworkBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/Handler.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.framework.FrameworkBase");
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/InjectedHandler.kt",
    );
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/InternalHandler.kt",
    );
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/QualifiedHandler.kt",
    );
  });

  it("maps Kotlin Spring components as application services", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-spring-component-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/BillingComponent.kt",
      [
        "package com.example.app",
        "",
        "import org.springframework.stereotype.Component",
        "",
        "@Component",
        "class BillingComponent",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const service = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-application-service" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/app/BillingComponent.kt",
        ),
    );

    expect(service?.ownedFiles[0]?.reason).toContain("service annotation @Component");
  });

  it("does not treat qualified Kotlin annotations as type imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-annotation-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/Billing.kt",
      [
        "package com.example.app",
        "",
        "@org.springframework.stereotype.Service",
        "class Billing : Service",
        "interface Service",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/Billing.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-application-service" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/Billing.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not treat project-local nested Kotlin types as external frameworks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-nested-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Outer.kt",
      [
        "package com.example",
        "",
        "class Outer { open class Base }",
        "class Handler : Outer.Base()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/Outer.kt"),
      ),
    ).toBe(false);
  });

  it("ignores Kotlin role markers inside nested block comments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-comment-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Foo.kt",
      [
        "package com.example",
        "",
        "/* outer",
        "  /* inner */",
        "  import okhttp3.OkHttpClient",
        "  import org.springframework.web.bind.annotation.RestController",
        "  @RestController",
        "*/",
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" ||
          feature.source === "kotlin-server-role-web-entrypoint",
      ),
    ).toBe(false);
  });

  it("keeps Kotlin code after comment markers inside strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-string-comment-marker-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Foo.kt",
      [
        "package com.example.api",
        "",
        'const val marker = "/*"',
        "",
        "@org.springframework.web.bind.annotation.RestController",
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/api/Foo.kt"),
      ),
    ).toBe(true);
  });

  it("ignores Kotlin role markers inside raw strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-raw-string-marker-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Foo.kt",
      [
        "package com.example",
        "",
        'val template = """',
        "import okhttp3.OkHttpClient",
        "@org.springframework.web.bind.annotation.RestController",
        '"""',
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" ||
          feature.source === "kotlin-server-role-web-entrypoint",
      ),
    ).toBe(false);
  });

  it("keeps Kotlin role IDs stable when confidence buckets merge", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-role-bucket-stability-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/RemoteClient.kt",
      [
        "package com.example.network",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class RemoteClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const before = first.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/RemoteClient.kt",
        ),
    );

    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      [
        "package com.example.network",
        "",
        "import retrofit2.Retrofit",
        "",
        "class FallbackClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );

    const second = await mapFeatures(root, project, first.features);
    const after = second.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/RemoteClient.kt",
        ),
    );

    expect(before?.featureId).toBeDefined();
    expect(after?.featureId).toBe(before?.featureId);
    expect(after?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "src/main/kotlin/com/example/network/RemoteClient.kt",
    ]);
  });

  it("does not treat Java sources from the same Gradle module as external Kotlin framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-local-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/core/BaseService.java",
      "package com.example.core;\npublic class BaseService {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/LocalService.kt",
      [
        "package com.example.app",
        "",
        "import com.example.core.BaseService",
        "",
        "class LocalService : BaseService()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/LocalService.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat sibling Gradle module Kotlin types as external framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-sibling-module-type-");
    await writeFixture(
      root,
      "settings.gradle.kts",
      'pluginManagement {}\ninclude(":core", ":app")\n',
    );
    await writeFixture(
      root,
      "core/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "core/src/main/kotlin/com/example/core/BaseService.kt",
      ["package com.example.core", "", "open class BaseService", ""].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/app/AppService.kt",
      [
        "package com.example.app",
        "",
        "import com.example.core.BaseService",
        "",
        "class AppService : BaseService()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/app/AppService.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat same-package nested Kotlin types as external framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-nested-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      ["package com.example.jobs", "", "class Job {", "  class Factory", "}", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactoryProvider.kt",
      [
        "package com.example.jobs",
        "",
        "class JobFactoryProvider {",
        "  fun build(): Job.Factory = Job.Factory()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactoryProvider.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map Compose runtime-only imports as Android UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-compose-runtime-only-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.compose.runtime.mutableStateOf",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel() {",
        '  val name = mutableStateOf("app")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-view-model" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(true);
  });

  it("keeps Android UI path fallback for injected base activities", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-ui-di-path-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import dagger.hilt.android.AndroidEntryPoint",
        "",
        "@AndroidEntryPoint",
        "class MainActivity : BaseActivity()",
        "",
        "open class BaseActivity",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-dependency-injection" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not add Android path roles after strong framework evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-strong-role-path-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/ApiClient.kt",
      [
        "package com.example.ui",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class ApiClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/MainViewModel.kt",
      [
        "package com.example.network",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/ApiClient.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/ApiClient.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-view-model" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/MainViewModel.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not map Android app utility imports as UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-app-utility-import-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/notifications/NotificationHelper.kt",
      [
        "package com.example.notifications",
        "",
        "import android.app.NotificationChannel",
        "import android.app.PendingIntent",
        "",
        "class NotificationHelper {",
        '  fun channel(): NotificationChannel = NotificationChannel("id", "name", 3)',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) =>
              file.path === "src/main/kotlin/com/example/notifications/NotificationHelper.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map local Android supertype name collisions as UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-local-activity-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/domain/LocalActivity.kt",
      [
        "package com.example.domain",
        "",
        "open class Activity",
        "",
        "class CleanupJob : Activity()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/domain/LocalActivity.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin Apache HTTP imports as external clients", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-apache-http-client-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/LegacyClient.kt",
      [
        "package com.example.client",
        "",
        "import org.apache.http.client.HttpClient",
        "",
        "class LegacyClient(private val client: HttpClient)",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const client = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/client/LegacyClient.kt",
        ),
    );

    expect(client?.ownedFiles[0]?.reason).toContain(
      "external client import org.apache.http.client.HttpClient",
    );
  });

  it("keeps injected Android data consumers in data role path fallback", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-injected-data-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/data/UserRepository.kt",
      [
        "package com.example.data",
        "",
        "import javax.inject.Inject",
        "",
        "class UserRepository @Inject constructor()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const data = result.features.find(
      (feature) =>
        feature.source === "kotlin-android-role-data-boundary" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/data/UserRepository.kt",
        ),
    );

    expect(data?.ownedFiles[0]?.reason).toContain("path segment data boundary");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-dependency-injection" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/data/UserRepository.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map Retrofit client annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-retrofit-annotation-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/ApiClient.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.http.GET",
        "",
        "interface ApiClient {",
        '  @GET("/orders")',
        "  fun orders(): String",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/client/ApiClient.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/client/ApiClient.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map qualified custom web-like annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-custom-qualified-web-annotation-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/LocalController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@com.acme.RestController",
        "class LocalController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/LocalController.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps fully qualified Kotlin JAX-RS annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-jaxrs-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        '@jakarta.ws.rs.Path("/orders")',
        "class OrderResource",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(web?.ownedFiles[0]?.reason).toContain("server web annotation @Path");
  });

  it("maps later fully qualified Kotlin JAX-RS annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-jaxrs-after-custom-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        "@com.acme.Path",
        '@jakarta.ws.rs.Path("/orders")',
        "class OrderResource",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(web?.ownedFiles[0]?.reason).toContain("server web annotation @Path");
  });

  it("maps fully qualified Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-return-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        "class OrderResource {",
        "  fun response(): io.ktor.server.response.ApplicationResponse = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "returns external type io.ktor.server.response.ApplicationResponse",
    );
  });

  it("maps Kotlin supertypes after the first line of a declaration", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-multiline-supertypes-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Worker.kt",
      [
        "package com.example.jobs",
        "",
        "import io.ktor.server.application.Application",
        "",
        "open class LocalWorker",
        "",
        "class Worker :",
        "  LocalWorker,",
        "  Application {",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/Worker.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type io.ktor.server.application.Application",
    );
  });

  it("maps Kotlin supertypes before generic where constraints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-where-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/ApiRoute.kt",
      [
        "package com.example.api",
        "",
        "import io.ktor.server.routing.Route",
        "",
        "class ApiRoute<T> : Route",
        "  where T : Any",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/ApiRoute.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type io.ktor.server.routing.Route",
    );
  });

  it("does not strip where package segments from Kotlin supertypes", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-where-package-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/where/Route.kt",
      ["package com.where", "", "open class Route", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/ApiRoute.kt",
      ["package com.example.api", "", "class ApiRoute : com.where.Route()", ""].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/ApiRoute.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps bodyless Kotlin supertypes before top-level functions", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "fun helper() = Unit",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before expect and actual declarations", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-expect-actual-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "actual class NativeJob",
        "expect fun scheduleJob()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before modified top-level functions", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-suspend-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "suspend fun runJob() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before top-level type aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-typealias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "typealias JobId = String",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps Kotlin return types after function-typed parameters", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-function-param-return-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Router.kt",
      [
        "package com.example.api",
        "",
        "import org.http4k.routing.Route",
        "",
        "class Router {",
        "  fun route(block: () -> Unit): Route = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/Router.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "returns external type org.http4k.routing.Route",
    );
  });

  it("does not resolve Kotlin built-in return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-builtin-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@RestController",
        "class OrderController {",
        '  @GetMapping("/orders")',
        '  fun body(): ByteArray = "ok".encodeToByteArray()',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/OrderController.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/OrderController.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not resolve Kotlin default return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-default-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun failure(): Throwable = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve Kotlin range return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-range-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/RangeController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@RestController",
        "class RangeController {",
        "  fun ids(): ClosedRange<Int> = 1..3",
        '  fun version(): KotlinVersion = KotlinVersion(1, 9, 0, "stable")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/RangeController.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/RangeController.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not resolve dotted Kotlin built-in return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-dotted-builtin-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Entries.kt",
      [
        "package com.example.api",
        "",
        "class Entries {",
        "  fun first(): Map.Entry<String, String> = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/Entries.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Routes.kt",
      [
        "package com.example",
        "",
        "object routes { class Handler }",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/Routes.kt"),
      ),
    ).toBe(false);
  });

  it("does not resolve imported local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-imported-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/routes/Routes.kt",
      ["package com.example.routes", "", "object routes { class Handler }", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/Factory.kt",
      [
        "package com.example.factory",
        "",
        "import com.example.routes.routes",
        "",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/Factory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve wildcard-imported local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-wildcard-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/routes/Routes.kt",
      ["package com.example.routes", "", "object routes { class Handler }", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/Factory.kt",
      [
        "package com.example.factory",
        "",
        "import com.example.routes.*",
        "",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/Factory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve JVM default return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-jvm-default-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun worker(): Runnable = Runnable { }",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve explicitly imported Kotlin stdlib return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-stdlib-direct-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/time/Timer.kt",
      [
        "package com.example.time",
        "",
        "import kotlin.time.Duration",
        "",
        "class Timer {",
        "  fun elapsed(): Duration = Duration.ZERO",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/time/Timer.kt",
          ),
      ),
    ).toBe(false);
  });

  it("resolves explicit Kotlin imports that shadow default built-in names", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-explicit-builtin-shadow-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Controller.kt",
      [
        "package com.example.api",
        "",
        "import com.external.Result",
        "",
        "class Controller {",
        "  fun result(): Result = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/Controller.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("returns external type com.external.Result");
  });

  it("does not resolve local Kotlin declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "data class Job(val id: String)",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve package-local Kotlin declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-package-local-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      "package com.example.jobs\nclass Job(val id: String)\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("prefers local Kotlin wildcard declarations over earlier external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-precedence-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      "package com.example.jobs\nclass Job(val id: String)\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/JobFactory.kt",
      [
        "package com.example.factory",
        "",
        "import org.scheduler.*",
        "import com.example.jobs.*",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("skips non-matching local Kotlin wildcard imports before external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-skip-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/local/Other.kt",
      "package com.example.local\nclass Other\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import com.example.local.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("skips non-external Kotlin wildcard imports before external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-non-external-wildcard-skip-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import java.util.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("does not resolve same-package Java declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/jobs/Job.java",
      "package com.example.jobs;\npublic class Job {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun buildJob(): Job = Job()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("preserves path roles for Kotlin interfaces", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-interface-path-roles-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/RemoteApi.kt",
      "package com.example.network\ninterface RemoteApi { fun call(): String }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/repository/UserRepository.kt",
      [
        "package com.example.repository",
        "",
        "import kotlinx.coroutines.flow.Flow",
        "",
        "interface UserRepository { fun users(): Flow<String> }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/RemoteApi.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-persistence-boundary" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/repository/UserRepository.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/repository/UserRepository.kt",
          ),
      ),
    ).toBe(true);
  });

  it("maps Kotlin supertypes after annotated primary constructors", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-annotated-constructor-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import javax.inject.Inject",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory @Inject constructor(private val dep: String) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes after visibility-before-annotation constructors", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-constructor-modifier-order-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import javax.inject.Inject",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory public @Inject constructor(private val dep: String) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes after function-typed constructor parameters", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-function-param-constructor-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory(cb: () -> Unit) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes with constructor call commas", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-call-comma-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        'class JobFactory : JobFactoryBase("a", "b")',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes with named constructor arguments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-named-arg-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        'class JobFactory : JobFactoryBase(name = "jobs")',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("does not treat qualified Java annotations as type imports", async () => {
    const root = await fixtureRoot("clawpatch-java-qualified-annotation-type-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(
      root,
      "src/main/java/com/acme/app/Billing.java",
      [
        "package com.acme.app;",
        "",
        "@org.springframework.stereotype.Service",
        "public class Billing implements Service {}",
        "interface Service {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "jvm-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/java/com/acme/app/Billing.java",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "jvm-role-application-service" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/java/com/acme/app/Billing.java",
          ),
      ),
    ).toBe(true);
  });
});
