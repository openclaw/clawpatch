import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("detects Android Kotlin roles from Gradle plugins without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-role-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":ui")\n');
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.library") version "1.0" apply false }\n',
    );
    await writeFixture(root, "ui/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "ui/src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "ui/src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from convention plugin android blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-convention-block-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.company.android.library") version "1.0"',
        "}",
        "",
        "android {",
        '  namespace = "com.example"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from multiline Gradle plugin declarations", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-multiline-plugin-role-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      ["plugins {", "  id(", '    "com.android.library"', "  )", "}", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat child android extension blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-child-extension-block-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "subprojects {",
        "  android {",
        '    namespace = "com.example.child"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("keeps applied Android plugin declarations before unrelated alias apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-alias-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  alias(libs.plugins.kotlin.compose) apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Groovy Android plugin declarations before unrelated apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-groovy-apply-false-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins {",
        "  id 'com.android.application' version '8.0'",
        "  id 'org.jetbrains.kotlin.jvm' version '1.9' apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before unrelated shorthand apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-shorthand-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        '  kotlin("jvm") apply false',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before unrelated backtick apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-backtick-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  `java-library` apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before bare accessor apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-accessor-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  application apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Android plugin declarations before same-line unrelated apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-same-line-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.application"); id("org.jetbrains.kotlin.jvm") apply false }\n',
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps final Android plugin declarations before later unrelated apply false text", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-trailing-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "}",
        "",
        'tasks.register("note") {',
        '  doLast { println("call .apply(false) elsewhere") }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from version-catalog plugin aliases without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-alias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      "plugins { alias(libs.plugins.android.library) }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from bare plugin aliases without a catalog", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-bare-plugin-alias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.android) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from later wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-wildcard-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import com.external.*",
        "import androidx.lifecycle.*",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from resolved version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not read parent version-catalog aliases from nested Gradle roots", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-catalog-shadow-");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "server/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "server/gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "org.jetbrains.kotlin.jvm", version = "1.9" }', ""].join("\n"),
    );
    await writeFixture(root, "server/build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "server/src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const module = result.features.find((feature) => feature.title === "Gradle module server");
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "server/src/main/kotlin/com/example/api/OrderController.kt",
        ),
    );

    expect(module?.tags).not.toContain("android");
    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
  });

  it("does not read subproject-local version catalogs from Gradle root subprojects", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-root-catalog-subproject-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":server")\n');
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "org.jetbrains.kotlin.jvm", version = "1.9" }', ""].join("\n"),
    );
    await writeFixture(
      root,
      "server/gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "server/build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "server/src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const module = result.features.find((feature) => feature.title === "Gradle module server");
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "server/src/main/kotlin/com/example/api/OrderController.kt",
        ),
    );

    expect(module?.tags).not.toContain("android");
    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
  });

  it("detects Android Kotlin roles from quoted version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-quoted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", '"agp.lib" = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp.lib) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat version-catalog Android plugin aliases inside Gradle strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-alias-string-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'tasks.register("note") {',
        '  doLast { println("alias(libs.plugins.agp)") }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from dotted-key version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-dotted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp.id = "com.android.library"', 'agp.version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from top-level dotted version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-top-dotted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ['plugins.agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from plugin-specific version-catalog tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-table-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins.agp]", 'id = "com.android.library"', 'version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from quoted plugin-specific version-catalog tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-quoted-plugin-table-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ['[plugins."agp"]', 'id = "com.android.library"', 'version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from nested version-catalog plugin tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-nested-plugin-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins.android]", 'gradle = { id = "com.android.library", version = "8.0.0" }', ""].join(
        "\n",
      ),
    );
    await writeFixture(
      root,
      "build.gradle.kts",
      "plugins { alias(libs.plugins.android.gradle) }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from applied Gradle plugin syntax without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-plugin-role-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "apply plugin: 'com.android.library'\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from Groovy apply plugin syntax with spaced colons", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-spaced-colon-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "apply plugin : 'com.android.library'\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from Groovy apply plugin map syntax", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-map-role-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", 'apply(plugin: "com.android.library")\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects root Android apply plugin after Gradle URL strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-url-string-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "subprojects {",
        "  repositories {",
        "    maven { url 'https://example.com/repo' }",
        "  }",
        "}",
        "apply plugin: 'com.android.library'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android apply plugin after Gradle child-scope string braces", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-string-brace-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "subprojects {",
        "  tasks.register('note') { doLast { println('{') } }",
        "}",
        "apply plugin: 'com.android.library'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android roles from allprojects apply plugin blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-allprojects-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "allprojects {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android roles from allprojects android blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-allprojects-extension-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "allprojects {",
        "  android {",
        '    namespace = "com.example"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("does not treat subproject Android apply blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-subprojects-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "subprojects {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat project Android apply blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-project-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "project(':app') {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "1.0" apply false',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Android apply syntax inside Gradle raw strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-raw-string-apply-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'val sample = """',
        "apply plugin: 'com.android.library'",
        '"""',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Android extension blocks inside Gradle raw strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-raw-string-extension-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'val sample = """',
        "android { namespace = 'com.example' }",
        '"""',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false Android plugin declarations with GString versions as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-gstring-apply-false-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins {",
        '  id "com.android.application" version "${agpVersion}" apply false',
        '  id "org.jetbrains.kotlin.jvm"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false version-catalog Android plugin aliases as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-alias-apply-false-module-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        "  alias(libs.plugins.android.library) apply false",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-method-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application").version("8.0").apply(false)',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat multiline Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-multiline-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application")',
        '    .version("8.0")',
        "    .apply(false)",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat split Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-split-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application")',
        '    .version("8.0")',
        "    .apply(",
        "      false",
        "    )",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat commented Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-commented-plugin-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  // id("com.android.application")',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat nested-commented Kotlin DSL Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-nested-comment-plugin-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "/* outer",
        "  /* inner */",
        '  id("com.android.application")',
        "*/",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
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
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("normalizes root Gradle source groups", async () => {
    const root = await fixtureRoot("clawpatch-root-gradle-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "src/main/java/com/example/App.kt", "class App\n");
    await writeFixture(root, "src/test/java/com/example/AppTest.kt", "class AppTest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Gradle source src");
    expect(titles).toContain("Gradle test suite src");
    expect(titles.some((title) => title.includes("./src"))).toBe(false);
    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.commands).toMatchObject({
      typecheck: "gradle build",
      test: "gradle test",
    });
  });

  it("detects Kotlin and Gradle commands for Groovy Gradle root projects", async () => {
    const root = await fixtureRoot("clawpatch-root-kotlin-gradle-detect-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "plugins { id 'org.jetbrains.kotlin.jvm' }\n");
    await writeFixture(root, "src/main/kotlin/com/example/app/App.kt", "class App\n");
    await writeFixture(root, "src/test/kotlin/com/example/app/AppTest.kt", "class AppTest\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands).toMatchObject({
      typecheck: "gradle build",
      test: "gradle test",
    });
  });

  it("detects Java and wrapper Gradle commands for root Gradle projects", async () => {
    const root = await fixtureRoot("clawpatch-root-java-gradle-detect-");
    await writeFixture(root, "gradlew", "#!/bin/sh\n");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "plugins { id 'java' }\n");
    await writeFixture(root, "src/main/java/com/example/App.java", "class App {}\n");
    await writeFixture(root, "src/test/java/com/example/AppTest.java", "class AppTest {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("java");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands).toMatchObject({
      typecheck: "./gradlew build",
      test: "./gradlew test",
    });
  });

  it("does not detect Java from documentation-only Java files", async () => {
    const root = await fixtureRoot("clawpatch-docs-java-detect-");
    await writeFixture(root, "docs/Example.java", "class Example {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("java");
  });

  it("maps build.gradle-only roots without empty Gradle groups", async () => {
    const root = await fixtureRoot("clawpatch-gradle-build-only-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "src/main/java/com/acme/test/Foo.kt", "class Foo\n");
    await writeFixture(root, "src/test/java/com/acme/FooTest.kt", "class FooTest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const gradleFeatures = result.features.filter((feature) =>
      feature.source.startsWith("gradle-"),
    );
    const source = result.features.find((feature) => feature.title === "Gradle source src");

    expect(gradleFeatures.length).toBeGreaterThan(0);
    expect(source?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/java/com/acme/test/Foo.kt",
    );
    expect(gradleFeatures.every((feature) => feature.ownedFiles.length > 0)).toBe(true);
  });

  it("maps nested build.gradle-only Gradle apps", async () => {
    const root = await fixtureRoot("clawpatch-nested-gradle-build-only-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/android/build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "apps/android/src/main/java/com/example/App.kt", "class App\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBeNull();
    expect(titles).toContain("Gradle module apps/android");
    expect(titles).toContain("Gradle source apps/android/src");
  });
});
