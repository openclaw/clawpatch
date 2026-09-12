import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;

describe("mapFeatures", () => {
  it("quotes nested Swift package roots with shell metacharacters", async () => {
    const root = await fixtureRoot("clawpatch-swift-quoted-package-path-");
    const packageRoot = "apps/macos; touch INJECTED";
    await writeFixture(
      root,
      `${packageRoot}/Package.swift`,
      [
        "// swift-tools-version: 6.0",
        "import PackageDescription",
        "let package = Package(",
        '  name: "MacApp",',
        '  targets: [.executableTarget(name: "MacApp"), .testTarget(name: "MacAppTests", dependencies: ["MacApp"])]',
        ")",
      ].join("\n"),
    );
    await writeFixture(root, `${packageRoot}/Sources/MacApp/main.swift`, "@main struct App {}\n");
    await writeFixture(
      root,
      `${packageRoot}/Tests/MacAppTests/MacAppTests.swift`,
      "import Testing\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const mac = result.features.find((feature) =>
      feature.title.startsWith("Swift executable MacApp"),
    );

    expect(mac?.tests).toEqual([
      {
        path: `${packageRoot}/Tests/MacAppTests/MacAppTests.swift`,
        command: 'swift test --package-path "apps/macos; touch INJECTED"',
      },
    ]);
  });

  it("ignores vendored SwiftPM manifests during detection", async () => {
    const root = await fixtureRoot("clawpatch-vendored-swiftpm-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: MobileApp\n");
    await writeFixture(
      root,
      "apps/ios/SourcePackages/checkouts/Dependency/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Dependency")\n',
    );

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
  });

  it("detects Swift sources in pure Apple projects", async () => {
    const root = await fixtureRoot("clawpatch-pure-apple-swift-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: MobileApp\n");
    await writeFixture(root, "apps/ios/Sources/App.swift", "@main struct MobileApp {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
    expect(titles).toContain("Apple source apps/ios/Sources");
  });

  it("chooses Apple project manifests deterministically", async () => {
    const root = await fixtureRoot("clawpatch-apple-manifest-order-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/B.xcodeproj", "");
    await writeFixture(root, "apps/ios/A.xcworkspace", "");
    await writeFixture(root, "apps/ios/Sources/App.swift", "@main struct MobileApp {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apple = result.features.find((feature) => feature.title === "Apple project apps/ios");

    expect(apple?.entrypoints[0]?.path).toBe("apps/ios/A.xcworkspace");
  });

  it("maps Apple projects that also contain SwiftPM manifests", async () => {
    const root = await fixtureRoot("clawpatch-hybrid-apple-swiftpm-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: HybridApp\n");
    await writeFixture(
      root,
      "apps/ios/Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "HybridApp", targets: [.target(name: "HybridApp")])
`,
    );
    await writeFixture(root, "apps/ios/Sources/HybridApp/App.swift", "public struct App {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("swiftpm");
    expect(titles).toContain("Apple project apps/ios");
    expect(titles).toContain("Apple source apps/ios/Sources");
    expect(titles).toContain("Swift target HybridApp (apps/ios)");
    expect(titles).not.toContain("Apple source apps/ios/Package.swift");
    expect(
      result.features
        .filter((feature) => feature.source === "apple-source-group")
        .flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("apps/ios/Package.swift");
  });

  it("maps SwiftPM executable targets, libraries, tests, and Swift defaults", async () => {
    const root = await fixtureRoot("clawpatch-swift-map-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SwiftFixture",
  targets: [
    .executableTarget(name: "Tool"),
    .target(name: "Core"),
    .testTarget(name: "CoreTests", dependencies: ["Core"])
  ]
)
`,
    );
    await writeFixture(
      root,
      "Sources/Tool/Tool.swift",
      "@main\nstruct Tool { static func main() {} }\n",
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func works() {}\n",
    );
    await writeFixture(
      root,
      "Tests/OtherTests/OtherTests.swift",
      "import Testing\n@Test func unrelated() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("swift");
    expect(project.detected.packageManagers).toContain("swiftpm");
    expect(project.detected.commands.typecheck).toBe("swift build");
    expect(project.detected.commands.test).toBe("swift test");
    expect(titles).toContain("Swift executable Tool");
    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift test suite CoreTests");
    expect(titles).toContain("Swift test suite OtherTests");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("ignores commented SwiftPM target declarations", async () => {
    const root = await fixtureRoot("clawpatch-swift-comments-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Comments",
  targets: [
    // .target(name: "Old"),
    /* .target(name: "BlockOld"), */
    /*
      disabled:
      /* nested */
      .target(name: "NestedOld"),
    */
    .target(name: "Core")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Old/Old.swift", "public struct Old {}\n");
    await writeFixture(root, "Sources/BlockOld/BlockOld.swift", "public struct BlockOld {}\n");
    await writeFixture(root, "Sources/NestedOld/NestedOld.swift", "public struct NestedOld {}\n");
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).not.toContain("Swift target Old");
    expect(titles).not.toContain("Swift target BlockOld");
    expect(titles).not.toContain("Swift target NestedOld");
  });

  it("ignores commented and string Swift main attributes", async () => {
    const root = await fixtureRoot("clawpatch-swift-main-comments-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "MainComments", targets: [.target(name: "Core")])
`,
    );
    await writeFixture(
      root,
      "Sources/Core/Core.swift",
      `/// Used by @main executables.
public struct Core {
  let marker = "@main"
}
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find((candidate) => candidate.title === "Swift target Core");

    expect(feature?.kind).toBe("library");
    expect(feature?.entrypoints[0]?.command).toBeNull();
  });

  it("uses manifest target names for SwiftPM custom paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-custom-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "CustomPath",
  targets: [
    .target(name: "Core", dependencies: [.target(name: "Util")], path: "Sources/Shared"),
    .target(name: "Util"),
    .testTarget(name: "CoreTests", dependencies: ["Core"], path: "CustomTests/CoreTests")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Shared/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Sources/Util/Util.swift", "public struct Util {}\n");
    await writeFixture(
      root,
      "CustomTests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func works() {}\n",
    );
    await writeFixture(
      root,
      "Tests/SharedTests/SharedTests.swift",
      "import Testing\n@Test func unrelated() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift target Util");
    expect(titles).not.toContain("Swift target Shared");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "CustomTests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("links SwiftPM tests from arbitrary manifest test paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-specs-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SpecsPath",
  targets: [
    .target(name: "Core"),
    .testTarget(name: "CoreTests", dependencies: ["Core"], path: "Specs")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Specs/CoreTests.swift", "import Testing\n@Test func works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Specs/CoreTests.swift", command: "swift test" }],
    );
    expect(
      result.features.find((feature) => feature.title === "Swift test suite CoreTests")
        ?.entrypoints[0]?.path,
    ).toBe("Specs/CoreTests.swift");
  });

  it("links custom SwiftPM test targets by dependency", async () => {
    const root = await fixtureRoot("clawpatch-swift-custom-test-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "CustomTestName",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "UnitSpecs",
      dependencies: [
        .product(name: "FixtureSupport", package: "fixture", condition: .when(platforms: [.macOS])),
        "Core"
      ],
      path: "Specs"
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Specs/CoreSpec.swift", "import Testing\n@Test func works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Specs/CoreSpec.swift", command: "swift test" }],
    );
  });

  it("does not link SwiftPM external product names as local target dependencies", async () => {
    const root = await fixtureRoot("clawpatch-swift-external-product-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "ExternalProductName",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "ExternalSpecs",
      dependencies: [
        .product(name: "Core", package: "external-core")
      ],
      path: "ExternalSpecs"
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "ExternalSpecs/ExternalSpec.swift",
      "import Testing\n@Test func works() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [],
    );
  });

  it("links custom SwiftPM test targets at default test paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-default-custom-test-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "DefaultCustomTestName",
  targets: [
    .target(name: "Core"),
    .testTarget(name: "UnitSpecs", dependencies: ["Core"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/UnitSpecs/UnitSpecs.swift",
      "import Testing\n@Test func works() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/UnitSpecs/UnitSpecs.swift", command: "swift test" }],
    );
  });

  it("maps SwiftPM targets with root custom paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-root-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "RootPath",
  targets: [
    .executableTarget(name: "Tool", path: "."),
    .testTarget(name: "ToolTests", dependencies: ["Tool"])
  ]
)
`,
    );
    await writeFixture(root, "main.swift", 'print("hi")\n');
    await writeFixture(root, "A.swift", "struct Helper {}\n");
    await writeFixture(
      root,
      "Tests/ToolTests/ToolTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable Tool",
    );

    expect(feature?.entrypoints[0]?.path).toBe("main.swift");
    expect(feature?.tests).toEqual([
      { path: "Tests/ToolTests/ToolTests.swift", command: "swift test" },
    ]);
    expect(result.features.map((candidate) => candidate.title)).toContain(
      "Swift test suite ToolTests",
    );
  });

  it("handles SwiftPM root test paths with source filters", async () => {
    const root = await fixtureRoot("clawpatch-swift-root-test-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "RootTestPath",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "CoreTests",
      dependencies: ["Core"],
      path: ".",
      sources: ["Tests/CoreTests"]
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift test suite CoreTests");
    expect(titles).not.toContain("Swift test suite Core");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("ignores SwiftPM custom paths that escape the repo", async () => {
    const root = await fixtureRoot("clawpatch-swift-escape-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Escape",
  targets: [
    .executableTarget(name: "Tool", path: "../outside")
  ]
)
`,
    );
    await writeFixture(
      root,
      "../outside/main.swift",
      "@main\nstruct Tool { static func main() {} }\n",
    );
    await writeFixture(root, "Sources/Tool/main.swift", 'print("fallback must not map")\n');

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Swift executable Tool");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  symlinkIt("ignores SwiftPM custom paths through symlinks outside the repo", async () => {
    const root = await fixtureRoot("clawpatch-swift-symlink-path-");
    const external = await fixtureRoot("clawpatch-swift-external-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SymlinkPath",
  targets: [
    .target(name: "Outside", path: "linked/src")
  ]
)
`,
    );
    await writeFixture(external, "src/Outside.swift", "public struct Outside {}\n");
    await symlink(external, join(root, "linked"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Swift target Outside");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  it("does not seed swift test when a SwiftPM package has no tests", async () => {
    const root = await fixtureRoot("clawpatch-swift-no-tests-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "NoTests", targets: [.executableTarget(name: "NoTests")])
// .testTarget(name: "OldTests")
/*
  disabled:
  /* nested */
  .testTarget(name: "BlockOldTests")
*/
`,
    );
    await writeFixture(root, "Tests/fixtures/data.json", "{}\n");
    await writeFixture(
      root,
      "Sources/NoTests/NoTests.swift",
      "@main\nstruct NoTests { static func main() {} }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable NoTests",
    );

    expect(project.detected.commands.typecheck).toBe("swift build");
    expect(project.detected.commands.test).toBeNull();
    expect(feature?.tests).toEqual([]);
  });

  symlinkIt("ignores symlinked SwiftPM test directories", async () => {
    const root = await fixtureRoot("clawpatch-swift-symlink-tests-");
    const external = await fixtureRoot("clawpatch-swift-external-tests-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "NoTests", targets: [.executableTarget(name: "NoTests")])
`,
    );
    await writeFixture(root, "Sources/NoTests/main.swift", 'print("hi")\n');
    await writeFixture(
      external,
      "NoTestsTests/NoTestsTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );
    await symlink(external, join(root, "Tests"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable NoTests",
    );

    expect(project.detected.commands.test).toBeNull();
    expect(feature?.tests).toEqual([]);
  });

  it("uses manifest target names for flat SwiftPM source layouts", async () => {
    const root = await fixtureRoot("clawpatch-swift-flat-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Flat",
  targets: [
    .executableTarget(name: "Flat"),
    .testTarget(name: "FlatTests", dependencies: ["Flat"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/main.swift", 'print("flat")\n');
    await writeFixture(
      root,
      "Tests/FlatTests/FlatTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable Flat",
    );

    expect(feature).toBeDefined();
    expect(feature?.entrypoints[0]?.command).toBe("Flat");
    expect(feature?.entrypoints[0]?.path).toBe("Sources/main.swift");
    expect(feature?.tests).toEqual([
      { path: "Tests/FlatTests/FlatTests.swift", command: "swift test" },
    ]);
  });

  it("preserves SwiftPM source targets declared under Tests", async () => {
    const root = await fixtureRoot("clawpatch-swift-test-helper-target-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "TestHelper",
  targets: [
    .target(name: "TestResources", path: "Tests/TestResources"),
    .testTarget(
      name: "CoreTests",
      dependencies: ["TestResources"],
      path: "Tests/CoreTests"
    )
  ]
)
`,
    );
    await writeFixture(
      root,
      "Tests/TestResources/Resources.swift",
      "public struct TestResources {}\n",
    );
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target TestResources");
    expect(titles).not.toContain("Swift test suite TestResources");
    expect(
      result.features.find((feature) => feature.title === "Swift target TestResources")?.tests,
    ).toEqual([{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }]);
  });

  it("preserves SwiftPM targets sharing a path with sources filters", async () => {
    const root = await fixtureRoot("clawpatch-swift-shared-source-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SharedPath",
  targets: [
    .target(name: "Core", path: "Sources", sources: ["Core"]),
    .target(name: "Util", path: "Sources", sources: ["Util"]),
    .testTarget(
      name: "CoreTests",
      dependencies: ["Core"],
      path: "Tests",
      sources: ["CoreTests"]
    ),
    .testTarget(
      name: "UtilTests",
      dependencies: ["Util"],
      path: "Tests",
      sources: ["UtilTests"]
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Sources/Util/Util.swift", "public struct Util {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func core() {}\n",
    );
    await writeFixture(
      root,
      "Tests/UtilTests/UtilTests.swift",
      "import Testing\n@Test func util() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const core = result.features.find((feature) => feature.title === "Swift target Core");
    const util = result.features.find((feature) => feature.title === "Swift target Util");

    expect(core?.entrypoints[0]?.path).toBe("Sources/Core/Core.swift");
    expect(util?.entrypoints[0]?.path).toBe("Sources/Util/Util.swift");
    expect(core?.tests).toEqual([
      { path: "Tests/CoreTests/CoreTests.swift", command: "swift test" },
    ]);
    expect(util?.tests).toEqual([
      { path: "Tests/UtilTests/UtilTests.swift", command: "swift test" },
    ]);
  });

  it("maps SwiftPM source filters that point at files", async () => {
    const root = await fixtureRoot("clawpatch-swift-file-source-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "FileSource",
  targets: [
    .target(name: "Core", path: "Sources", sources: ["Core.swift"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core.swift", "public struct Core {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const core = result.features.find((feature) => feature.title === "Swift target Core");

    expect(core?.entrypoints[0]?.path).toBe("Sources/Core.swift");
  });
});
