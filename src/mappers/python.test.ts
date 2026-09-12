import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;

describe("mapFeatures", () => {
  it("maps Python project metadata, console scripts, source groups, and tests", async () => {
    const root = await fixtureRoot("clawpatch-python-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project] # package metadata\nname = "py-tool"\ndependencies = ["pytest; python_version >= \'3.12\'", "ruff"]\n# "mypy"\n\n[project.scripts] # console scripts\npytool = "py_tool.cli:main"\n',
    );
    await writeFixture(root, "uv.lock", "");
    await writeFixture(root, "src/py_tool/__init__.py", "");
    await writeFixture(root, "src/py_tool/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "src/py_tool/store.py", "def get():\n    pass\n");
    await writeFixture(root, "src/py_tool/store_test.py", "def test_get():\n    pass\n");
    await writeFixture(root, "src/py_tool/generated_pb2.py", "generated = True\n");
    await writeFixture(root, ".venv/lib/site-packages/dep.py", "ignored = True\n");
    await writeFixture(root, "tests/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command pytool");
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.languages).toContain("python");
    expect(project.detected.packageManagers).toContain("uv");
    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(project.detected.commands.lint).toBe("uv run ruff check .");
    expect(project.detected.commands.format).toBe("uv run ruff format --check .");
    expect(titles).toContain("Python project py-tool");
    expect(titles).toContain("Python CLI command pytool");
    expect(titles).toContain("Python test suite tests");
    expect(cli?.entrypoints[0]?.path).toBe("src/py_tool/cli.py");
    expect(cli?.entrypoints[0]?.symbol).toBe("main");
    expect(cli?.tests).toEqual([
      { path: "src/py_tool/store_test.py", command: "uv run pytest" },
      { path: "tests/test_cli.py", command: "uv run pytest" },
    ]);
    expect(source?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/py_tool/__init__.py",
      "src/py_tool/cli.py",
      "src/py_tool/store.py",
    ]);
    expect(source?.ownedFiles.map((file) => file.path)).not.toContain(
      "src/py_tool/generated_pb2.py",
    );
  });

  it("maps uv workspace Python members with repo-relative paths", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-");
    await writeFixture(
      root,
      "pyproject.toml",
      `[project]
name = "workspace-root"
dependencies = ["pytest"]

[tool.uv.workspace]
members = ["packages/*", "../outside/*", "tools/*"]
exclude = ["packages/legacy"]
`,
    );
    await writeFixture(root, "uv.lock", "");
    await writeFixture(root, "src/workspace_root/__init__.py", "");
    await writeFixture(
      root,
      "packages/backend/pyproject.toml",
      '[project]\nname = "backend"\ndependencies = ["fastapi"]\n',
    );
    await writeFixture(
      root,
      "packages/backend/src/backend/app.py",
      "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/health')\ndef health():\n    return {'ok': True}\n",
    );
    await writeFixture(root, "packages/backend/tests/test_app.py", "def test_app():\n    pass\n");
    await writeFixture(
      root,
      "packages/quoted; pkg/pyproject.toml",
      '[project]\nname = "quoted-pkg"\n',
    );
    await writeFixture(
      root,
      "packages/quoted; pkg/tests/test_quoted.py",
      "def test_quoted():\n    pass\n",
    );
    await writeFixture(
      root,
      "packages/ibkr-bridge-client/pyproject.toml",
      '[project]\nname = "ibkr-bridge-client"\n',
    );
    await writeFixture(
      root,
      "packages/ibkr-bridge-client/src/ibkr_bridge_client/client.py",
      "def connect():\n    pass\n",
    );
    await writeFixture(
      root,
      "packages/ibkr-bridge-client/tests/test_client.py",
      "def test_client():\n    pass\n",
    );
    await writeFixture(
      root,
      "packages/ibkr-instruments/pyproject.toml",
      '[project]\nname = "ibkr-instruments"\n',
    );
    await writeFixture(
      root,
      "packages/ibkr-instruments/src/ibkr_instruments/store.py",
      "def save():\n    pass\n",
    );
    await writeFixture(
      root,
      "packages/ibkr-instruments/tests/test_store.py",
      "def test_store():\n    pass\n",
    );
    await writeFixture(root, "packages/legacy/pyproject.toml", '[project]\nname = "legacy"\n');
    await writeFixture(root, "packages/legacy/src/legacy/app.py", "def legacy():\n    pass\n");
    await writeFixture(root, "tools/no-manifest/src/tool.py", "def tool():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const backendSource = result.features.find(
      (feature) => feature.title === "Python source packages/backend/src",
    );
    const backendTests = result.features.find(
      (feature) => feature.title === "Python test suite packages/backend/tests",
    );
    const quotedTests = result.features.find(
      (feature) => feature.title === "Python test suite packages/quoted; pkg/tests",
    );
    const fastApiRoute = result.features.find(
      (feature) => feature.title === "FastAPI route GET /health",
    );

    expect(titles).toContain("Python project backend");
    expect(titles).toContain("Python project ibkr-bridge-client");
    expect(titles).toContain("Python project ibkr-instruments");
    expect(titles).not.toContain("Python project legacy");
    expect(backendSource?.entrypoints[0]?.path).toBe("packages/backend/src");
    expect(backendSource?.ownedFiles).toEqual([
      { path: "packages/backend/src/backend/app.py", reason: "source group src" },
    ]);
    expect(backendSource?.tags).toEqual(
      expect.arrayContaining(["python", "source-group", "workspace", "uv-workspace"]),
    );
    expect(backendTests?.tests).toEqual([
      {
        path: "packages/backend/tests/test_app.py",
        command: "uv run --directory packages/backend pytest",
      },
    ]);
    expect(quotedTests?.tests).toEqual([
      {
        path: "packages/quoted; pkg/tests/test_quoted.py",
        command: 'uv run --directory "packages/quoted; pkg" pytest',
      },
    ]);
    expect(fastApiRoute?.entrypoints[0]?.path).toBe("packages/backend/src/backend/app.py");
    expect(fastApiRoute?.summary).toBe(
      "FastAPI route GET /health handled by health in packages/backend/src/backend/app.py.",
    );
    expect(
      result.features.find((feature) => feature.title === "Python project backend")?.summary,
    ).toBe("Python project metadata in packages/backend/pyproject.toml.");
    expect(fastApiRoute?.tests).toEqual([
      {
        path: "packages/backend/tests/test_app.py",
        command: "uv run --directory packages/backend pytest",
      },
    ]);
    expect(
      result.features.some((feature) =>
        feature.ownedFiles.some((file) => file.path.startsWith("tools/no-manifest")),
      ),
    ).toBe(false);
  });

  it("adds workspace root runtime metadata to uv workspace member features", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-runtime-context-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["packages/backend"]\n',
    );
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(root, "packages/backend/pyproject.toml", '[project]\nname = "backend"\n');
    await writeFixture(root, "packages/backend/src/backend/app.py", "def run():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const backendSource = result.features.find(
      (feature) => feature.title === "Python source packages/backend/src",
    );

    expect(backendSource?.contextFiles).toEqual(
      expect.arrayContaining([
        { path: "packages/backend/pyproject.toml", reason: "python target runtime metadata" },
        { path: "pyproject.toml", reason: "python target runtime metadata" },
        { path: ".python-version", reason: "python target runtime metadata" },
      ]),
    );
  });

  it("does not duplicate uv workspace members from root-level Python mapping", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-root-dedupe-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
    );
    await writeFixture(root, "packages/__init__.py", "");
    await writeFixture(root, "packages/backend/pyproject.toml", '[project]\nname = "backend"\n');
    await writeFixture(root, "packages/backend/src/backend/app.py", "def run():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const backendSources = result.features.filter((feature) =>
      feature.ownedFiles.some((file) => file.path.endsWith("packages/backend/src/backend/app.py")),
    );

    expect(backendSources).toHaveLength(1);
    expect(backendSources[0]?.entrypoints[0]?.path).toBe("packages/backend/src");
    expect(
      result.features.some(
        (feature) =>
          feature.title === "Python source src" ||
          feature.ownedFiles.some((file) => file.path === "backend/src/backend/app.py"),
      ),
    ).toBe(false);
  });

  it("preserves root routes that only touch uv members through associated tests", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-root-route-tests-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\ndependencies = ["fastapi"]\n\n[tool.uv.workspace]\nmembers = ["packages/backend"]\n',
    );
    await writeFixture(root, "packages/__init__.py", "");
    await writeFixture(
      root,
      "packages/shared.py",
      "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/shared')\ndef shared():\n    return {'ok': True}\n",
    );
    await writeFixture(root, "packages/backend/pyproject.toml", '[project]\nname = "backend"\n');
    await writeFixture(
      root,
      "packages/backend/tests/test_member.py",
      "def test_member():\n    pass\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "FastAPI route GET /shared");

    expect(route?.ownedFiles).toEqual([
      { path: "packages/shared.py", reason: "FastAPI route handler shared" },
    ]);
    expect(route?.tests).toEqual([]);
    expect(route?.contextFiles).not.toContainEqual({
      path: "packages/backend/tests/test_member.py",
      reason: "associated test",
    });
  });

  it("preserves non-member files from mixed uv workspace root source groups", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-root-mixed-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
    );
    await writeFixture(root, "packages/__init__.py", "");
    await writeFixture(root, "packages/shared.py", "def shared():\n    pass\n");
    await writeFixture(root, "packages/backend/pyproject.toml", '[project]\nname = "backend"\n');
    await writeFixture(root, "packages/backend/src/backend/app.py", "def run():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const packageSource = result.features.find(
      (feature) => feature.title === "Python source packages",
    );
    const backendSources = result.features.filter((feature) =>
      feature.ownedFiles.some((file) => file.path.endsWith("packages/backend/src/backend/app.py")),
    );

    expect(packageSource?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "packages/__init__.py",
      "packages/shared.py",
    ]);
    expect(packageSource?.summary).toBe("Python source group packages with 2 files.");
    expect(backendSources).toHaveLength(1);
    expect(backendSources[0]?.entrypoints[0]?.path).toBe("packages/backend/src");
  });

  it("preserves non-member tests from mixed uv workspace root test suites", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-root-mixed-tests-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["tests/member"]\n',
    );
    await writeFixture(root, "tests/test_root.py", "def test_root():\n    pass\n");
    await writeFixture(root, "tests/member/pyproject.toml", '[project]\nname = "member"\n');
    await writeFixture(root, "tests/member/tests/test_member.py", "def test_member():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rootTests = result.features.find(
      (feature) => feature.title === "Python test suite tests",
    );
    const memberTests = result.features.find(
      (feature) => feature.title === "Python test suite tests/member/tests",
    );

    expect(rootTests?.ownedFiles).toEqual([{ path: "tests/test_root.py", reason: "pytest file" }]);
    expect(rootTests?.tests).toEqual([{ path: "tests/test_root.py", command: "uv run pytest" }]);
    expect(memberTests?.tests).toEqual([
      {
        path: "tests/member/tests/test_member.py",
        command: "uv run --directory tests/member pytest",
      },
    ]);
  });

  it("retargets pruned root test suites when a uv member owns the synthetic suite path", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-root-test-member-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["tests"]\n',
    );
    await writeFixture(root, "test_root.py", "def test_root():\n    pass\n");
    await writeFixture(root, "tests/pyproject.toml", '[project]\nname = "member"\n');
    await writeFixture(root, "tests/test_member.py", "def test_member():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rootTests = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "test_root.py"),
    );

    expect(rootTests?.title).toBe("Python test suite root");
    expect(rootTests?.entrypoints[0]?.path).toBe(".");
    expect(rootTests?.ownedFiles).toEqual([{ path: "test_root.py", reason: "pytest file" }]);
  });

  symlinkIt("does not discover uv workspace members through symlinked package roots", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-workspace-symlink-");
    const outside = await fixtureRoot("clawpatch-python-uv-workspace-outside-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace-root"\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
    );
    await writeFixture(root, "uv.lock", "");
    await writeFixture(outside, "external/pyproject.toml", '[project]\nname = "external"\n');
    await writeFixture(outside, "external/src/external/app.py", "def app():\n    pass\n");
    await mkdir(join(root, "packages"), { recursive: true });
    await symlink(join(outside, "external"), join(root, "packages", "external"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain(
      "Python project external",
    );
  });

  it("resolves Python console scripts and tests from non-src package roots", async () => {
    const root = await fixtureRoot("clawpatch-python-roots-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "rooted"\ndependencies = ["pytest"]\n\n[project.scripts]\nrooted = "rooted.cli:main"\nlibbed = "libbed.cli:main"\n',
    );
    await writeFixture(root, "rooted/__init__.py", "");
    await writeFixture(root, "rooted/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "rooted/test_cli.py", "def test_cli():\n    pass\n");
    await writeFixture(root, "lib/libbed/__init__.py", "");
    await writeFixture(root, "lib/libbed/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "lib/libbed/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rooted = result.features.find((feature) => feature.title === "Python CLI command rooted");
    const libbed = result.features.find((feature) => feature.title === "Python CLI command libbed");

    expect(rooted?.entrypoints[0]?.path).toBe("rooted/cli.py");
    expect(rooted?.tests).toEqual([{ path: "rooted/test_cli.py", command: "pytest" }]);
    expect(libbed?.entrypoints[0]?.path).toBe("lib/libbed/cli.py");
    expect(libbed?.tests).toEqual([{ path: "lib/libbed/test_cli.py", command: "pytest" }]);
  });

  it("associates root-level pytest files with flat Python console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-flat-tests-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "flat"\ndependencies = ["pytest"]\n\n[project.scripts]\nflat = "cli:main"\n',
    );
    await writeFixture(root, "cli.py", "def main():\n    pass\n");
    await writeFixture(root, "test_cli.py", "def test_main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "Python CLI command flat");

    expect(cli?.entrypoints[0]?.path).toBe("cli.py");
    expect(cli?.tests).toEqual([{ path: "test_cli.py", command: "pytest" }]);
  });

  symlinkIt("does not resolve Python console scripts through symlinked package dirs", async () => {
    const root = await fixtureRoot("clawpatch-python-script-symlink-root-");
    const external = await fixtureRoot("clawpatch-python-script-symlink-external-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "linked-script"\n\n[project.scripts]\nlinked = "pkg.cli:main"\n',
    );
    await writeFixture(external, "pkg/cli.py", "def main():\n    pass\n");
    await symlink(join(external, "pkg"), join(root, "pkg"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "Python CLI command linked");

    expect(cli?.entrypoints[0]?.path).toBe("pyproject.toml");
    expect(cli?.ownedFiles).toEqual([
      { path: "pyproject.toml", reason: "console script metadata" },
    ]);
  });

  it("detects Python projects and conservative command defaults", async () => {
    const uvRoot = await fixtureRoot("clawpatch-python-uv-");
    await writeFixture(
      uvRoot,
      "pyproject.toml",
      '[project]\nname = "uv-app"\ndependencies = ["pytest", "pyright"]\n',
    );
    await writeFixture(uvRoot, "uv.lock", "");
    expect((await detectProject(uvRoot)).detected.commands).toMatchObject({
      typecheck: "uv run pyright",
      test: "uv run pytest",
    });

    const uvDevRoot = await fixtureRoot("clawpatch-python-uv-dev-");
    await writeFixture(
      uvDevRoot,
      "pyproject.toml",
      '[project]\nname = "uv-dev"\n\n[tool.uv]\ndev-dependencies = ["pytest", "ruff", "pyright"]\n',
    );
    await writeFixture(uvDevRoot, "uv.lock", "");
    expect((await detectProject(uvDevRoot)).detected.commands).toMatchObject({
      typecheck: "uv run pyright",
      lint: "uv run ruff check .",
      test: "uv run pytest",
    });

    const uvArrayRoot = await fixtureRoot("clawpatch-python-uv-array-table-");
    await writeFixture(
      uvArrayRoot,
      "pyproject.toml",
      '[project]\nname = "uv-array"\ndependencies = ["pytest"]\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    expect((await detectProject(uvArrayRoot)).detected).toMatchObject({
      packageManagers: ["uv"],
      commands: {
        test: "uv run pytest",
      },
    });

    const blackRoot = await fixtureRoot("clawpatch-python-black-");
    await writeFixture(blackRoot, "requirements.txt", "black\n");
    expect((await detectProject(blackRoot)).detected.commands.format).toBe("black --check .");

    const uvBlackRoot = await fixtureRoot("clawpatch-python-uv-black-");
    await writeFixture(
      uvBlackRoot,
      "pyproject.toml",
      '[project]\nname = "uv-black"\ndependencies = ["black"]\n',
    );
    await writeFixture(uvBlackRoot, "uv.lock", "");
    expect((await detectProject(uvBlackRoot)).detected.commands.format).toBe(
      "uv run black --check .",
    );

    const poetryRoot = await fixtureRoot("clawpatch-python-poetry-");
    await writeFixture(
      poetryRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-app"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nmypy = "^1"\n\n[tool.poetry.group.test.dependencies]\npytest = "^8"\n\n[tool.poetry.group.lint.dependencies]\nruff = "^0.5"\n',
    );
    await writeFixture(poetryRoot, "poetry.lock", "");
    expect((await detectProject(poetryRoot)).detected.commands).toMatchObject({
      typecheck: "poetry run mypy .",
      lint: "poetry run ruff check .",
      test: "poetry run pytest",
    });

    const poetryPyprojectRoot = await fixtureRoot("clawpatch-python-poetry-pyproject-");
    await writeFixture(
      poetryPyprojectRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-pyproject"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\nruff = "^0.5"\n',
    );
    expect((await detectProject(poetryPyprojectRoot)).detected).toMatchObject({
      packageManagers: ["poetry"],
      commands: {
        lint: "poetry run ruff check .",
        test: "poetry run pytest",
      },
    });

    const hatchRoot = await fixtureRoot("clawpatch-python-hatch-");
    await writeFixture(
      hatchRoot,
      "pyproject.toml",
      '[project]\nname = "hatch-app"\ndependencies = ["pytest", "ruff"]\n',
    );
    await writeFixture(hatchRoot, "hatch.toml", "");
    expect((await detectProject(hatchRoot)).detected.commands).toMatchObject({
      lint: "hatch run ruff check .",
      test: "hatch run pytest",
    });

    const hatchPyprojectRoot = await fixtureRoot("clawpatch-python-hatch-pyproject-");
    await writeFixture(
      hatchPyprojectRoot,
      "pyproject.toml",
      '[project]\nname = "hatch-pyproject"\n\n[tool.hatch.envs.default]\ndependencies = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(hatchPyprojectRoot)).detected).toMatchObject({
      packageManagers: ["hatch"],
      commands: {
        lint: "hatch run ruff check .",
        test: "hatch run pytest",
      },
    });

    const setupCfgRoot = await fixtureRoot("clawpatch-python-setup-cfg-tools-");
    await writeFixture(
      setupCfgRoot,
      "setup.cfg",
      "[mypy]\nstrict = True\n\n[ruff]\nline-length = 100\n",
    );
    expect((await detectProject(setupCfgRoot)).detected.commands).toMatchObject({
      typecheck: "mypy .",
      lint: "ruff check .",
      format: "ruff format --check .",
    });

    const setupCfgExtrasNameRoot = await fixtureRoot("clawpatch-python-setup-cfg-extras-name-");
    await writeFixture(
      setupCfgExtrasNameRoot,
      "setup.cfg",
      "[metadata]\nname = extras-name\n\n[options.extras_require]\npytest =\n    httpx\nruff =\n    typing-extensions\n",
    );
    expect((await detectProject(setupCfgExtrasNameRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const setupCfgCommentRoot = await fixtureRoot("clawpatch-python-setup-cfg-pytest-comment-");
    await writeFixture(
      setupCfgCommentRoot,
      "setup.cfg",
      "[metadata]\nname = comment-only\n# [pytest]\ndescription = mentions [pytest]\n",
    );
    expect((await detectProject(setupCfgCommentRoot)).detected.commands.test).toBeNull();

    const setupCfgExtrasValueRoot = await fixtureRoot("clawpatch-python-setup-cfg-extras-value-");
    await writeFixture(
      setupCfgExtrasValueRoot,
      "setup.cfg",
      "[metadata]\nname = extras-value\n\n[options.extras_require]\ndev =\n    pytest\n    ruff\n",
    );
    expect((await detectProject(setupCfgExtrasValueRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      test: "pytest",
    });

    const markerRoot = await fixtureRoot("clawpatch-python-marker-deps-");
    await writeFixture(
      markerRoot,
      "pyproject.toml",
      '[project]\nname = "markers"\ndependencies = ["ruff; python_version < \'3.13\'", "pytest"]\n# "mypy"\n',
    );
    expect((await detectProject(markerRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      test: "pytest",
    });

    const pdmRoot = await fixtureRoot("clawpatch-python-pdm-");
    await writeFixture(pdmRoot, "requirements.txt", "pytest\nruff\n");
    await writeFixture(pdmRoot, "pdm.lock", "");
    expect((await detectProject(pdmRoot)).detected.commands).toMatchObject({
      typecheck: "pdm run ruff check .",
      lint: "pdm run ruff check .",
      test: "pdm run pytest",
    });

    const pdmPyprojectRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-");
    await writeFixture(
      pdmPyprojectRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest", "ruff", "pyright"]\n',
    );
    await writeFixture(pdmPyprojectRoot, "pdm.lock", "");
    expect((await detectProject(pdmPyprojectRoot)).detected.commands).toMatchObject({
      typecheck: "pdm run pyright",
      lint: "pdm run ruff check .",
      test: "pdm run pytest",
    });

    const pdmPyprojectNoLockRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-no-lock-");
    await writeFixture(
      pdmPyprojectNoLockRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(pdmPyprojectNoLockRoot)).detected).toMatchObject({
      packageManagers: ["pdm"],
      commands: {
        lint: "pdm run ruff check .",
        test: "pdm run pytest",
      },
    });

    const directRoot = await fixtureRoot("clawpatch-python-direct-");
    await writeFixture(directRoot, "setup.py", "from setuptools import setup\n");
    await writeFixture(directRoot, "tests/test_app.py", "def test_app():\n    pass\n");
    expect((await detectProject(directRoot)).detected.commands.test).toBe("pytest");

    const nullRoot = await fixtureRoot("clawpatch-python-null-");
    await writeFixture(nullRoot, "src/app/main.py", "def main():\n    pass\n");
    const nullProject = await detectProject(nullRoot);
    expect(nullProject.detected.languages).toContain("python");
    expect(nullProject.detected.packageManagers).toContain("python");
    expect(nullProject.detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const groupNameRoot = await fixtureRoot("clawpatch-python-group-names-");
    await writeFixture(
      groupNameRoot,
      "pyproject.toml",
      '[project]\nname = "groups"\n\n[project.optional-dependencies]\npytest = ["httpx"]\nruff = ["typing-extensions"]\n',
    );
    expect((await detectProject(groupNameRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const commentedGroupRoot = await fixtureRoot("clawpatch-python-commented-groups-");
    await writeFixture(
      commentedGroupRoot,
      "pyproject.toml",
      '[project]\nname = "commented-groups"\n\n[dependency-groups]\n#dev = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(commentedGroupRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const dependencyGroupRoot = await fixtureRoot("clawpatch-python-dependency-groups-");
    await writeFixture(
      dependencyGroupRoot,
      "pyproject.toml",
      '[project]\nname = "dependency-groups"\n\n[dependency-groups]\ndev = [\n  "pytest",\n  "ruff",\n]\n',
    );
    expect((await detectProject(dependencyGroupRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      format: "ruff format --check .",
      test: "pytest",
    });
  });

  it("maps root-level Python pytest files", async () => {
    const root = await fixtureRoot("clawpatch-python-root-tests-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "root-tests"\n');
    await writeFixture(root, "test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suite = result.features.find((feature) => feature.title === "Python test suite tests");

    expect(project.detected.commands.test).toBe("pytest");
    expect(suite?.ownedFiles).toEqual([{ path: "test_app.py", reason: "pytest file" }]);
    expect(suite?.contextFiles).toEqual([
      { path: "pyproject.toml", reason: "python target runtime metadata" },
      { path: "test_app.py", reason: "nearby test" },
    ]);
    expect(suite?.contextFiles).not.toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
    expect(suite?.contextFiles).not.toContainEqual({
      path: "runtime.txt",
      reason: "python target runtime metadata",
    });
    expect(suite?.tests).toEqual([{ path: "test_app.py", command: "pytest" }]);
  });

  it("threads Python runtime metadata into standalone pytest suites", async () => {
    const root = await fixtureRoot("clawpatch-python-test-runtime-context-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "runtime-tests"\n');
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(root, "runtime.txt", "python-3.14\n");
    await writeFixture(
      root,
      "tests/test_pep758.py",
      [
        "def test_pep758_exception_group():",
        "    try:",
        "        int('x')",
        "    except TypeError, ValueError:",
        "        assert True",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suite = result.features.find((feature) => feature.title === "Python test suite tests");

    expect(suite?.contextFiles).toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
    expect(suite?.contextFiles).toContainEqual({
      path: "runtime.txt",
      reason: "python target runtime metadata",
    });
    expect(suite?.ownedFiles).toEqual([{ path: "tests/test_pep758.py", reason: "pytest file" }]);
    expect(suite?.tests).toEqual([{ path: "tests/test_pep758.py", command: "pytest" }]);
  });

  it("uses nearest Python runtime metadata for nested source packages", async () => {
    const root = await fixtureRoot("clawpatch-python-nested-runtime-context-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "workspace"\nrequires-python = ">=3.14"\n',
    );
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(root, "apps/api/.python-version", "3.13\n");
    await writeFixture(root, "apps/api/service.py", "def service():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "apps/api/service.py"),
    );

    expect(source?.contextFiles).toContainEqual({
      path: "apps/api/.python-version",
      reason: "python target runtime metadata",
    });
    expect(source?.contextFiles).not.toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
    expect(source?.contextFiles).not.toContainEqual({
      path: "pyproject.toml",
      reason: "python target runtime metadata",
    });
  });

  it("inherits Python runtime metadata past nested package files without version constraints", async () => {
    const root = await fixtureRoot("clawpatch-python-inherited-runtime-context-");
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(root, "apps/api/pyproject.toml", '[project]\nname = "api"\n');
    await writeFixture(root, "apps/api/service.py", "def service():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "apps/api/service.py"),
    );

    expect(source?.contextFiles).toContainEqual({
      path: "apps/api/pyproject.toml",
      reason: "python target runtime metadata",
    });
    expect(source?.contextFiles).toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
  });

  it("uses nested Poetry Python constraints instead of ancestor runtime metadata", async () => {
    const root = await fixtureRoot("clawpatch-python-poetry-runtime-context-");
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(
      root,
      "apps/api/pyproject.toml",
      '[tool.poetry]\nname = "api"\n\n[tool.poetry.dependencies]\npython = "^3.13"\n',
    );
    await writeFixture(root, "apps/api/service.py", "def service():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "apps/api/service.py"),
    );

    expect(source?.contextFiles).toContainEqual({
      path: "apps/api/pyproject.toml",
      reason: "python target runtime metadata",
    });
    expect(source?.contextFiles).not.toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
  });

  it("does not treat non-Python tool versions as a Python runtime constraint", async () => {
    const root = await fixtureRoot("clawpatch-python-tool-versions-context-");
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(root, "apps/api/.tool-versions", "nodejs 22.0.0\n");
    await writeFixture(root, "apps/api/service.py", "def service():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "apps/api/service.py"),
    );

    expect(source?.contextFiles).toContainEqual({
      path: "apps/api/.tool-versions",
      reason: "python target runtime metadata",
    });
    expect(source?.contextFiles).toContainEqual({
      path: ".python-version",
      reason: "python target runtime metadata",
    });
  });

  it("maps Flask routes under web source roots", async () => {
    const root = await fixtureRoot("clawpatch-python-flask-routes-");
    await writeFixture(root, "requirements.txt", "Flask\npytest\n");
    await writeFixture(
      root,
      "web/app.py",
      [
        "from flask import Flask",
        "",
        "app = Flask(__name__)",
        "",
        "@app.route('/')",
        "def index():",
        "    return 'ok'",
        "",
        "@app.route('/api/items', methods=['GET', 'POST'])",
        "def items():",
        "    return 'items'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "web/blueprints/admin.py",
      [
        "from flask import Blueprint",
        "",
        "admin_bp = Blueprint('admin', __name__)",
        "",
        "@admin_bp.route(",
        "    '/admin/run-once',",
        "    methods=['POST'],",
        ")",
        "def run_once():",
        "    return 'queued'",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "web/test_app.py", "def test_index():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const index = result.features.find((feature) => feature.title === "Flask route GET /");
    const items = result.features.find(
      (feature) => feature.title === "Flask route GET,POST /api/items",
    );
    const admin = result.features.find(
      (feature) => feature.title === "Flask route POST /admin/run-once",
    );

    expect(project.detected.frameworks).toContain("flask");
    expect(titles).toContain("Python source web");
    expect(index?.source).toBe("python-flask-route");
    expect(index?.entrypoints[0]).toMatchObject({
      path: "web/app.py",
      symbol: "index",
      route: "GET /",
    });
    expect(index?.tests).toEqual([{ path: "web/test_app.py", command: "pytest" }]);
    expect(items?.entrypoints[0]?.route).toBe("GET,POST /api/items");
    expect(admin?.trustBoundaries).toContain("auth");
  });

  it("maps static Flask blueprint url prefixes", async () => {
    const root = await fixtureRoot("clawpatch-python-flask-blueprint-prefixes-");
    await writeFixture(root, "requirements.txt", "Flask\npytest\n");
    await writeFixture(
      root,
      "web/app.py",
      [
        "from flask import Blueprint, Flask",
        "",
        "app = Flask(__name__)",
        "API_PREFIX = '/dynamic'",
        "api_bp = Blueprint('api', __name__, url_prefix='/api')",
        "registered_bp = Blueprint('registered', __name__)",
        "dynamic_bp = Blueprint('dynamic', __name__, url_prefix=API_PREFIX)",
        "runtime_bp = Blueprint('runtime', __name__)",
        "overridden_bp = Blueprint('overridden', __name__, url_prefix='/constructor')",
        "none_bp = Blueprint('none', __name__, url_prefix='/kept')",
        "none_comment_bp = Blueprint('none_comment', __name__, url_prefix='/kept-comment')",
        "constructor_comment_bp = Blueprint(",
        "    'constructor_comment',",
        "    __name__,",
        "    url_prefix='/constructor-comment'  # use constructor literal",
        ")",
        "literal_comment_bp = Blueprint('literal_comment', __name__, url_prefix='/constructor')",
        "app.register_blueprint(registered_bp, url_prefix='/registered')",
        "app.register_blueprint(runtime_bp, url_prefix=API_PREFIX)",
        "app.register_blueprint(overridden_bp, url_prefix=API_PREFIX)",
        "app.register_blueprint(none_bp, url_prefix=None)",
        "app.register_blueprint(",
        "    none_comment_bp,",
        "    url_prefix=None  # use constructor default",
        ")",
        "app.register_blueprint(",
        "    literal_comment_bp,",
        "    url_prefix='/literal'  # use literal override",
        ")",
        "",
        "@api_bp.route('/users')",
        "def users():",
        "    return 'users'",
        "",
        "@registered_bp.route('/reports', methods=['POST'])",
        "def reports():",
        "    return 'reports'",
        "",
        "@dynamic_bp.route('/metrics')",
        "def metrics():",
        "    return 'metrics'",
        "",
        "@runtime_bp.route('/events')",
        "def events():",
        "    return 'events'",
        "",
        "@overridden_bp.route('/health')",
        "def health():",
        "    return 'health'",
        "",
        "@none_bp.route('/ready')",
        "def ready():",
        "    return 'ready'",
        "",
        "@none_comment_bp.route('/ready')",
        "def ready_with_comment():",
        "    return 'ready'",
        "",
        "@constructor_comment_bp.route('/ready')",
        "def ready_with_constructor_comment():",
        "    return 'ready'",
        "",
        "@literal_comment_bp.route('/ready')",
        "def ready_with_literal_comment():",
        "    return 'ready'",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Flask route GET /api/users");
    expect(titles).toContain("Flask route POST /registered/reports");
    expect(titles).toContain("Flask route GET /metrics");
    expect(titles).toContain("Flask route GET /events");
    expect(titles).toContain("Flask route GET /health");
    expect(titles).toContain("Flask route GET /kept/ready");
    expect(titles).toContain("Flask route GET /kept-comment/ready");
    expect(titles).toContain("Flask route GET /constructor-comment/ready");
    expect(titles).toContain("Flask route GET /literal/ready");
    expect(titles).not.toContain("Flask route GET /dynamic/metrics");
    expect(titles).not.toContain("Flask route GET /dynamic/events");
    expect(titles).not.toContain("Flask route GET /constructor/health");
  });

  it("maps root-level Flask entry files and non-list methods", async () => {
    const root = await fixtureRoot("clawpatch-python-flask-root-routes-");
    await writeFixture(root, "requirements.txt", "Flask\npytest\n");
    await writeFixture(
      root,
      "app.py",
      [
        "from flask import Flask",
        "",
        "app = Flask(__name__)",
        "DYNAMIC_METHODS = ['POST']",
        "",
        "@app.route('/')",
        "def index():",
        "    return 'ok'",
        "",
        "@app.route('/submit', methods=('POST',))",
        "def submit():",
        "    return 'submitted'",
        "",
        "@app.route('/token', methods={'POST', 'DELETE'})",
        "def token():",
        "    return 'token'",
        "",
        "@app.route('/dynamic', methods=DYNAMIC_METHODS)",
        "def dynamic():",
        "    return 'dynamic'",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "test_app.py", "def test_index():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const routes = result.features.filter((feature) => feature.source === "python-flask-route");
    const byTitle = (title: string) => routes.find((feature) => feature.title === title);

    expect(project.detected.frameworks).toContain("flask");
    expect(byTitle("Flask route GET /")?.entrypoints[0]).toMatchObject({
      path: "app.py",
      symbol: "index",
      route: "GET /",
    });
    expect(byTitle("Flask route POST /submit")?.tests).toEqual([
      { path: "test_app.py", command: "pytest" },
    ]);
    expect(byTitle("Flask route POST,DELETE /token")?.trustBoundaries).toContain("auth");
    expect(routes.map((feature) => feature.title)).not.toContain("Flask route GET /dynamic");
  });

  it("does not map generic Python route decorators as Flask routes", async () => {
    const root = await fixtureRoot("clawpatch-python-generic-routes-");
    await writeFixture(root, "requirements.txt", "pytest\n");
    await writeFixture(
      root,
      "web/app.py",
      [
        "class Router:",
        "    def route(self, path):",
        "        def wrapper(fn):",
        "            return fn",
        "        return wrapper",
        "",
        "router = Router()",
        "",
        "@router.route('/not-flask')",
        "def handler():",
        "    return 'ok'",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.frameworks).not.toContain("flask");
    expect(result.features.some((feature) => feature.source === "python-flask-route")).toBe(false);
  });

  it("maps Django urls.py routes conservatively", async () => {
    const root = await fixtureRoot("clawpatch-python-django-routes-");
    await writeFixture(root, "requirements.txt", "django\npytest\n");
    await writeFixture(root, "mysite/__init__.py", "");
    await writeFixture(root, "api/__init__.py", "");
    await writeFixture(root, "api/v1/__init__.py", "");
    await writeFixture(
      root,
      "mysite/urls.py",
      [
        "from django.conf.urls import url",
        "from django.urls import include, path, re_path",
        "from django.contrib import admin",
        "from . import views",
        "from .views import SignupView",
        "",
        '"""',
        "urlpatterns = [",
        "    path('docs-only/', views.docs_only),",
        "]",
        '"""',
        "",
        'r"""',
        "urlpatterns = [",
        "    path('raw-docs-only/', views.raw_docs_only),",
        "]",
        '"""',
        "",
        "def build_local_patterns():",
        "    '''",
        "    urlpatterns = [",
        "        path('indented-docs-only/', views.indented_docs_only),",
        "    ]",
        "    '''",
        "    urlpatterns = [",
        "        path('local-only/', views.local_only),",
        "    ]",
        "    return urlpatterns",
        "",
        "def helper_patterns():",
        "    return [",
        "        path('helper/', views.helper),",
        "    ]",
        "",
        "unused_patterns = [",
        "    path('unused/', views.unused),",
        "]",
        "",
        "urlpatterns = [path('inline/', views.inline), re_path(r'^inline-regex/$', views.inline_regex),",
        "    path('', views.index, name='index'),",
        "    path('users/<int:pk>/', views.user_detail, name='user-detail'),",
        "    path('accounts/password/reset/', views.password_reset, name='password-reset'),",
        "    path('orders/', views.orders, name='orders'),",
        "    path(",
        "        'reports/',",
        "        views.reports,",
        "        name='reports',",
        "    ),",
        "    path('signup/', SignupView.as_view(), name='signup'),",
        "    path('admin/', admin.site.urls),",
        "    path('api/', include('api.urls')),",
        "    path('slashless', include('api.urls')),",
        "    path('tuple-api/', include(('tuple.urls', 'tuple'), namespace='tuple')),",
        "    re_path(r'^legacy/(?P<slug>[-\\w]+)/$', views.legacy, name='legacy'),",
        "    url(r'^old/(?P<pk>\\d+)/$', views.old_detail),",
        "    path(DYNAMIC_ROUTE, views.dynamic),",
        "    path(f'tenant/{slug}/', views.dynamic),",
        "    re_path(r'^(foo|bar)/$', views.complex_regex),",
        "    custom_path('custom/', views.custom),",
        "    # path('commented/', views.commented),",
        "    \"path('string/', views.string)\",",
        "]",
        "urlpatterns += [path('extra/', views.extra)]",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "fallback/__init__.py", "");
    await writeFixture(
      root,
      "api/urls.py",
      [
        "from django.urls import include, path",
        "from . import views",
        "",
        "urlpatterns = [",
        "    path('users/<int:pk>/', views.user_detail, name='user-detail'),",
        "    path('status/', views.status, name='status'),",
        "    path('v1/', include('api.v1.urls')),",
        "]",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "api/v1/urls.py",
      [
        "from django.urls import path",
        "from . import views",
        "",
        "urlpatterns = [",
        "    path('ping/', views.ping, name='ping'),",
        "]",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "fallback/urls.py",
      [
        "from . import views",
        "",
        "urlpatterns = [",
        "    path('dependency-only/', views.dependency_only),",
        "]",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "api/views.py", "def user_detail():\n    pass\n");
    await writeFixture(root, "api/v1/views.py", "def ping():\n    pass\n");
    await writeFixture(root, "mysite/views.py", "class SignupView:\n    pass\n");
    await writeFixture(root, "fallback/views.py", "def dependency_only():\n    pass\n");
    await writeFixture(root, "api/test_urls.py", "def test_api_urls():\n    pass\n");
    await writeFixture(root, "api/v1/test_urls.py", "def test_api_v1_urls():\n    pass\n");
    await writeFixture(root, "mysite/test_urls.py", "def test_urls():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const routes = result.features.filter((feature) => feature.source === "python-django-route");
    const titles = routes.map((feature) => feature.title);
    const byTitle = (title: string) => routes.find((feature) => feature.title === title);

    expect(project.detected.frameworks).toContain("django");
    expect(titles).toEqual(
      expect.arrayContaining([
        "Django route /",
        "Django route /users/:pk/",
        "Django route /accounts/password/reset/",
        "Django route /orders/",
        "Django route /reports/",
        "Django route /signup/",
        "Django route /admin/",
        "Django route /api/",
        "Django route /api/users/:pk/",
        "Django route /api/status/",
        "Django route /api/v1/",
        "Django route /api/v1/ping/",
        "Django route /slashless",
        "Django route /slashlessusers/:pk/",
        "Django route /slashlessstatus/",
        "Django route /slashlessv1/",
        "Django route /slashlessv1/ping/",
        "Django route /tuple-api/",
        "Django route /dependency-only/",
        "Django route /legacy/:slug/",
        "Django route /old/:pk/",
        "Django route /inline/",
        "Django route /inline-regex/",
        "Django route /extra/",
      ]),
    );
    expect(byTitle("Django route /")?.entrypoints[0]).toMatchObject({
      path: "mysite/urls.py",
      symbol: "views.index",
      route: "/",
    });
    expect(byTitle("Django route /")?.tests).toEqual([
      { path: "mysite/test_urls.py", command: "pytest" },
    ]);
    expect(byTitle("Django route /api/")?.entrypoints[0]?.symbol).toBe("api.urls");
    expect(byTitle("Django route /slashless")?.entrypoints[0]?.symbol).toBe("api.urls");
    expect(byTitle("Django route /api/users/:pk/")?.entrypoints[0]).toMatchObject({
      path: "api/urls.py",
      symbol: "views.user_detail",
      route: "/api/users/:pk/",
    });
    expect(byTitle("Django route /slashlessusers/:pk/")?.entrypoints[0]).toMatchObject({
      path: "api/urls.py",
      symbol: "views.user_detail",
      route: "/slashlessusers/:pk/",
    });
    expect(byTitle("Django route /api/users/:pk/")?.tests).toEqual([
      { path: "api/test_urls.py", command: "pytest" },
      { path: "api/v1/test_urls.py", command: "pytest" },
    ]);
    expect(byTitle("Django route /api/v1/")?.entrypoints[0]).toMatchObject({
      path: "api/urls.py",
      symbol: "api.v1.urls",
      route: "/api/v1/",
    });
    expect(byTitle("Django route /api/v1/ping/")?.entrypoints[0]).toMatchObject({
      path: "api/v1/urls.py",
      symbol: "views.ping",
      route: "/api/v1/ping/",
    });
    expect(byTitle("Django route /api/v1/ping/")?.tests).toEqual([
      { path: "api/v1/test_urls.py", command: "pytest" },
    ]);
    expect(byTitle("Django route /tuple-api/")?.entrypoints[0]?.symbol).toBeNull();
    expect(byTitle("Django route /signup/")?.entrypoints[0]?.symbol).toBe("SignupView.as_view");
    expect(byTitle("Django route /admin/")?.entrypoints[0]?.symbol).toBe("admin.site.urls");
    expect(byTitle("Django route /dependency-only/")?.entrypoints[0]).toMatchObject({
      path: "fallback/urls.py",
      symbol: "views.dependency_only",
      route: "/dependency-only/",
    });
    expect(byTitle("Django route /accounts/password/reset/")?.trustBoundaries).toContain("auth");
    expect(byTitle("Django route /signup/")?.trustBoundaries).toContain("auth");
    expect(routes.filter((feature) => feature.title === "Django route /users/:pk/")).toHaveLength(
      1,
    );
    expect(byTitle("Django route /users/:pk/")?.entrypoints[0]?.path).toBe("mysite/urls.py");
    expect(byTitle("Django route /users/:pk/")?.trustBoundaries).not.toContain("auth");
    expect(byTitle("Django route /orders/")?.trustBoundaries).not.toContain("auth");
    expect(titles).not.toContain("Django route /tenant/");
    expect(titles).not.toContain("Django route /custom/");
    expect(titles).not.toContain("Django route /commented/");
    expect(titles).not.toContain("Django route /string/");
    expect(titles).not.toContain("Django route /(foo|bar)/");
    expect(titles).not.toContain("Django route /docs-only/");
    expect(titles).not.toContain("Django route /raw-docs-only/");
    expect(titles).not.toContain("Django route /indented-docs-only/");
    expect(titles).not.toContain("Django route /local-only/");
    expect(titles).not.toContain("Django route /helper/");
    expect(titles).not.toContain("Django route /status/");
    expect(titles).not.toContain("Django route /v1/");
    expect(titles).not.toContain("Django route /v1/ping/");
    expect(titles).not.toContain("Django route /unused/");
  });

  it("does not map Django-shaped URLs without a Django signal", async () => {
    const root = await fixtureRoot("clawpatch-python-django-url-false-positive-");
    await writeFixture(root, "requirements.txt", "pytest\n");
    await writeFixture(root, "web/__init__.py", "");
    await writeFixture(
      root,
      "web/urls.py",
      [
        'r"""from django.urls import path"""',
        "",
        "def path(route, handler):",
        "    return (route, handler)",
        "",
        "urlpatterns = [",
        "    path('not-django/', handler),",
        "]",
        "def handler():",
        "    pass",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.frameworks).not.toContain("django");
    expect(result.features.some((feature) => feature.source === "python-django-route")).toBe(false);
  });

  it("maps FastAPI routes in root and web source files", async () => {
    const root = await fixtureRoot("clawpatch-python-fastapi-routes-");
    await writeFixture(root, "requirements.txt", "fastapi\npytest\n");
    await writeFixture(
      root,
      "app.py",
      [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "@app.get('/health')",
        "async def health():",
        "    return {'ok': True}",
        "",
        "@app.api_route('/webhook/{token}', methods=['GET', 'HEAD'])",
        "def webhook(token: str):",
        "    return token",
        "",
        "@app.api_route('/submit', methods=('POST',))",
        "def submit():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "web/api.py",
      [
        "from fastapi import APIRouter",
        "",
        "router: APIRouter = APIRouter(prefix='/api/v1')",
        "",
        "@router.post(",
        "    path='/admin/jobs',",
        ")",
        "def create_job():",
        "    return {'queued': True}",
        "",
        "@router.get('/admin/jobs/')",
        "def list_jobs():",
        "    return {'jobs': []}",
        "",
        "@router.get('')",
        "def admin_root():",
        "    return {'root': True}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "web/v2.py",
      [
        "import fastapi",
        "",
        "api_router = fastapi.APIRouter (",
        '    prefix="/v2",',
        "    tags=['v2'],",
        ")",
        "",
        "@api_router.get('/')",
        "def v2_index():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "tests/test_app.py", "def test_health():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const health = result.features.find((feature) => feature.title === "FastAPI route GET /health");
    const webhook = result.features.find(
      (feature) => feature.title === "FastAPI route GET,HEAD /webhook/{token}",
    );
    const submit = result.features.find(
      (feature) => feature.title === "FastAPI route POST /submit",
    );
    const admin = result.features.find(
      (feature) => feature.title === "FastAPI route POST /api/v1/admin/jobs",
    );
    const jobs = result.features.find(
      (feature) => feature.title === "FastAPI route GET /api/v1/admin/jobs/",
    );
    const adminRoot = result.features.find(
      (feature) => feature.title === "FastAPI route GET /api/v1",
    );
    const v2 = result.features.find((feature) => feature.title === "FastAPI route GET /v2/");

    expect(project.detected.frameworks).toContain("fastapi");
    expect(health?.source).toBe("python-fastapi-route");
    expect(health?.entrypoints[0]).toMatchObject({
      path: "app.py",
      symbol: "health",
      route: "GET /health",
    });
    expect(health?.tests).toEqual([{ path: "tests/test_app.py", command: "pytest" }]);
    expect(webhook?.entrypoints[0]?.route).toBe("GET,HEAD /webhook/{token}");
    expect(submit?.entrypoints[0]?.route).toBe("POST /submit");
    expect(admin?.entrypoints[0]).toMatchObject({
      path: "web/api.py",
      symbol: "create_job",
      route: "POST /api/v1/admin/jobs",
    });
    expect(admin?.trustBoundaries).toContain("auth");
    expect(jobs?.entrypoints[0]?.route).toBe("GET /api/v1/admin/jobs/");
    expect(adminRoot?.entrypoints[0]?.route).toBe("GET /api/v1");
    expect(v2?.entrypoints[0]).toMatchObject({
      path: "web/v2.py",
      symbol: "v2_index",
      route: "GET /v2/",
    });
  });

  it("detects metadata-free root and web Python sources", async () => {
    const root = await fixtureRoot("clawpatch-python-root-web-detect-");
    await writeFixture(root, "app.py", "def app():\n    pass\n");
    await writeFixture(
      root,
      "web/api.py",
      [
        "from fastapi import APIRouter",
        "",
        "router = APIRouter()",
        "",
        "@router.get(path='/health')",
        "def health():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rootSource = result.features.find((feature) => feature.title === "Python source root");
    const webRoute = result.features.find(
      (feature) => feature.title === "FastAPI route GET /health",
    );

    expect(project.detected.languages).toContain("python");
    expect(project.detected.packageManagers).toContain("python");
    expect(project.detected.frameworks).toContain("fastapi");
    expect(rootSource?.ownedFiles).toEqual([{ path: "app.py", reason: "source group root" }]);
    expect(webRoute?.entrypoints[0]).toMatchObject({
      path: "web/api.py",
      symbol: "health",
      route: "GET /health",
    });
  });

  it("adds Python target runtime metadata to source review context", async () => {
    const root = await fixtureRoot("clawpatch-python-runtime-context-");
    await writeFixture(root, ".python-version", "3.14\n");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "pep758-demo"\nrequires-python = ">=3.14"\n',
    );
    await writeFixture(
      root,
      "main.py",
      [
        "def parse(value):",
        "    try:",
        "        return float(value)",
        "    except TypeError, ValueError:",
        "        return 0",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source root");

    expect(source?.ownedFiles).toEqual([{ path: "main.py", reason: "source group root" }]);
    expect(source?.contextFiles).toEqual([
      { path: "pyproject.toml", reason: "python target runtime metadata" },
      { path: ".python-version", reason: "python target runtime metadata" },
    ]);
  });

  it("uses Hatch pytest commands in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-hatch-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "hatch-map"\n\n[tool.hatch.envs.default]\ndependencies = ["pytest"]\n',
    );
    await writeFixture(root, "src/hatch_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/hatch_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("hatch run pytest");
    expect(source?.tests).toEqual([
      { path: "src/hatch_map/test_app.py", command: "hatch run pytest" },
    ]);
  });

  it("uses uv pytest commands from pyproject uv config in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-pyproject-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "uv-map"\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n',
    );
    await writeFixture(root, "src/uv_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/uv_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(source?.tests).toEqual([{ path: "src/uv_map/test_app.py", command: "uv run pytest" }]);
  });

  it("uses uv pytest commands from pyproject uv array-table config in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-array-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "uv-array-map"\ndependencies = ["pytest"]\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    await writeFixture(root, "src/uv_array_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/uv_array_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(source?.tests).toEqual([
      { path: "src/uv_array_map/test_app.py", command: "uv run pytest" },
    ]);
  });

  it("uses Poetry and PDM pytest commands from pyproject tool config in mapped Python features", async () => {
    const poetryRoot = await fixtureRoot("clawpatch-python-poetry-pyproject-map-");
    await writeFixture(
      poetryRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-map"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n',
    );
    await writeFixture(poetryRoot, "src/poetry_map/app.py", "def app():\n    pass\n");
    await writeFixture(poetryRoot, "src/poetry_map/test_app.py", "def test_app():\n    pass\n");

    const poetryProject = await detectProject(poetryRoot);
    const poetryResult = await mapFeatures(poetryRoot, poetryProject, []);
    const poetrySource = poetryResult.features.find(
      (feature) => feature.title === "Python source src",
    );
    expect(poetrySource?.tests).toEqual([
      { path: "src/poetry_map/test_app.py", command: "poetry run pytest" },
    ]);

    const pdmRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-map-");
    await writeFixture(
      pdmRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest"]\n',
    );
    await writeFixture(pdmRoot, "src/pdm_map/app.py", "def app():\n    pass\n");
    await writeFixture(pdmRoot, "src/pdm_map/test_app.py", "def test_app():\n    pass\n");

    const pdmProject = await detectProject(pdmRoot);
    const pdmResult = await mapFeatures(pdmRoot, pdmProject, []);
    const pdmSource = pdmResult.features.find((feature) => feature.title === "Python source src");
    expect(pdmSource?.tests).toEqual([
      { path: "src/pdm_map/test_app.py", command: "pdm run pytest" },
    ]);
  });

  it("maps Python metadata-only projects without pyproject", async () => {
    const root = await fixtureRoot("clawpatch-python-legacy-metadata-");
    await writeFixture(root, "setup.cfg", "[metadata]\nname = legacy\n");
    await writeFixture(root, "requirements.txt", "pytest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const metadata = result.features.find((feature) => feature.source === "python-project");

    expect(project.detected.languages).toContain("python");
    expect(metadata?.entrypoints[0]?.path).toBe("setup.cfg");
    expect(metadata?.ownedFiles).toEqual([
      { path: "setup.cfg", reason: "python project metadata" },
      { path: "requirements.txt", reason: "python project metadata" },
    ]);
  });

  it("maps setup.cfg Python project names and console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-setup-cfg-entry-points-");
    await writeFixture(
      root,
      "setup.cfg",
      [
        "[metadata]",
        "name = legacy-cli",
        "",
        "[options.entry_points]",
        "console_scripts =",
        "    legacy = legacy.cli:main",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "legacy/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "tests/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command legacy");

    expect(titles).toContain("Python project legacy-cli");
    expect(cli?.entrypoints[0]).toMatchObject({ path: "legacy/cli.py", symbol: "main" });
    expect(cli?.tests).toEqual([{ path: "tests/test_cli.py", command: "pytest" }]);
  });

  it("maps setup.py Python project names and console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-setup-py-entry-points-");
    await writeFixture(
      root,
      "setup.py",
      [
        "from setuptools import setup",
        "",
        "setup(",
        "    name='setup-cli',",
        "    entry_points={'console_scripts': ['setcli=setup_cli.cli:main']},",
        ")",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "setup_cli/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command setcli");

    expect(titles).toContain("Python project setup-cli");
    expect(cli?.entrypoints[0]).toMatchObject({ path: "setup_cli/cli.py", symbol: "main" });
  });

  it("keeps Python source group ids stable when a root gains files", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-source-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-source"\n');
    await writeFixture(root, "scripts/tool.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSource = first.features.find((feature) => feature.title === "Python source scripts");
    await writeFixture(root, "scripts/other.py", "def other():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSource = second.features.find(
      (feature) => feature.title === "Python source scripts",
    );

    expect(firstSource?.featureId).toBeDefined();
    expect(secondSource?.featureId).toBe(firstSource?.featureId);
    expect(second.stale).toBe(0);
  });

  it("keeps Python pytest suite ids stable when tests are added", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-test-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-tests"\n');
    await writeFixture(root, "tests/test_b.py", "def test_b():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSuite = first.features.find(
      (feature) => feature.title === "Python test suite tests",
    );
    await writeFixture(root, "tests/test_a.py", "def test_a():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSuite = second.features.find(
      (feature) => feature.title === "Python test suite tests",
    );

    expect(firstSuite?.featureId).toBeDefined();
    expect(secondSuite?.featureId).toBe(firstSuite?.featureId);
    expect(second.stale).toBe(0);
  });

  it("keeps root-level Python pytest suite ids stable when tests are added", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-root-test-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-root-tests"\n');
    await writeFixture(root, "test_b.py", "def test_b():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSuite = first.features.find(
      (feature) => feature.title === "Python test suite tests",
    );
    await writeFixture(root, "test_a.py", "def test_a():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSuite = second.features.find(
      (feature) => feature.title === "Python test suite tests",
    );

    expect(firstSuite?.featureId).toBeDefined();
    expect(secondSuite?.featureId).toBe(firstSuite?.featureId);
    expect(second.stale).toBe(0);
  });

  it("stops Python script parsing at TOML array-table headers", async () => {
    const root = await fixtureRoot("clawpatch-python-array-table-script-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "array-table"\n\n[project.scripts]\nreal = "pkg.cli:main"\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    await writeFixture(root, "pkg/__init__.py", "");
    await writeFixture(root, "pkg/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const commands = result.features
      .filter((feature) => feature.source === "python-console-script")
      .map((feature) => feature.entrypoints[0]?.command);

    expect(commands).toEqual(["real"]);
  });

  it("does not map commented Python console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-commented-script-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "commented-script"\n\n[project.scripts]\n#old = "pkg.old:main"\nreal = "pkg.cli:main"\n',
    );
    await writeFixture(root, "pkg/__init__.py", "");
    await writeFixture(root, "pkg/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const commands = result.features
      .filter((feature) => feature.source === "python-console-script")
      .map((feature) => feature.entrypoints[0]?.command);

    expect(commands).toEqual(["real"]);
  });

  it("groups colocated Python pytest suites by their actual directory", async () => {
    const root = await fixtureRoot("clawpatch-python-colocated-test-groups-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "colocated-tests"\n');
    for (let index = 0; index < 13; index += 1) {
      await writeFixture(root, `src/pkg/test_${index}.py`, `def test_${index}():\n    pass\n`);
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suites = result.features.filter((feature) => feature.source === "python-test-suite");

    expect(suites.map((feature) => feature.title)).toEqual([
      "Python test suite src/pkg#1",
      "Python test suite src/pkg#2",
    ]);
    expect(
      suites
        .flatMap((feature) => feature.ownedFiles)
        .every((file) => file.path.startsWith("src/pkg/")),
    ).toBe(true);
  });

  it("groups nested Python star-test files by their actual directory", async () => {
    const root = await fixtureRoot("clawpatch-python-nested-star-test-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "nested-star-tests"\n');
    await writeFixture(root, "src/pkg/store_test.py", "def test_store():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suite = result.features.find((feature) => feature.source === "python-test-suite");

    expect(suite?.title).toBe("Python test suite src/pkg");
    expect(suite?.entrypoints[0]?.path).toBe("src/pkg");
    expect(suite?.ownedFiles).toEqual([{ path: "src/pkg/store_test.py", reason: "pytest file" }]);
  });

  it("does not map Python test support modules as pytest suites", async () => {
    const root = await fixtureRoot("clawpatch-python-test-support-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "support-only"\n');
    await writeFixture(root, "tests/helpers.py", "def helper():\n    pass\n");
    await writeFixture(root, "tests/conftest.py", "def pytest_configure():\n    pass\n");
    await writeFixture(root, "tests/__init__.py", "");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.some((feature) => feature.source === "python-test-suite")).toBe(false);
  });

  it("does not map Python fixture sample tests as pytest suites", async () => {
    const root = await fixtureRoot("clawpatch-python-fixture-tests-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "fixture-only"\n');
    await writeFixture(root, "tests/fixtures/test_sample.py", "def test_sample():\n    pass\n");
    await writeFixture(root, "tests/__fixtures__/test_sample.py", "def test_sample():\n    pass\n");
    await writeFixture(root, "testdata/test_sample.py", "def test_sample():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.some((feature) => feature.source === "python-test-suite")).toBe(false);
  });

  it("maps Python source-only projects without a full source-group pre-scan", async () => {
    const root = await fixtureRoot("clawpatch-python-source-only-");
    await writeFixture(root, "src/source_only/app.py", "def app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.languages).toContain("python");
    expect(source?.ownedFiles).toEqual([
      { path: "src/source_only/app.py", reason: "source group src" },
    ]);
  });
});
