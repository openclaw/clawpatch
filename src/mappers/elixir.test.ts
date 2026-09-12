import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("detects Mix and Phoenix projects with useful default commands", async () => {
    const root = await fixtureRoot("clawpatch-elixir-detect-");
    await writeFixture(
      root,
      "mix.exs",
      `defmodule SampleApp.MixProject do
  use Mix.Project

  def project do
    [
      # app: :wrong_app,
      app: :sample_app,
      version: "0.1.0",
      elixir: "~> 1.18",
      deps: deps()
    ]
  end

  defp deps do
    [
      # {:ecto_sql, "~> 3.13"},
      {:phoenix, "~> 1.8"},
      {:phoenix_live_view, "~> 1.1"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end
end
`,
    );

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("elixir");
    expect(project.detected.frameworks).toEqual(expect.arrayContaining(["mix", "phoenix"]));
    expect(project.detected.frameworks).not.toContain("ecto_sql");
    expect(project.detected.packageManagers).toContain("mix");
    expect(project.detected.commands).toEqual({
      typecheck: "mix compile --warnings-as-errors",
      lint: "mix credo --strict",
      format: "mix format --check-formatted",
      test: "mix test",
    });
  });

  it("maps Elixir contexts, Phoenix web slices, config, migrations, and scripts", async () => {
    const root = await fixtureRoot("clawpatch-elixir-map-");
    await writeFixture(
      root,
      "mix.exs",
      `defmodule SampleApp.MixProject do
  use Mix.Project

  def project do
    [
      # app: :wrong_app,
      app: :sample_app,
      version: "0.1.0",
      deps: deps()
    ]
  end

  defp deps do
    [{:phoenix, "~> 1.8"}, {:ecto_sql, "~> 3.13"}]
  end
end
`,
    );
    await writeFixture(root, "config/config.exs", "import Config\n");
    await writeFixture(
      root,
      "priv/repo/migrations/20260517000000_create_users.exs",
      "defmodule SampleApp.Repo.Migrations.CreateUsers do\nend\n",
    );
    await writeFixture(root, "lib/sample_app/repo.ex", "defmodule SampleApp.Repo do\nend\n");
    await writeFixture(
      root,
      "lib/sample_app/accounts.ex",
      "defmodule SampleApp.Accounts do\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app/accounts/user.ex",
      "defmodule SampleApp.Accounts.User do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app/accounts_test.exs",
      "defmodule SampleApp.AccountsTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(root, "lib/sample_app/billing.ex", "defmodule SampleApp.Billing do\nend\n");
    await writeFixture(
      root,
      "test/sample_app/billing_test.exs",
      "defmodule SampleApp.BillingTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/router.ex",
      "defmodule SampleAppWeb.Router do\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/controllers/page_controller.ex",
      "defmodule SampleAppWeb.PageController do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app_web/controllers/page_controller_test.exs",
      "defmodule SampleAppWeb.PageControllerTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/live/dashboard_live.ex",
      "defmodule SampleAppWeb.DashboardLive do\nend\n",
    );
    await writeFixture(root, "lib/sample_app_web/live/page_live.html.heex", "<div />\n");
    await writeFixture(
      root,
      "test/sample_app_web/live/page_live_test.exs",
      "defmodule SampleAppWeb.PageLiveTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/components/layouts.ex",
      "defmodule SampleAppWeb.Layouts do\nend\n",
    );
    await writeFixture(root, "scripts/release_check.exs", "Mix.install([])\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const accounts = result.features.find((feature) => feature.title === "Elixir context accounts");
    const billing = result.features.find((feature) => feature.title === "Elixir context billing");
    const controllers = result.features.find(
      (feature) => feature.title === "Phoenix web controllers",
    );
    const live = result.features.find((feature) => feature.title === "Phoenix web live");
    const migrations = result.features.find((feature) => feature.title === "Ecto migrations");

    expect(titles).toEqual(
      expect.arrayContaining([
        "Elixir context accounts",
        "Elixir context billing",
        "Phoenix web controllers",
        "Phoenix web live",
        "Phoenix web components",
        "Elixir runtime configuration",
        "Ecto migrations",
        "Project scripts",
      ]),
    );
    expect(accounts?.ownedFiles.map((file) => file.path)).toEqual([
      "lib/sample_app/accounts.ex",
      "lib/sample_app/accounts/user.ex",
    ]);
    expect(accounts?.tests).toEqual([
      {
        path: "test/sample_app/accounts_test.exs",
        command: "mix test test/sample_app/accounts_test.exs",
      },
    ]);
    expect(billing?.ownedFiles.map((file) => file.path)).toEqual(["lib/sample_app/billing.ex"]);
    expect(billing?.tests).toEqual([
      {
        path: "test/sample_app/billing_test.exs",
        command: "mix test test/sample_app/billing_test.exs",
      },
    ]);
    expect(controllers?.contextFiles.map((file) => file.path)).toContain(
      "lib/sample_app_web/router.ex",
    );
    expect(controllers?.tests).toEqual([
      {
        path: "test/sample_app_web/controllers/page_controller_test.exs",
        command: "mix test test/sample_app_web/controllers/page_controller_test.exs",
      },
    ]);
    expect(live?.tests).toContainEqual({
      path: "test/sample_app_web/live/page_live_test.exs",
      command: "mix test test/sample_app_web/live/page_live_test.exs",
    });
    expect(migrations?.contextFiles.map((file) => file.path)).toEqual([
      "mix.exs",
      "lib/sample_app/repo.ex",
    ]);
  });

  it("quotes Elixir test paths with shell metacharacters", async () => {
    const root = await fixtureRoot("clawpatch-elixir-quoted-test-path-");
    await writeFixture(
      root,
      "mix.exs",
      'defmodule SampleApp.MixProject do\n  use Mix.Project\n  def project, do: [app: :sample_app, version: "0.1.0"]\nend\n',
    );
    await writeFixture(
      root,
      "lib/sample_app/accounts.ex",
      "defmodule SampleApp.Accounts do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app/accounts/injected; touch INJECTED_test.exs",
      "defmodule SampleApp.AccountsTest do\nuse ExUnit.Case\nend\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const accounts = result.features.find((feature) => feature.title === "Elixir context accounts");

    expect(accounts?.tests).toEqual([
      {
        path: "test/sample_app/accounts/injected; touch INJECTED_test.exs",
        command: 'mix test "test/sample_app/accounts/injected; touch INJECTED_test.exs"',
      },
    ]);
  });

  it("does not map generated Mix dependency C files", async () => {
    const root = await fixtureRoot("clawpatch-elixir-deps-skip-");
    await writeFixture(
      root,
      "mix.exs",
      'defmodule SampleApp.MixProject do\n  use Mix.Project\n  def project, do: [app: :sample_app, version: "0.1.0"]\nend\n',
    );
    await writeFixture(root, "lib/sample_app/core.ex", "defmodule SampleApp.Core do\nend\n");
    await writeFixture(root, "deps/native/src/noise.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "apps/web/deps/native/src/nested_noise.c",
      "int main(void) { return 0; }\n",
    );

    const result = await mapFeatures(root, await detectProject(root), []);

    expect(result.features.map((feature) => feature.entrypoints[0]?.path)).toEqual(
      expect.not.arrayContaining([
        "deps/native/src/noise.c",
        "apps/web/deps/native/src/nested_noise.c",
      ]),
    );
  });

  it("still maps non-Elixir source directories named deps", async () => {
    const root = await fixtureRoot("clawpatch-deps-source-dir-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "deps-source" }));
    await writeFixture(root, "lib/deps/client.ts", "export function client() { return true; }\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const owned = result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path));

    expect(owned).toContain("lib/deps/client.ts");
  });
});
