import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("maps JVM role features from Java code evidence", async () => {
    const root = await fixtureRoot("clawpatch-jvm-role-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(
      root,
      "src/main/java/com/acme/api/OrderController.java",
      [
        "package com.acme.api;",
        "",
        "import org.springframework.web.bind.annotation.GetMapping;",
        "import org.springframework.web.bind.annotation.RestController;",
        "",
        "@RestController",
        "public class OrderController {",
        '  @GetMapping("/orders")',
        '  public String list() { return "ok"; }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/app/BillingService.java",
      [
        "package com.acme.app;",
        "",
        "import org.springframework.stereotype.Service;",
        "",
        "@Service",
        "public class BillingService {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/db/OrderEntity.java",
      [
        "package com.acme.db;",
        "",
        "import jakarta.persistence.Entity;",
        "",
        "@Entity",
        "public class OrderEntity {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/client/RemoteClient.java",
      [
        "package com.acme.client;",
        "",
        "import java.net.http.HttpClient;",
        "",
        "public class RemoteClient {",
        "  private final HttpClient client = HttpClient.newHttpClient();",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/client/UriHolder.java",
      [
        "package com.acme.client;",
        "",
        "import java.net.URI;",
        "",
        "public class UriHolder {",
        "  private final URI endpoint;",
        "  public UriHolder(URI endpoint) { this.endpoint = endpoint; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/jobs/JobFactory.java",
      [
        "package com.acme.jobs;",
        "",
        "import org.scheduler.Job;",
        "",
        "public class JobFactory {",
        "  public Job buildJob() { return null; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/jobs/GenericJobFactory.java",
      [
        "package com.acme.jobs;",
        "",
        "import org.scheduler.Job;",
        "import org.scheduler.JobFactoryBase;",
        "",
        "public class GenericJobFactory<T> extends JobFactoryBase<T> {",
        "  public Job<T> buildJob() { return null; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/PluginAdapter.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "public class PluginAdapter implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/RecordPlugin.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "public record RecordPlugin(String name) implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/HelperFirstAdapter.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "final class Helper {}",
        "public class HelperFirstAdapter implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/ServletFilter.java",
      [
        "package com.acme.ext;",
        "",
        "import jakarta.servlet.Filter;",
        "",
        "public class ServletFilter implements Filter {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/security/SslFactory.java",
      [
        "package com.acme.security;",
        "",
        "import javax.net.ssl.SSLContext;",
        "",
        "public class SslFactory {",
        "  public SSLContext context() { return null; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/local/LocalCommandAdapter.java",
      [
        "package com.acme.local;",
        "",
        "import com.acme.local.Command;",
        "",
        "interface Command {}",
        "public class LocalCommandAdapter implements Command {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/google/myapp/GuavaAdapter.java",
      [
        "package com.google.myapp;",
        "",
        "import com.google.common.util.concurrent.Service;",
        "",
        "public class GuavaAdapter implements Service {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const bySource = new Map(result.features.map((feature) => [feature.source, feature]));

    expect(project.detected.packageManagers).toContain("gradle");
    expect(bySource.get("jvm-role-web-entrypoint")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/api/OrderController.java",
    );
    expect(bySource.get("jvm-role-application-service")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/app/BillingService.java",
    );
    expect(bySource.get("jvm-role-persistence-boundary")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/db/OrderEntity.java",
    );
    expect(bySource.get("jvm-role-external-client")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/client/RemoteClient.java",
    );
    expect(
      bySource
        .get("jvm-role-framework-component")
        ?.ownedFiles.map((file) => file.path)
        .toSorted(),
    ).toEqual(
      [
        "src/main/java/com/google/myapp/GuavaAdapter.java",
        "src/main/java/com/acme/ext/HelperFirstAdapter.java",
        "src/main/java/com/acme/ext/PluginAdapter.java",
        "src/main/java/com/acme/ext/RecordPlugin.java",
        "src/main/java/com/acme/ext/ServletFilter.java",
        "src/main/java/com/acme/jobs/GenericJobFactory.java",
        "src/main/java/com/acme/jobs/JobFactory.java",
      ].toSorted(),
    );
    expect(
      bySource.get("jvm-role-framework-component")?.ownedFiles.map((file) => file.path),
    ).not.toContain("src/main/java/com/acme/security/SslFactory.java");
    expect(
      bySource
        .get("jvm-role-extension-boundary")
        ?.ownedFiles.map((file) => file.path)
        .toSorted(),
    ).toEqual([
      "src/main/java/com/acme/ext/HelperFirstAdapter.java",
      "src/main/java/com/acme/ext/PluginAdapter.java",
      "src/main/java/com/acme/ext/RecordPlugin.java",
      "src/main/java/com/acme/ext/ServletFilter.java",
      "src/main/java/com/acme/local/LocalCommandAdapter.java",
      "src/main/java/com/google/myapp/GuavaAdapter.java",
    ]);
  });
});
