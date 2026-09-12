import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("maps CMake C and C++ targets without duplicating main files", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-map-");
    const cmakeRoot = root.replaceAll("\\", "/");
    await writeFixture(
      root,
      "CMakeLists.txt",
      `add_executable(myapp src/main.cpp src/util.cpp)
add_executable(quoted "src/quoted.cpp")
ADD_EXECUTABLE(upper src/upper.c)
add_executable(absin ${cmakeRoot}/src/absin.cpp)
add_executable(absout /src/main.cpp)
add_executable(7zip src/seven.c)
add_executable(latebin)
target_sources(latebin PRIVATE src/late_main.c src/late_util.c)
#[[
add_executable(commented src/commented.c)
]]
add_library(core STATIC include/core.hpp src/core.c src/core_util.c)
add_library(foo.bar STATIC src/dot.c)
add_library(latelib)
target_sources(latelib PUBLIC src/late_lib.c include/late_lib.hpp)
ADD_LIBRARY(upperlib STATIC src/upperlib.c)
add_library(headers INTERFACE include/headers.hpp)
add_library(vendored INTERFACE vendor/dep.hpp)
add_executable(varapp \${APP_SOURCES})
add_executable(headerapp include/headers.hpp)
`,
    );
    await writeFixture(root, "src/main.cpp", "int main(int argc, char **argv) { return 0; }\n");
    await writeFixture(root, "src/quoted.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/upper.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/absin.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/seven.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/late_main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/late_util.c", "int late_util(void) { return 0; }\n");
    await writeFixture(root, "src/commented.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.cpp", "int util() { return 1; }\n");
    await writeFixture(root, "include/core.hpp", "int core(void);\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "src/core_util.c", "int core_util(void) { return 2; }\n");
    await writeFixture(root, "src/dot.c", "int dot(void) { return 1; }\n");
    await writeFixture(root, "src/late_lib.c", "int late_lib(void) { return 1; }\n");
    await writeFixture(root, "include/late_lib.hpp", "int late_lib(void);\n");
    await writeFixture(root, "src/upperlib.c", "int upperlib(void) { return 1; }\n");
    await writeFixture(root, "include/headers.hpp", "int header_only(void);\n");
    await writeFixture(root, "vendor/dep.hpp", "int dep(void);\n");
    await writeFixture(root, "tests/myapp_test.cpp", "int main() { return 0; }\n");
    await writeFixture(root, "src/deps/myapp_test.cpp", "int main() { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const myapp = result.features.find((feature) => feature.title === "CMake binary myapp");
    const latebin = result.features.find((feature) => feature.title === "CMake binary latebin");
    const core = result.features.find((feature) => feature.title === "CMake library core");
    const latelib = result.features.find((feature) => feature.title === "CMake library latelib");
    const headers = result.features.find((feature) => feature.title === "CMake library headers");
    const mainFeatures = result.features.filter(
      (feature) =>
        feature.kind === "cli-command" && feature.entrypoints[0]?.path === "src/main.cpp",
    );

    expect(project.detected.languages).toEqual(expect.arrayContaining(["c", "cpp"]));
    expect(project.detected.packageManagers).toContain("cmake");
    expect(titles).toContain("CMake binary myapp");
    expect(titles).toContain("CMake binary quoted");
    expect(titles).toContain("CMake binary upper");
    expect(titles).toContain("CMake binary absin");
    expect(titles).toContain("CMake binary 7zip");
    expect(titles).toContain("CMake binary latebin");
    expect(titles).not.toContain("CMake binary absout");
    expect(titles).not.toContain("CMake binary commented");
    expect(titles).toContain("CMake library core");
    expect(titles).toContain("CMake library foo.bar");
    expect(titles).toContain("CMake library latelib");
    expect(titles).toContain("CMake library upperlib");
    expect(titles).toContain("CMake library headers");
    expect(titles).not.toContain("CMake library vendored");
    expect(titles).not.toContain("CMake binary varapp");
    expect(titles).not.toContain("CMake binary headerapp");
    expect(titles).not.toContain("C++ binary main_test");
    expect(mainFeatures).toHaveLength(1);
    expect(myapp?.source).toBe("cmake-bin");
    expect(myapp?.ownedFiles).toEqual([
      { path: "src/main.cpp", reason: "target source" },
      { path: "src/util.cpp", reason: "target source" },
    ]);
    expect(myapp?.contextFiles).toEqual([
      { path: "CMakeLists.txt", reason: "CMake target declaration" },
      { path: "tests/myapp_test.cpp", reason: "nearby test" },
    ]);
    expect(myapp?.tests).toEqual([{ path: "tests/myapp_test.cpp", command: null }]);
    expect(latebin?.entrypoints[0]?.path).toBe("src/late_main.c");
    expect(latebin?.ownedFiles).toEqual([
      { path: "src/late_main.c", reason: "target source" },
      { path: "src/late_util.c", reason: "target source" },
    ]);
    expect(core?.entrypoints[0]?.path).toBe("src/core.c");
    expect(core?.entrypoints[0]?.symbol).toBeNull();
    expect(core?.ownedFiles).toEqual([
      { path: "include/core.hpp", reason: "target source" },
      { path: "src/core.c", reason: "target source" },
      { path: "src/core_util.c", reason: "target source" },
    ]);
    expect(latelib?.ownedFiles).toEqual([
      { path: "src/late_lib.c", reason: "target source" },
      { path: "include/late_lib.hpp", reason: "target source" },
    ]);
    expect(headers?.ownedFiles).toEqual([{ path: "include/headers.hpp", reason: "target source" }]);
  });

  it("maps a standalone CUDA source file with main as a CUDA binary", async () => {
    const root = await fixtureRoot("clawpatch-cuda-standalone-");
    await writeFixture(
      root,
      "saxpy.cu",
      "__global__ void saxpy(float *x) { x[threadIdx.x] *= 2.0f; }\nint main(void) { return 0; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const saxpy = result.features.find((feature) => feature.title === "CUDA binary saxpy");

    expect(saxpy?.source).toBe("c-main");
    expect(saxpy?.entrypoints[0]).toMatchObject({ path: "saxpy.cu", symbol: "main" });
    expect(saxpy?.tags).toContain("cuda");
    expect(saxpy?.trustBoundaries).toContain("concurrency");
  });

  it("maps CMake CUDA targets including .cu and .cuh sources", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cuda-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(gpuapp CUDA)\nadd_executable(gpuapp src/main.cu src/kernels.cu src/kernels.cuh)\n",
    );
    await writeFixture(root, "src/main.cu", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "src/kernels.cu",
      "__global__ void scale(float *x) { x[0] = 1.0f; }\n",
    );
    await writeFixture(root, "src/kernels.cuh", "__global__ void scale(float *x);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const gpuapp = result.features.find((feature) => feature.title === "CMake binary gpuapp");

    expect(gpuapp?.entrypoints[0]).toMatchObject({ path: "src/main.cu", symbol: "main" });
    expect(gpuapp?.tags).toContain("cuda");
    expect(gpuapp?.trustBoundaries).toContain("concurrency");
    expect(gpuapp?.ownedFiles).toEqual([
      { path: "src/main.cu", reason: "target source" },
      { path: "src/kernels.cu", reason: "target source" },
      { path: "src/kernels.cuh", reason: "target source" },
    ]);
  });

  it("maps legacy FindCUDA cuda_add_executable and cuda_add_library targets", async () => {
    const root = await fixtureRoot("clawpatch-cmake-find-cuda-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "find_package(CUDA REQUIRED)\ncuda_add_executable(gpuapp src/main.cu)\ncuda_add_library(gpukernels src/kernels.cu)\n",
    );
    await writeFixture(root, "src/main.cu", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "src/kernels.cu",
      "__global__ void scale(float *x) { x[0] = 1.0f; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const gpuapp = result.features.find((feature) => feature.title === "CMake binary gpuapp");
    const gpukernels = result.features.find(
      (feature) => feature.title === "CMake library gpukernels",
    );

    expect(titles).toContain("CMake binary gpuapp");
    expect(titles).toContain("CMake library gpukernels");
    expect(gpuapp?.entrypoints[0]).toMatchObject({ path: "src/main.cu", symbol: "main" });
    expect(gpuapp?.tags).toContain("cuda");
    expect(gpuapp?.summary).toContain("cuda_add_executable");
    expect(gpukernels?.ownedFiles).toEqual([{ path: "src/kernels.cu", reason: "target source" }]);
  });

  it("detects CUDA projects from .cu sources", async () => {
    const root = await fixtureRoot("clawpatch-cuda-detect-");
    await writeFixture(root, "src/kernel.cu", "__global__ void noop(void) {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("cuda");
  });

  it("tags mixed CMake targets as CUDA when any owned source is .cu", async () => {
    const root = await fixtureRoot("clawpatch-cmake-mixed-cuda-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(gpuapp CUDA CXX)\nadd_executable(gpuapp src/main.cpp src/kernel.cu)\n",
    );
    await writeFixture(root, "src/main.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/kernel.cu", "__global__ void scale(float *x) { x[0] = 1.0f; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const gpuapp = result.features.find((feature) => feature.title === "CMake binary gpuapp");

    expect(gpuapp?.entrypoints[0]).toMatchObject({ path: "src/main.cpp", symbol: "main" });
    expect(gpuapp?.tags).toContain("cuda");
    expect(gpuapp?.trustBoundaries).toContain("concurrency");
  });

  it("maps CMake and autotools build files as config features", async () => {
    const root = await fixtureRoot("clawpatch-build-config-");
    await writeFixture(root, "CMakeLists.txt", "project(app CXX)\nadd_executable(app main.cpp)\n");
    await writeFixture(root, "CMakePresets.json", '{"version":6}\n');
    await writeFixture(root, "configure.ac", "AC_INIT([app],[1.0])\n");
    await writeFixture(root, "main.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Project config CMakeLists.txt");
    expect(titles).toContain("Project config CMakePresets.json");
    expect(titles).toContain("Project config configure.ac");
  });

  it("maps loose C++ sources with no build target as a source-group feature", async () => {
    const root = await fixtureRoot("clawpatch-cpp-group-");
    await writeFixture(root, "lib/parser.cpp", "int parse(void) { return 0; }\n");
    await writeFixture(root, "lib/lexer.cpp", "int lex(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const group = result.features.find((feature) => feature.title === "C/C++ source group lib");

    expect(group?.kind).toBe("library");
    expect(group?.source).toBe("c-cpp-group");
    expect(group?.ownedFiles).toEqual([
      { path: "lib/lexer.cpp", reason: "source group member" },
      { path: "lib/parser.cpp", reason: "source group member" },
    ]);
  });

  it("excludes files already owned by a CMake target from source groups", async () => {
    const root = await fixtureRoot("clawpatch-cpp-group-exclude-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.cpp)\n");
    await writeFixture(root, "src/main.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/helper.cpp", "int help(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const group = result.features.find((feature) => feature.title === "C/C++ source group src");

    expect(group?.ownedFiles).toEqual([{ path: "src/helper.cpp", reason: "source group member" }]);
  });

  it("maps a loose CUDA kernel directory as a CUDA source group with concurrency", async () => {
    const root = await fixtureRoot("clawpatch-cuda-group-");
    await writeFixture(
      root,
      "kernels/reduce.cu",
      "__global__ void reduce(float *x) { x[0] = 0; }\n",
    );
    await writeFixture(root, "kernels/reduce.cuh", "__global__ void reduce(float *x);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const group = result.features.find((feature) => feature.title === "CUDA source group kernels");

    expect(group?.tags).toContain("cuda");
    expect(group?.trustBoundaries).toContain("concurrency");
    expect(group?.ownedFiles).toEqual([
      { path: "kernels/reduce.cu", reason: "source group member" },
      { path: "kernels/reduce.cuh", reason: "source group member" },
    ]);
  });

  it("does not attach unrelated top-level CMake tests to every target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-test-scope-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/app.cpp)\nadd_executable(tool src/tool.cpp)\n",
    );
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/tool.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/tool_test.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const tool = result.features.find((feature) => feature.title === "CMake binary tool");

    expect(app?.tests).toEqual([]);
    expect(tool?.tests).toEqual([{ path: "tests/tool_test.cpp", command: null }]);
  });

  it("does not attach generic main CMake tests to every target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-generic-main-test-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(foo foo/main.c)\nadd_executable(bar bar/main.c)\n",
    );
    await writeFixture(root, "foo/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "bar/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/main_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const foo = result.features.find((feature) => feature.title === "CMake binary foo");
    const bar = result.features.find((feature) => feature.title === "CMake binary bar");

    expect(foo?.tests).toEqual([]);
    expect(bar?.tests).toEqual([]);
  });

  it("maps CMake test executables as test suites", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-executable-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/app.cpp)\nadd_executable(unit_tests src/unit.cpp)\n",
    );
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/unit.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const suite = result.features.find(
      (feature) => feature.title === "CMake test suite unit_tests",
    );

    expect(titles).toContain("CMake binary app");
    expect(titles).not.toContain("CMake binary unit_tests");
    expect(titles).not.toContain("C++ binary unit");
    expect(suite).toMatchObject({
      kind: "test-suite",
      source: "cmake-test",
      entrypoints: [{ path: "src/unit.cpp", symbol: null, route: null, command: null }],
      ownedFiles: [{ path: "src/unit.cpp", reason: "target source" }],
    });
  });

  it("keeps CMake binaries with helper source names that look test-like", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-like-helper-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c src/test_mode.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/test_mode.c", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake test suite app");
    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/test_mode.c", reason: "target source" },
    ]);
  });

  it("keeps CMake binaries when a test-like helper comes before main", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-like-helper-before-main-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/test_mode.c src/runner.c)\n",
    );
    await writeFixture(root, "src/test_mode.c", "int helper(void) { return 0; }\n");
    await writeFixture(root, "src/runner.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(titles).not.toContain("CMake test suite app");
    expect(app?.entrypoints[0]?.path).toBe("src/runner.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/test_mode.c", reason: "target source" },
      { path: "src/runner.c", reason: "target source" },
    ]);
  });

  it("attaches CMake tests named after the target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-named-tests-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/app_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.tests).toEqual([{ path: "tests/app_test.c", command: null }]);
    expect(app?.contextFiles).toContainEqual({ path: "tests/app_test.c", reason: "nearby test" });
  });

  it("maps semicolon-separated CMake source lists", async () => {
    const root = await fixtureRoot("clawpatch-cmake-semicolon-sources-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/main.c;src/util.c)\nadd_library(core)\ntarget_sources(core PRIVATE src/core.c;include/core.h)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "include/core.h", "int core(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const core = result.features.find((feature) => feature.title === "CMake library core");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([
      { path: "src/core.c", reason: "target source" },
      { path: "include/core.h", reason: "target source" },
    ]);
  });

  it("ignores CMake helper names ending with built-in commands", async () => {
    const root = await fixtureRoot("clawpatch-cmake-helper-command-names-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "my_add_executable(app src/main.c)\nmy_add_library(core src/core.c)\nadd_executable(real src/real.c)\nmy_target_sources(real PRIVATE src/helper.c)\nmy_include(cmake/Extra.cmake)\n",
    );
    await writeFixture(root, "cmake/Extra.cmake", "add_executable(extra src/extra.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 0; }\n");
    await writeFixture(root, "src/helper.c", "int helper(void) { return 0; }\n");
    await writeFixture(root, "src/extra.c", "int extra(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const real = result.features.find((feature) => feature.title === "CMake binary real");
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary app");
    expect(titles).not.toContain("CMake library core");
    expect(titles).not.toContain("CMake binary extra");
    expect(real?.ownedFiles).toEqual([{ path: "src/real.c", reason: "target source" }]);
  });

  it("ignores CMake command text inside strings", async () => {
    const root = await fixtureRoot("clawpatch-cmake-command-string-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      'message("add_executable(fake src/main.c)")\nmessage([[add_library(fake_lib src/lib.c)]])\nadd_executable(real src/real.c)\n',
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("ignores CMake command text inside unquoted command arguments", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-command-text-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "message(STATUS add_executable(fake src/fake.c))\nset(x add_library(fake_lib src/lib.c))\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("ignores CMake commands inside uncalled function and macro bodies", async () => {
    const root = await fixtureRoot("clawpatch-cmake-uncalled-function-body-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "function(make_fake)\nadd_executable(fake src/fake.c)\nendfunction()\nmacro(make_fake_lib)\nadd_library(fake_lib src/lib.c)\nendmacro()\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("keeps CMake targets after bracket arguments containing hashes", async () => {
    const root = await fixtureRoot("clawpatch-cmake-bracket-hash-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "message([[# generated]])\nmessage([=[# also generated]=])\n#[[add_executable(fake src/fake.c)]]\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).toContain("CMake binary real");
    expect(titles).not.toContain("C binary real");
  });

  it("maps quoted CMake source paths containing spaces", async () => {
    const root = await fixtureRoot("clawpatch-cmake-quoted-space-source-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      'add_executable(app "src/main file.cpp" "src/helper file.cpp")\n',
    );
    await writeFixture(root, "src/main file.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/helper file.cpp", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main file.cpp", reason: "target source" },
      { path: "src/helper file.cpp", reason: "target source" },
    ]);
  });

  it("maps escaped CMake source paths containing spaces and semicolons", async () => {
    const root = await fixtureRoot("clawpatch-cmake-escaped-source-path-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/main\\ file.cpp src/helper\\;part.cpp)\n",
    );
    await writeFixture(root, "src/main file.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/helper;part.cpp", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main file.cpp", reason: "target source" },
      { path: "src/helper;part.cpp", reason: "target source" },
    ]);
  });

  it("keeps target_sources scoped to standalone CMake projects", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-sources-scope-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app)\ntarget_sources(app PRIVATE src/main.c)\n",
    );
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "add_executable(app)\ntarget_sources(app PRIVATE src/main.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apps = result.features.filter((feature) => feature.title === "CMake binary app");

    expect(apps.map((feature) => feature.entrypoints[0]?.path).toSorted()).toEqual([
      "src/main.c",
      "sub/src/main.c",
    ]);
    expect(
      apps.find((feature) => feature.entrypoints[0]?.path === "src/main.c")?.ownedFiles,
    ).toEqual([{ path: "src/main.c", reason: "target source" }]);
    expect(
      apps.find((feature) => feature.entrypoints[0]?.path === "sub/src/main.c")?.ownedFiles,
    ).toEqual([{ path: "sub/src/main.c", reason: "target source" }]);
  });

  it("attaches target_sources from CMake subdirectories", async () => {
    const root = await fixtureRoot("clawpatch-cmake-subdir-target-sources-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app)\nadd_subdirectory(src)\n");
    await writeFixture(root, "src/CMakeLists.txt", "target_sources(app PRIVATE main.c util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
    expect(app?.contextFiles).toEqual([
      { path: "CMakeLists.txt", reason: "CMake target declaration" },
      { path: "src/CMakeLists.txt", reason: "CMake target source declaration" },
    ]);
    expect(titles).not.toContain("C binary main");
  });

  it("resolves PROJECT_NAME CMake targets", async () => {
    const root = await fixtureRoot("clawpatch-cmake-project-name-target-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(app C)\nadd_executable(${PROJECT_NAME})\ntarget_sources(${PROJECT_NAME} PRIVATE src/main.c src/util.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves PROJECT_NAME inside composed CMake target names", async () => {
    const root = await fixtureRoot("clawpatch-cmake-composed-project-name-target-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(foo C)\nadd_executable(${PROJECT_NAME}_cli src/main.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary foo_cli");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "foo_cli" });
    expect(app?.ownedFiles).toEqual([{ path: "src/main.c", reason: "target source" }]);
  });

  it("detects header-only C++ CMake libraries as C++ projects", async () => {
    const root = await fixtureRoot("clawpatch-cmake-header-only-cpp-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(headers INTERFACE include/headers.hpp)\n",
    );
    await writeFixture(root, "include/headers.hpp", "int header_only(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.languages).toContain("cpp");
    expect(result.features.map((feature) => feature.title)).toContain("CMake library headers");
  });

  it("maps uppercase C++ source extensions", async () => {
    const root = await fixtureRoot("clawpatch-cmake-uppercase-cpp-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(uppercpp src/MAIN.CPP src/HELPER.HPP)\n",
    );
    await writeFixture(root, "src/MAIN.CPP", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/HELPER.HPP", "int helper(void);\n");
    await writeFixture(root, "src/tool.C", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const uppercpp = result.features.find((feature) => feature.title === "CMake binary uppercpp");
    const tool = result.features.find((feature) => feature.title === "C++ binary tool");

    expect(project.detected.languages).toContain("cpp");
    expect(uppercpp?.entrypoints[0]).toMatchObject({ path: "src/MAIN.CPP", symbol: "main" });
    expect(uppercpp?.tags).toContain("cpp");
    expect(uppercpp?.ownedFiles).toEqual([
      { path: "src/MAIN.CPP", reason: "target source" },
      { path: "src/HELPER.HPP", reason: "target source" },
    ]);
    expect(tool?.entrypoints[0]).toMatchObject({ path: "src/tool.C", symbol: "main" });
    expect(tool?.tags).toContain("cpp");
  });

  it("preserves CMake targets that share the same source list", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-sources-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const coreStatic = result.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    const coreShared = result.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(titles).toContain("CMake library core_static");
    expect(titles).toContain("CMake library core_shared");
    expect(coreStatic?.entrypoints[0]?.symbol).toBe("core_static");
    expect(coreShared?.entrypoints[0]?.symbol).toBe("core_shared");
  });

  it("prefers exact target-name source stems before prefix matches", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-stem-entry-");
    await writeFixture(root, "CMakeLists.txt", "add_library(app src/apple.c src/app.c)\n");
    await writeFixture(root, "src/apple.c", "int apple(void) { return 1; }\n");
    await writeFixture(root, "src/app.c", "int app(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake library app");

    expect(app?.entrypoints[0]?.path).toBe("src/app.c");
  });

  it("keeps existing CMake library ids when a target starts sharing sources", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-source-stability-");
    await writeFixture(root, "CMakeLists.txt", "add_library(core_static STATIC src/core.c)\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstCore = first.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_shared SHARED src/core.c)\nadd_library(core_static STATIC src/core.c)\n",
    );
    const second = await mapFeatures(root, project, first.features);
    const secondCore = second.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    const shared = second.features.find((feature) => feature.title === "CMake library core_shared");

    expect(secondCore?.featureId).toBe(firstCore?.featureId);
    expect(secondCore?.entrypoints[0]?.symbol).toBeNull();
    expect(shared?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(second.stale).toBe(0);
  });

  it("keeps disambiguated CMake library ids when source sharing stops", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-source-removal-");
    await writeFixture(root, "CMakeLists.txt", "add_library(core_static STATIC src/core.c)\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    const second = await mapFeatures(root, project, first.features);
    const sharedDuringCollision = second.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );
    await writeFixture(root, "CMakeLists.txt", "add_library(core_shared SHARED src/core.c)\n");
    const third = await mapFeatures(root, project, second.features);
    const sharedAfterRemoval = third.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(sharedAfterRemoval?.featureId).toBe(sharedDuringCollision?.featureId);
    expect(sharedAfterRemoval?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(third.stale).toBe(1);
  });

  it("keeps initially disambiguated CMake library ids after source sharing stops", async () => {
    const root = await fixtureRoot("clawpatch-cmake-initial-shared-source-removal-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const sharedDuringCollision = first.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );
    await writeFixture(root, "CMakeLists.txt", "add_library(core_shared SHARED src/core.c)\n");
    const second = await mapFeatures(root, project, first.features);
    const sharedAfterRemoval = second.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(sharedAfterRemoval?.featureId).toBe(sharedDuringCollision?.featureId);
    expect(sharedAfterRemoval?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(second.stale).toBe(1);
  });

  it("does not map CMake target sources outside the project root", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-safe-sources-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(tool ../outside.c src/main.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const tool = result.features.find((feature) => feature.title === "CMake binary tool");

    expect(tool?.entrypoints[0]?.path).toBe("src/main.c");
    expect(tool?.ownedFiles).toEqual([{ path: "src/main.c", reason: "target source" }]);
    expect(
      result.features.flatMap((feature) => [
        ...feature.entrypoints.map((entrypoint) => entrypoint.path),
        ...feature.ownedFiles.map((file) => file.path),
      ]),
    ).not.toContain("../outside.c");
  });

  it("uses the CMake source that defines main as the executable entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-main-entry-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/app.cpp src/main.cpp)\n");
    await writeFixture(root, "src/app.cpp", "struct App { int main(void) { return 0; } };\n");
    await writeFixture(root, "src/main.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const mainFeatures = result.features.filter(
      (feature) =>
        feature.kind === "cli-command" && feature.entrypoints[0]?.path === "src/main.cpp",
    );

    expect(app?.entrypoints[0]?.path).toBe("src/main.cpp");
    expect(mainFeatures).toHaveLength(1);
    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary main");
  });

  it("does not map member main methods as standalone C++ binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-member-main-");
    await writeFixture(root, "src/app.cpp", "struct App { int main(void) { return 0; } };\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary app");
  });

  it("resolves targets from included CMake modules relative to the source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-include-source-dir-");
    await writeFixture(root, "CMakeLists.txt", "include(cmake/Targets.cmake)\n");
    await writeFixture(root, "cmake/Targets.cmake", "add_executable(app src/main.c src/util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves built-in CMake dir variables in includes and sources", async () => {
    const root = await fixtureRoot("clawpatch-cmake-built-in-dir-vars-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/Targets.cmake)\n",
    );
    await writeFixture(
      root,
      "cmake/Targets.cmake",
      "include(${CMAKE_CURRENT_LIST_DIR}/More.cmake)\nadd_executable(app ${CMAKE_SOURCE_DIR}/src/main.c ${PROJECT_SOURCE_DIR}/src/project.c ${CMAKE_CURRENT_SOURCE_DIR}/src/util.c ${CMAKE_CURRENT_LIST_DIR}/local.c)\n",
    );
    await writeFixture(
      root,
      "cmake/More.cmake",
      "target_sources(app PRIVATE ${CMAKE_CURRENT_LIST_DIR}/extra.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/project.c", "int project(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");
    await writeFixture(root, "cmake/local.c", "int local(void) { return 0; }\n");
    await writeFixture(root, "cmake/extra.c", "int extra(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/project.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
      { path: "cmake/local.c", reason: "target source" },
      { path: "cmake/extra.c", reason: "target source" },
    ]);
  });

  it("resolves CMake source dir variables from nested project roots", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-project-vars-");
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "add_executable(project_app ${PROJECT_SOURCE_DIR}/src/project.c)\nadd_executable(source_app ${CMAKE_SOURCE_DIR}/src/source.c)\n",
    );
    await writeFixture(root, "src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/source.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/source.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const projectApp = result.features.find(
      (feature) => feature.title === "CMake binary project_app",
    );
    const sourceApp = result.features.find(
      (feature) => feature.title === "CMake binary source_app",
    );

    expect(projectApp?.entrypoints[0]?.path).toBe("sub/src/project.c");
    expect(sourceApp?.entrypoints[0]?.path).toBe("sub/src/source.c");
  });

  it("resets PROJECT_SOURCE_DIR when nested CMakeLists declares project", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-project-source-dir-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "cmake_minimum_required(VERSION 3.20)\nproject(Root C)\nadd_subdirectory(sub)\n",
    );
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "project(Sub C)\nadd_executable(project_app ${PROJECT_SOURCE_DIR}/src/project.c)\nadd_executable(source_app ${CMAKE_SOURCE_DIR}/src/source.c)\n",
    );
    await writeFixture(root, "src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/source.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/source.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const projectApp = result.features.find(
      (feature) => feature.title === "CMake binary project_app",
    );
    const sourceApp = result.features.find(
      (feature) =>
        feature.title === "CMake binary source_app" &&
        feature.entrypoints[0]?.path === "src/source.c",
    );
    const sourceAppPaths = result.features
      .filter((feature) => feature.title === "CMake binary source_app")
      .map((feature) => feature.entrypoints[0]?.path);

    expect(projectApp?.entrypoints[0]?.path).toBe("sub/src/project.c");
    expect(sourceApp?.entrypoints[0]?.path).toBe("src/source.c");
    expect(sourceAppPaths).toEqual(["src/source.c"]);
  });

  it("resolves nested CMake includes relative to the source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-include-source-dir-");
    await writeFixture(root, "CMakeLists.txt", "include(cmake/A.cmake)\n");
    await writeFixture(root, "cmake/A.cmake", "include(cmake/B.cmake)\n");
    await writeFixture(root, "cmake/B.cmake", "add_executable(app src/main.c src/util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves repeated CMake includes relative to each source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-repeated-include-source-dir-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app)\nadd_subdirectory(a)\nadd_subdirectory(b)\n",
    );
    await writeFixture(root, "a/CMakeLists.txt", "include(../cmake/Part.cmake)\n");
    await writeFixture(root, "b/CMakeLists.txt", "include(../cmake/Part.cmake)\n");
    await writeFixture(root, "cmake/Part.cmake", "target_sources(app PRIVATE local.c)\n");
    await writeFixture(root, "a/local.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "b/local.c", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("a/local.c");
    expect(app?.ownedFiles).toEqual([
      { path: "a/local.c", reason: "target source" },
      { path: "b/local.c", reason: "target source" },
    ]);
  });

  it("ignores unreferenced CMake modules", async () => {
    const root = await fixtureRoot("clawpatch-cmake-unreferenced-module-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c)\n");
    await writeFixture(root, "cmake/Dead.cmake", "add_executable(dead src/dead.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/dead.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("CMake binary app");
    expect(titles).not.toContain("CMake binary dead");
  });

  it("maps autotools C and C++ binary and library targets", async () => {
    const root = await fixtureRoot("clawpatch-autotools-cpp-map-");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = thing my-tool defaulted header-tool # installed helpers\nbin_PROGRAMS += appended\nthing_SOURCES = thing.c \\\n  util.c\nmy_tool_SOURCES = main.c tool-util.c\nappended_SOURCES = appended.c\nappended_SOURCES += appended_util.c\nheader_tool_SOURCES = include/header.hpp\nlib_LTLIBRARIES = libcore.la libcore-extra.la\nlib_LTLIBRARIES += libmore.la\nlibcore_la_SOURCES = core.cc core_util.cc\nlibcore_extra_la_SOURCES = extra.cc\nlibmore_la_SOURCES = more.c\nlibmore_la_SOURCES += more_util.c\n",
    );
    await writeFixture(root, "thing.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tool-util.c", "int tool_util(void) { return 1; }\n");
    await writeFixture(root, "appended.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "appended_util.c", "int appended_util(void) { return 1; }\n");
    await writeFixture(root, "defaulted.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cppdefault.cpp", "int main() { return 0; }\n");
    await writeFixture(root, "include/header.hpp", "int header(void);\n");
    await writeFixture(root, "core.cc", "int core() { return 1; }\n");
    await writeFixture(root, "core_util.cc", "int coreUtil() { return 2; }\n");
    await writeFixture(root, "extra.cc", "int extra() { return 3; }\n");
    await writeFixture(root, "more.c", "int more(void) { return 3; }\n");
    await writeFixture(root, "more_util.c", "int more_util(void) { return 4; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const thing = result.features.find((feature) => feature.title === "Autotools binary thing");
    const myTool = result.features.find((feature) => feature.title === "Autotools binary my-tool");
    const appended = result.features.find(
      (feature) => feature.title === "Autotools binary appended",
    );
    const defaulted = result.features.find(
      (feature) => feature.title === "Autotools binary defaulted",
    );
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");
    const extra = result.features.find(
      (feature) => feature.title === "Autotools library libcore-extra",
    );
    const more = result.features.find((feature) => feature.title === "Autotools library libmore");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("autotools");
    expect(titles).not.toContain("Autotools binary installed");
    expect(titles).not.toContain("Autotools binary helpers");
    expect(titles).not.toContain("Autotools binary header-tool");
    expect(titles).not.toContain("Autotools binary cppdefault");
    expect(titles).toContain("C++ binary cppdefault");
    expect(thing?.entrypoints[0]).toMatchObject({
      path: "thing.c",
      symbol: "main",
      command: "thing",
    });
    expect(myTool?.entrypoints[0]).toMatchObject({
      path: "main.c",
      symbol: "main",
      command: "my-tool",
    });
    expect(myTool?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "tool-util.c", reason: "target source" },
    ]);
    expect(appended?.ownedFiles).toEqual([
      { path: "appended.c", reason: "target source" },
      { path: "appended_util.c", reason: "target source" },
    ]);
    expect(defaulted?.entrypoints[0]).toMatchObject({
      path: "defaulted.c",
      symbol: "main",
      command: "defaulted",
    });
    expect(titles).not.toContain("C binary defaulted");
    expect(thing?.ownedFiles).toEqual([
      { path: "thing.c", reason: "target source" },
      { path: "util.c", reason: "target source" },
    ]);
    expect(core?.entrypoints[0]?.path).toBe("core.cc");
    expect(core?.ownedFiles).toEqual([
      { path: "core.cc", reason: "target source" },
      { path: "core_util.cc", reason: "target source" },
    ]);
    expect(extra?.ownedFiles).toEqual([{ path: "extra.cc", reason: "target source" }]);
    expect(more?.ownedFiles).toEqual([
      { path: "more.c", reason: "target source" },
      { path: "more_util.c", reason: "target source" },
    ]);
  });

  it("maps autotools targets from Makefile.in", async () => {
    const root = await fixtureRoot("clawpatch-autotools-makefile-in-");
    await writeFixture(
      root,
      "Makefile.in",
      "bin_PROGRAMS = app$(EXEEXT)\napp_SOURCES = main.c util.c\nlib_LTLIBRARIES = libcore.la\nlibcore_la_SOURCES = core.c\n",
    );
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "Autotools binary app");
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");

    expect(project.detected.packageManagers).toContain("autotools");
    expect(app?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([{ path: "core.c", reason: "target source" }]);
  });

  it("maps autotools sources with source-directory variables", async () => {
    const root = await fixtureRoot("clawpatch-autotools-srcdir-sources-");
    await writeFixture(
      root,
      "src/Makefile.am",
      "bin_PROGRAMS = app\napp_SOURCES = $(srcdir)/main.c $(top_srcdir)/shared/util.c\nlib_LTLIBRARIES = libcore.la\nlibcore_la_SOURCES = ${srcdir}/core.c @top_srcdir@/include/core.h\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "shared/util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "include/core.h", "int core(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "Autotools binary app");
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "shared/util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([
      { path: "src/core.c", reason: "target source" },
      { path: "include/core.h", reason: "target source" },
    ]);
  });

  it("honors Automake assignment overrides", async () => {
    const root = await fixtureRoot("clawpatch-autotools-override-");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = old cleared\nbin_PROGRAMS = new\nold_SOURCES = old.c\nnew_SOURCES = stale.c\nnew_SOURCES = new.c\ncleared_SOURCES = cleared.c\ncleared_SOURCES =\n",
    );
    await writeFixture(root, "old.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "new.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "stale.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cleared.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const target = result.features.find((feature) => feature.title === "Autotools binary new");

    expect(titles).toContain("Autotools binary new");
    expect(titles).not.toContain("Autotools binary old");
    expect(titles).not.toContain("Autotools binary cleared");
    expect(target?.ownedFiles).toEqual([{ path: "new.c", reason: "target source" }]);
  });

  it("keeps same-named CMake and Autotools targets", async () => {
    const root = await fixtureRoot("clawpatch-cmake-autotools-same-target-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app main.c cmake_only.c)\n");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = app\napp_SOURCES = main.c auto_only.c\n",
    );
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cmake_only.c", "int cmake_only(void) { return 0; }\n");
    await writeFixture(root, "auto_only.c", "int auto_only(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cmake = result.features.find((feature) => feature.title === "CMake binary app");
    const autotools = result.features.find((feature) => feature.title === "Autotools binary app");

    expect(cmake?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "cmake_only.c", reason: "target source" },
    ]);
    expect(autotools?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "auto_only.c", reason: "target source" },
    ]);
  });

  it("maps standalone C main files without php-src extension semantics", async () => {
    const root = await fixtureRoot("clawpatch-c-main-map-");
    await writeFixture(root, "src/tool.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "ext/iconv/config.m4",
      "PHP_NEW_EXTENSION(iconv, iconv.c, $ext_shared)\n",
    );
    await writeFixture(root, "ext/iconv/iconv.c", "int iconv_helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const tool = result.features.find((feature) => feature.title === "C binary tool");

    expect(project.detected.languages).toContain("c");
    expect(tool?.entrypoints[0]).toMatchObject({
      path: "src/tool.c",
      symbol: "main",
      command: "tool",
    });
    expect(result.features.some((feature) => feature.source === "php-ext")).toBe(false);
    expect(
      result.features.some((feature) => feature.entrypoints[0]?.path === "ext/iconv/config.m4"),
    ).toBe(false);
  });

  it("skips C and C++ sample project paths", async () => {
    const root = await fixtureRoot("clawpatch-cpp-sample-paths-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(sample fixtures/example/main.c)\n");
    await writeFixture(root, "fixtures/example/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "testdata/CMakeLists.txt", "add_executable(sample main.c)\n");
    await writeFixture(root, "testdata/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some((feature) =>
        ["c-main", "cmake-bin", "cmake-lib", "autotools-bin", "autotools-lib"].includes(
          feature.source,
        ),
      ),
    ).toBe(false);
    expect(
      result.features.some((feature) => feature.entrypoints[0]?.path.includes("fixtures/")),
    ).toBe(false);
  });

  it("does not attach JavaScript tests to C and C++ entries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-js-test-");
    await writeFixture(root, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/app.test.ts", "test('app', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C++ binary app");

    expect(app?.tests).toEqual([]);
    expect(app?.contextFiles).toEqual([]);
  });

  it("attaches plural-suffixed C and C++ tests without mapping them as binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-plural-tests-");
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/app_tests.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/FooTests.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/Contest.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/latest.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C++ binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(app?.tests).toEqual([{ path: "src/app_tests.cpp", command: null }]);
    expect(titles).not.toContain("C++ binary app_tests");
    expect(titles).not.toContain("C++ binary FooTests");
    expect(titles).toContain("C++ binary Contest");
    expect(titles).toContain("C++ binary latest");
  });

  it("attaches capitalized C and C++ test directories without mapping them as binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-capitalized-tests-");
    await writeFixture(root, "src/parser.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "Tests/parser.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const parser = result.features.find((feature) => feature.title === "C++ binary parser");
    const titles = result.features.map((feature) => feature.title);

    expect(parser?.tests).toEqual([{ path: "Tests/parser.cpp", command: null }]);
    expect(titles.filter((title) => title === "C++ binary parser")).toHaveLength(1);
  });

  it("detects C and C++ main functions after literals containing braces", async () => {
    const root = await fixtureRoot("clawpatch-cpp-literal-braces-");
    await writeFixture(
      root,
      "src/app.cpp",
      'const char *json = "{\\"ok\\": true}";\nconst char *raw = R"tag({raw})tag";\nint main(void) { return 0; }\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("detects C and C++ main functions after literals containing comment markers", async () => {
    const root = await fixtureRoot("clawpatch-cpp-literal-comments-");
    await writeFixture(
      root,
      "src/app.cpp",
      'const char *url = R"json({"url":"http://example.com"})json";\nconst char *open = "/*";\nint main(void) { return 0; }\nconst char *close = "*/";\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("ignores C and C++ block markers inside line comments", async () => {
    const root = await fixtureRoot("clawpatch-cpp-line-comment-block-marker-");
    await writeFixture(
      root,
      "src/app.cpp",
      "// /* disabled guard\nint main(void) { return 0; }\n// */\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("detects C and C++ main functions after comments containing quotes", async () => {
    const root = await fixtureRoot("clawpatch-cpp-comment-quotes-");
    await writeFixture(
      root,
      "src/app.cpp",
      '// TODO parse "flag\n/* disabled "quoted" branch */\nint main(void) { return 0; }\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("ignores comment-only C and C++ sources", async () => {
    const root = await fixtureRoot("clawpatch-cpp-comment-only-");
    await writeFixture(root, "src/placeholder.cpp", `// ${"x".repeat(200)}\n`);

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary placeholder");
  });

  it("does not attach dependency C and C++ tests from skipped paths", async () => {
    const root = await fixtureRoot("clawpatch-cpp-skipped-nearby-tests-");
    await writeFixture(root, "app.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "vendor/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "CMakeFiles/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cmake-build-debug/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "fixtures/app_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C binary app");

    expect(app?.tests).toEqual([]);
    expect(app?.contextFiles).toEqual([]);
  });

  it("skips dependency trees during C and C++ discovery", async () => {
    const root = await fixtureRoot("clawpatch-cpp-dependency-paths-");
    await writeFixture(root, "src/app.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "vendor/tool/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, ".venv/native/main.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "CMakeFiles/CompilerIdCXX/CMakeCXXCompilerId.cpp",
      "int main(void) { return 0; }\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/generated/tool.cpp",
      "int main(void) { return 0; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(paths).toContain("src/app.c");
    expect(paths.some((path) => path.startsWith("vendor/"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".venv/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("CMakeFiles/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("cmake-build-debug/"))).toBe(false);
  });

  it("ignores dependency and generated C and C++ files during detection", async () => {
    const root = await fixtureRoot("clawpatch-cpp-dependency-detect-");
    await writeFixture(root, "vendor/CMakeLists.txt", "add_executable(vendor main.c)\n");
    await writeFixture(root, "vendor/main.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "CMakeFiles/CompilerIdCXX/CMakeCXXCompilerId.cpp",
      "int main(void) { return 0; }\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/_deps/foo-src/CMakeLists.txt",
      "add_executable(foo main.cpp)\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/_deps/foo-src/main.cpp",
      "int main(void) { return 0; }\n",
    );

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("c");
    expect(project.detected.languages).not.toContain("cpp");
    expect(project.detected.packageManagers).not.toContain("cmake");
  });

  it("detects non-C and C++ languages under vendor path components", async () => {
    const root = await fixtureRoot("clawpatch-vendor-language-detect-");
    await writeFixture(root, "src/vendor/worker.py", "def main():\n    pass\n");
    await writeFixture(root, "src/pkg/vendor/app.py", "def main():\n    pass\n");
    await writeFixture(root, "src/main/vendor/App.java", "class App {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toEqual(expect.arrayContaining(["python", "java"]));
  });

  it("ignores top-level vendored native project metadata during detection", async () => {
    const root = await fixtureRoot("clawpatch-top-vendor-native-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(
      root,
      "vendor/Dependency/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Dependency")\n',
    );
    await writeFixture(root, "vendor/Dependency/build.gradle.kts", 'plugins { id("java") }\n');

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
    expect(project.detected.packageManagers).not.toContain("gradle");
  });
});
