import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("detects Maven root projects and wrapper validation commands", async () => {
    const root = await fixtureRoot("clawpatch-root-maven-map-");
    await writeFixture(root, "mvnw", "#!/bin/sh\n");
    await writeFixture(
      root,
      "pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>demo-app</artifactId>",
        "  <version>1.0.0</version>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/App.java",
      "package com.acme;\nclass App {}\n",
    );
    await writeFixture(
      root,
      "src/test/java/com/acme/AppTest.java",
      "package com.acme;\nclass AppTest {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("java");
    expect(project.detected.packageManagers).toContain("maven");
    expect(project.detected.commands).toMatchObject({
      typecheck: "./mvnw -DskipTests compile",
      test: "./mvnw test",
    });
    expect(titles).toContain("Maven module demo-app");
    expect(titles).toContain("Maven source src");
    expect(titles).toContain("Maven test suite src");
    expect(result.features.find((feature) => feature.title === "Maven source src")?.tests).toEqual([
      { path: "src/test/java/com/acme/AppTest.java", command: null },
    ]);
  });

  it("preserves Gradle validation commands when root Maven and Gradle files coexist", async () => {
    const root = await fixtureRoot("clawpatch-root-maven-gradle-commands-");
    await writeFixture(root, "pom.xml", "<project><artifactId>dual-build</artifactId></project>\n");
    await writeFixture(root, "build.gradle", "plugins { id 'java' }\n");
    await writeFixture(
      root,
      "src/main/java/com/acme/App.java",
      "package com.acme;\nclass App {}\n",
    );

    const project = await detectProject(root);

    expect(project.detected.packageManagers).toEqual(expect.arrayContaining(["gradle", "maven"]));
    expect(project.detected.commands).toMatchObject({
      typecheck: "gradle build",
      test: "gradle test",
    });
  });

  it("maps Spring JVM roles from Maven Java projects", async () => {
    const root = await fixtureRoot("clawpatch-maven-spring-role-map-");
    await writeFixture(
      root,
      "pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>orders-api</artifactId>",
        "  <version>1.0.0</version>",
        "  <dependencies>",
        "    <dependency>",
        "      <groupId>org.springframework.boot</groupId>",
        "      <artifactId>spring-boot-starter-web</artifactId>",
        "    </dependency>",
        "    <dependency>",
        "      <groupId>org.springframework.boot</groupId>",
        "      <artifactId>spring-boot-starter-data-jpa</artifactId>",
        "    </dependency>",
        "  </dependencies>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(root, ".mvn/maven.config", "-Dspring.profiles.active=local\n");
    await writeFixture(root, "src/main/resources/application.yml", "server:\n  port: 8080\n");
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
      "src/main/java/com/acme/db/OrderRepository.java",
      [
        "package com.acme.db;",
        "",
        "import org.springframework.stereotype.Repository;",
        "",
        "@Repository",
        "public interface OrderRepository {}",
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
      "src/main/java/com/acme/config/AppConfig.java",
      [
        "package com.acme.config;",
        "",
        "import org.springframework.context.annotation.Configuration;",
        "",
        "@Configuration",
        "public class AppConfig {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const bySource = new Map(result.features.map((feature) => [feature.source, feature]));
    const module = result.features.find((feature) => feature.title === "Maven module orders-api");

    expect(project.detected.frameworks).toEqual(expect.arrayContaining(["spring", "spring-boot"]));
    expect(module?.tags).toEqual(
      expect.arrayContaining([
        "maven",
        "project:orders-api",
        "project-root:.",
        "spring",
        "spring-boot",
      ]),
    );
    expect(module?.contextFiles.map((file) => file.path).toSorted()).toEqual(
      [".mvn/maven.config", "src/main/resources/application.yml"].toSorted(),
    );
    expect(bySource.get("jvm-role-web-entrypoint")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/api/OrderController.java",
    );
    expect(bySource.get("jvm-role-application-service")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/app/BillingService.java",
    );
    expect(bySource.get("jvm-role-persistence-boundary")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/db/OrderRepository.java",
    );
    expect(bySource.get("jvm-role-external-client")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/client/RemoteClient.java",
    );
    expect(bySource.get("jvm-role-configuration")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/config/AppConfig.java",
    );
  });

  it("ignores Maven metadata inside XML comments", async () => {
    const root = await fixtureRoot("clawpatch-maven-xml-comments-");
    await writeFixture(
      root,
      "pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>commented-app</artifactId>",
        "  <version>1.0.0</version>",
        "  <!-- <modules><module>ghost</module></modules> -->",
        "  <!-- <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies> -->",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/App.java",
      "package com.acme;\nclass App {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.frameworks).not.toContain("spring");
    expect(project.detected.frameworks).not.toContain("spring-boot");
    expect(titles).toContain("Maven module commented-app");
    expect(titles).not.toContain("Maven module ghost");
  });

  it("maps Maven multi-module projects without empty parent source groups", async () => {
    const root = await fixtureRoot("clawpatch-maven-multimodule-map-");
    await writeFixture(
      root,
      "pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>root-parent</artifactId>",
        "  <version>1.0.0</version>",
        "  <packaging>pom</packaging>",
        "  <modules>",
        "    <module>core</module>",
        "    <module>services</module>",
        "  </modules>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "core/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <parent>",
        "    <groupId>com.acme</groupId>",
        "    <artifactId>root-parent</artifactId>",
        "    <version>1.0.0</version>",
        "  </parent>",
        "  <artifactId>core-service</artifactId>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "core/src/main/java/com/acme/Core.java",
      "package com.acme;\nclass Core {}\n",
    );
    await writeFixture(
      root,
      "services/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <parent>",
        "    <groupId>com.acme</groupId>",
        "    <artifactId>root-parent</artifactId>",
        "    <version>1.0.0</version>",
        "  </parent>",
        "  <artifactId>services-parent</artifactId>",
        "  <packaging>pom</packaging>",
        "  <modules>",
        "    <module>api</module>",
        "    <module>../shared</module>",
        "  </modules>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "services/api/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <parent>",
        "    <groupId>com.acme</groupId>",
        "    <artifactId>root-parent</artifactId>",
        "    <version>1.0.0</version>",
        "  </parent>",
        "  <artifactId>api-service</artifactId>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "services/api/src/main/java/com/acme/api/Api.java",
      "package com.acme.api;\nclass Api {}\n",
    );
    await writeFixture(
      root,
      "shared/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <parent>",
        "    <groupId>com.acme</groupId>",
        "    <artifactId>root-parent</artifactId>",
        "    <version>1.0.0</version>",
        "  </parent>",
        "  <artifactId>shared-library</artifactId>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "shared/src/main/java/com/acme/shared/Shared.java",
      "package com.acme.shared;\nclass Shared {}\n",
    );
    await writeFixture(
      root,
      "tools/standalone/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme.tools</groupId>",
        "  <artifactId>standalone-tool</artifactId>",
        "  <version>1.0.0</version>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "tools/standalone/src/main/java/com/acme/tools/Tool.java",
      "package com.acme.tools;\nclass Tool {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const core = result.features.find((feature) => feature.title === "Maven module core-service");

    expect(project.detected.packageManagers).toContain("maven");
    expect(project.detected.commands).toMatchObject({
      typecheck: "mvn -DskipTests compile",
      test: "mvn test",
    });
    expect(titles).toContain("Maven module root-parent");
    expect(titles).toContain("Maven module services-parent");
    expect(titles).toContain("Maven module core-service");
    expect(titles).toContain("Maven module api-service");
    expect(titles).toContain("Maven module shared-library");
    expect(titles).toContain("Maven module standalone-tool");
    expect(titles).toContain("Maven source core/src");
    expect(titles).toContain("Maven source services/api/src");
    expect(titles).toContain("Maven source shared/src");
    expect(titles).toContain("Maven source tools/standalone/src");
    expect(titles).not.toContain("Maven source src");
    expect(titles).not.toContain("Maven source services/src");
    expect(titles.filter((title) => title === "Maven module api-service")).toHaveLength(1);
    expect(titles.filter((title) => title === "Maven module shared-library")).toHaveLength(1);
    expect(core?.tags).toEqual(
      expect.arrayContaining(["project:core-service", "project-root:core"]),
    );
  });

  it("maps nested Maven projects without assigning root validation commands", async () => {
    const root = await fixtureRoot("clawpatch-nested-maven-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(
      root,
      "apps/service/pom.xml",
      [
        "<project>",
        "  <modelVersion>4.0.0</modelVersion>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>service-app</artifactId>",
        "  <version>1.0.0</version>",
        "</project>",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/service/src/main/java/com/acme/App.java",
      "package com.acme;\nclass App {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("maven");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBeNull();
    expect(titles).toContain("Maven module service-app");
    expect(titles).toContain("Maven source apps/service/src");
  });

  it("ignores Maven manifests under fixtures and testdata during detection", async () => {
    const root = await fixtureRoot("clawpatch-maven-fixture-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(
      root,
      "testdata/pom.xml",
      "<project><artifactId>fixture</artifactId></project>\n",
    );
    await writeFixture(root, "testdata/src/main/java/com/example/App.java", "class App {}\n");
    await writeFixture(
      root,
      "fixtures/service/pom.xml",
      "<project><artifactId>sample</artifactId></project>\n",
    );
    await writeFixture(
      root,
      "fixtures/service/src/main/java/com/example/App.java",
      "class App {}\n",
    );
    await writeFixture(
      root,
      "vendor/lib/pom.xml",
      "<project><artifactId>vendored</artifactId></project>\n",
    );
    await writeFixture(root, "vendor/lib/src/main/java/com/example/App.java", "class App {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.packageManagers).not.toContain("maven");
    expect(result.features.some((feature) => feature.source.startsWith("maven-"))).toBe(false);
  });
});
