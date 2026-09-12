import { describe, expect, it, vi } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";
import * as projectsModule from "../mappers/projects.js";
import * as turboModule from "../mappers/turbo.js";

describe("mapFeatures", () => {
  it("maps C# .NET projects, ASP.NET endpoints, and associated test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-map-");
    await writeFixture(
      root,
      "TodoApp.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "Todo.Api", "src\\Todo.Api\\Todo.Api.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Todo.Api.Tests", "tests\\Todo.Api.Tests\\Todo.Api.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
`,
    );
    await writeFixture(root, "global.json", '{ "sdk": { "version": "9.0.100" } }\n');
    await writeFixture(root, "Directory.Build.props", "<Project />\n");
    await writeFixture(
      root,
      "src/Todo.Api/Todo.Api.csproj",
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Program.cs",
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok());
app.MapGet("/todos", () => Results.Ok());
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.MapFallbackToFile("index.html");
app.MapFallbackToFile("/{*path:nonfile}", "index.html");
app.Run();
public sealed record Todo(string Id);
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Controllers/TodoController.cs",
      `using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public sealed class TodoController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(string id) => Ok(id);

    [HttpGet(Name = "ListTodos")]
    public IActionResult List() => Ok();

    [HttpPost]
    public IActionResult Create() => Created();
}
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Services/TodoService.cs",
      "public sealed class TodoService {}\n",
    );
    await writeFixture(
      root,
      "src/Todo.Api/Generated/TodoClient.g.cs",
      "public sealed class GeneratedClient {}\n",
    );
    await writeFixture(
      root,
      "src/Todo.Api/obj/Debug/net9.0/Todo.Api.AssemblyInfo.cs",
      "public sealed class AssemblyInfo {}\n",
    );
    await writeFixture(
      root,
      "tests/Todo.Api.Tests/Todo.Api.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <ProjectReference Include="..\\..\\src\\Todo.Api\\Todo.Api.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "tests/Todo.Api.Tests/TodoControllerTests.cs",
      "public sealed class TodoControllerTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const health = result.features.find(
      (feature) => feature.title === "ASP.NET endpoint GET /health",
    );
    const controller = result.features.find(
      (feature) => feature.title === "ASP.NET controller TodoController",
    );
    const ownedFiles = new Set(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    );

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.frameworks).toEqual(
      expect.arrayContaining(["aspnetcore", "dotnet-test"]),
    );
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build TodoApp.sln",
      test: "dotnet test TodoApp.sln",
    });
    expect(titles).toContain(".NET project Todo.Api");
    expect(titles).toContain(".NET project Todo.Api.Tests");
    expect(titles).toContain("C# test suite Todo.Api.Tests");
    expect(titles).toContain("ASP.NET endpoint GET /health");
    expect(titles).toContain("ASP.NET endpoint GET /todos");
    expect(titles).toContain("ASP.NET endpoint POST /todos");
    expect(titles).toContain("ASP.NET endpoint FALLBACKTOFILE /{*path:nonfile}");
    expect(titles).not.toContain("ASP.NET endpoint FALLBACKTOFILE /index.html");
    expect(titles).toContain("ASP.NET controller TodoController");
    expect(titles).toContain("C# source src/Todo.Api");
    expect(titles).toContain("Project config global.json");
    expect(health?.tests).toEqual([
      {
        path: "tests/Todo.Api.Tests/TodoControllerTests.cs",
        command: "dotnet test tests/Todo.Api.Tests/Todo.Api.Tests.csproj",
      },
    ]);
    expect(health?.contextFiles).toContainEqual({
      path: "tests/Todo.Api.Tests/TodoControllerTests.cs",
      reason: "associated test",
    });
    expect(controller?.summary).not.toContain("ListTodos");
    expect(ownedFiles).not.toContain("src/Todo.Api/Generated/TodoClient.g.cs");
    expect(ownedFiles).not.toContain("src/Todo.Api/obj/Debug/net9.0/Todo.Api.AssemblyInfo.cs");
  });

  it("does not map NuGet.config into review context", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-nuget-config-");
    await writeFixture(
      root,
      "NuGet.config",
      "<packageSourceCredentials>secret</packageSourceCredentials>\n",
    );
    await writeFixture(root, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "Program.cs", "public sealed class Program {}\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const referencedPaths = result.features.flatMap((feature) => [
      feature.entrypoints[0]?.path,
      ...feature.ownedFiles.map((file) => file.path),
      ...feature.contextFiles.map((file) => file.path),
      ...feature.tests.map((test) => test.path),
    ]);

    expect(result.features.map((feature) => feature.title)).not.toContain(
      "Project config NuGet.config",
    );
    expect(referencedPaths).not.toContain("NuGet.config");
  });

  it("preserves ASP.NET minimal API route group prefixes", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-map-group-");
    await writeFixture(
      root,
      "src/Grouped.Api/Grouped.Api.csproj",
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/Grouped.Api/Program.cs",
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGroup("/v1").MapGet("/users", () => Results.Ok());
app.MapGroup("/v2").MapGet("/users", () => Results.Ok());
var admin = app.MapGroup("/admin");
admin.MapGet("/users", () => Results.Ok());
var reports = admin.MapGroup("/reports");
reports.MapPost("/{id}", () => Results.Ok());
RouteGroupBuilder ApiGroup(WebApplication app) =>
    app.MapGroup("/api")
        .WithTags("api");
var helperGroup = ApiGroup(app);
helperGroup.MapDelete("/teams/{id}", () => Results.Ok());
app.Run();
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const endpointTitles = result.features
      .map((feature) => feature.title)
      .filter((title) => title.startsWith("ASP.NET endpoint "));

    expect(endpointTitles).toEqual(
      expect.arrayContaining([
        "ASP.NET endpoint GET /v1/users",
        "ASP.NET endpoint GET /v2/users",
        "ASP.NET endpoint GET /admin/users",
        "ASP.NET endpoint POST /admin/reports/{id}",
        "ASP.NET endpoint DELETE /api/teams/{id}",
      ]),
    );
    expect(endpointTitles).not.toContain("ASP.NET endpoint GET /users");
  });

  it("keeps .NET validation commands conservative for ambiguous workspaces", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-ambiguous-");
    await writeFixture(root, "First.sln", "");
    await writeFixture(root, "Second.sln", "");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBe("dotnet test tests/App.Tests/App.Tests.csproj");
  });

  it("targets a lone .NET test project when the build solution omits it", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-missing-test-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe("dotnet build App.sln");
    expect(project.detected.commands.test).toBe("dotnet test tests/App.Tests/App.Tests.csproj");
  });

  it("does not build a root .NET solution that omits non-test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-missing-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("does not build a .NET solution with stale project entries", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-stale-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Lib", "src\\Lib\\Lib.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Missing", "src\\Missing\\Missing.csproj", "{33333333-3333-3333-3333-333333333333}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("does not build a .NET solution with out-of-root project entries", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-outside-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Lib", "src\\Lib\\Lib.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Outside", "..\\Outside\\Outside.csproj", "{33333333-3333-3333-3333-333333333333}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("ignores commented .NET slnx project entries for validation targets", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-slnx-commented-project-");
    await writeFixture(
      root,
      "App.slnx",
      `<Solution>
  <Project Path="src/App/App.csproj" />
  <!-- <Project Path="src/Lib/Lib.csproj" /> -->
</Solution>
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const libProject = result.features.find((feature) => feature.title === ".NET project Lib");

    expect(project.detected.commands.typecheck).toBeNull();
    expect(libProject?.contextFiles).not.toContainEqual({
      path: "App.slnx",
      reason: "solution context",
    });
  });

  it("prefers a root .NET project over an unrelated nested solution", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-root-project-nested-solution-");
    await writeFixture(root, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tools/Tool.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "Tool", "Tool.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "tools/Tool.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe("dotnet build App.csproj");
  });

  it("ignores .NET test metadata inside XML comments", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-commented-test-metadata-");
    await writeFixture(
      root,
      "src/App/App.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <!--
  <Project Sdk="Microsoft.NET.Sdk.Web">
  <PackageReference Include="Microsoft.Extensions.Hosting" Version="9.0.0" />
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="9.0.0" />
  <Using Include="BackgroundService" />
  <PropertyGroup>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
  </ItemGroup>
  -->
</Project>
`,
    );
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appProject = result.features.find((feature) => feature.title === ".NET project App");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.frameworks).not.toContain("dotnet-test");
    expect(project.detected.frameworks).not.toContain("aspnetcore");
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build src/App/App.csproj",
      test: null,
    });
    expect(titles).toContain(".NET project App");
    expect(titles).toContain("C# source src/App");
    expect(titles).not.toContain("C# test suite App");
    expect(appProject?.kind).toBe("library");
    expect(appProject?.tags).not.toContain("aspnetcore");
    expect(appProject?.tags).not.toContain("worker");
  });

  it("does not treat Program.cs as ASP.NET evidence for ordinary C# projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-console-program-controller-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", 'Console.WriteLine("hello");\n');
    await writeFixture(
      root,
      "src/App/Domain/MotorController.cs",
      "public sealed class MotorController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.frameworks).not.toContain("aspnetcore");
    expect(titles).not.toContain("ASP.NET controller MotorController");
    expect(appSource?.ownedFiles).toEqual(
      expect.arrayContaining([
        { path: "src/App/Program.cs", reason: "C# source group src/App" },
        { path: "src/App/Domain/MotorController.cs", reason: "C# source group src/App" },
      ]),
    );
  });

  it("discovers first-party .NET projects under packages workspaces", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-packages-workspace-");
    await writeFixture(root, "packages/Foo/Foo.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "packages/Foo/Service.cs", "public sealed class Service {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build packages/Foo/Foo.csproj",
      test: null,
    });
    expect(titles).toContain(".NET project Foo");
    expect(titles).toContain("C# source packages/Foo");
  });

  it("targets the discovered .NET test project when the build target is an app project", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-root-app-nested-test-");
    await writeFixture(root, "My App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/My App.Tests/My App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe('dotnet build "My App.csproj"');
    expect(project.detected.commands.test).toBe(
      'dotnet test "tests/My App.Tests/My App.Tests.csproj"',
    );
  });

  it("detects TUnit projects without Microsoft.NET.Test.Sdk as .NET test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-tunit-test-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tests/App.TUnit/App.TUnit.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="TUnit" Version="1.13.11" />
    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "tests/App.TUnit/ProgramTests.cs",
      "public sealed class ProgramTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const testSuite = result.features.find(
      (feature) => feature.title === "C# test suite App.TUnit",
    );
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");

    expect(project.detected.frameworks).toContain("dotnet-test");
    expect(project.detected.commands.test).toBe("dotnet test tests/App.TUnit/App.TUnit.csproj");
    expect(testSuite?.tests).toEqual([
      {
        path: "tests/App.TUnit/ProgramTests.cs",
        command: "dotnet test tests/App.TUnit/App.TUnit.csproj",
      },
    ]);
    expect(appSource?.tests).toEqual([
      {
        path: "tests/App.TUnit/ProgramTests.cs",
        command: "dotnet test tests/App.TUnit/App.TUnit.csproj",
      },
    ]);
  });

  it("keeps dotnet test commands for test projects without C# source files", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-empty-test-group-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.fsproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const testSuite = result.features.find(
      (feature) => feature.title === "F# test suite App.Tests",
    );
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");

    expect(testSuite?.tests).toEqual([
      {
        path: "tests/App.Tests/App.Tests.fsproj",
        command: "dotnet test tests/App.Tests/App.Tests.fsproj",
      },
    ]);
    expect(appSource?.tests).toEqual([
      {
        path: "tests/App.Tests/App.Tests.fsproj",
        command: "dotnet test tests/App.Tests/App.Tests.fsproj",
      },
    ]);
  });

  it("maps F# and Visual Basic source groups with solution context", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-fsharp-vb-source-");
    await writeFixture(
      root,
      "solutions/App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "FsLib", "..\\src\\FsLib\\FsLib.fsproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "FsLib.Tests", "..\\tests\\FsLib.Tests\\FsLib.Tests.fsproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
`,
    );
    await writeFixture(
      root,
      "solutions/App.slnx",
      '<Solution><Project Path="../src/VbApp/VbApp.vbproj" /></Solution>\n',
    );
    await writeFixture(root, "src/FsLib/FsLib.fsproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/FsLib/Library.fs", 'module Library\nlet hello = "world"\n');
    await writeFixture(
      root,
      "tests/FsLib.Tests/FsLib.Tests.fsproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\src\\FsLib\\FsLib.fsproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(root, "tests/FsLib.Tests/Tests.fs", "module Tests\n");
    await writeFixture(root, "src/VbApp/VbApp.vbproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/VbApp/Program.vb", "Module Program\nEnd Module\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const fsProject = result.features.find((feature) => feature.title === ".NET project FsLib");
    const fsSource = result.features.find((feature) => feature.title === "F# source src/FsLib");
    const vbProject = result.features.find((feature) => feature.title === ".NET project VbApp");
    const vbSource = result.features.find(
      (feature) => feature.title === "Visual Basic source src/VbApp",
    );

    expect(project.detected.languages).toEqual(expect.arrayContaining(["fsharp", "visual-basic"]));
    expect(fsProject?.contextFiles).toContainEqual({
      path: "solutions/App.sln",
      reason: "solution context",
    });
    expect(vbProject?.contextFiles).toContainEqual({
      path: "solutions/App.slnx",
      reason: "solution context",
    });
    expect(fsSource?.ownedFiles).toEqual([
      { path: "src/FsLib/Library.fs", reason: "F# source group src/FsLib" },
    ]);
    expect(fsSource?.tests).toEqual([
      {
        path: "tests/FsLib.Tests/Tests.fs",
        command: "dotnet test tests/FsLib.Tests/FsLib.Tests.fsproj",
      },
    ]);
    expect(vbSource?.ownedFiles).toEqual([
      { path: "src/VbApp/Program.vb", reason: "Visual Basic source group src/VbApp" },
    ]);
  });

  it("excludes nested .NET project roots from parent C# source groups", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-nested-project-root-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "src/App/tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/App/tests/App.Tests/ProgramTests.cs",
      "public sealed class ProgramTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");
    const testSuite = result.features.find(
      (feature) => feature.title === "C# test suite App.Tests",
    );

    expect(appSource?.ownedFiles).toEqual([
      { path: "src/App/Program.cs", reason: "C# source group src/App" },
    ]);
    expect(testSuite?.ownedFiles).toEqual([
      {
        path: "src/App/tests/App.Tests/ProgramTests.cs",
        reason: "C# test group src/App/tests/App.Tests",
      },
    ]);
  });

  it("does not report dotnet as a package manager for manifestless C# source", async () => {
    const root = await fixtureRoot("clawpatch-csharp-source-only-");
    await writeFixture(root, "src/Helpers/Thing.cs", "public sealed class Thing {}\n");
    await writeFixture(root, "src/Helpers/Thing.g.cs", "public sealed class GeneratedThing {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "C# source src");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).not.toContain("dotnet");
    expect(project.detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });
    expect(titles).not.toContain(".NET project Thing");
    expect(source?.ownedFiles).toEqual([
      { path: "src/Helpers/Thing.cs", reason: "C# source group src" },
    ]);
  });

  it("keeps Ruby validation defaults when a Ruby project has source-only C#", async () => {
    const root = await fixtureRoot("clawpatch-ruby-csharp-source-only-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "src/Helpers/Thing.cs", "public sealed class Thing {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toEqual(expect.arrayContaining(["ruby", "csharp"]));
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.packageManagers).not.toContain("dotnet");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
  });

  it("skips fixture and testdata .NET projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-samples-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Service.cs", "public sealed class Service {}\n");
    await writeFixture(
      root,
      "fixtures/Sample/Sample.csproj",
      '<Project Sdk="Microsoft.NET.Sdk" />\n',
    );
    await writeFixture(root, "fixtures/Sample/Sample.cs", "public sealed class Sample {}\n");
    await writeFixture(
      root,
      "testdata/Example/Example.csproj",
      '<Project Sdk="Microsoft.NET.Sdk" />\n',
    );
    await writeFixture(root, "testdata/Example/Example.cs", "public sealed class Example {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const ownedFiles = result.features.flatMap((feature) =>
      feature.ownedFiles.map((file) => file.path),
    );

    expect(titles).toContain(".NET project App");
    expect(titles).not.toContain(".NET project Sample");
    expect(titles).not.toContain(".NET project Example");
    expect(ownedFiles).not.toContain("fixtures/Sample/Sample.cs");
    expect(ownedFiles).not.toContain("testdata/Example/Example.cs");
  });

  it.each([
    {
      name: "Go",
      manifest: ["go.mod", "module example.com/go-app\n"],
      source: ["main.go", "package main\nfunc main() {}\n"],
    },
    {
      name: "Python",
      manifest: ["pyproject.toml", "[project]\nname = 'python-app'\nversion = '1.0.0'\n"],
      source: ["src/app.py", "def main(): pass\n"],
    },
  ] as const)(
    "skips Node project and Turbo I/O for pure $name projects",
    async ({ manifest, source }) => {
      const root = await fixtureRoot("clawpatch-map-node-coupling-");
      await writeFixture(root, manifest[0], manifest[1]);
      await writeFixture(root, source[0], source[1]);
      const projectsSpy = vi.spyOn(projectsModule, "discoverNodeProjects");
      const taskGraphSpy = vi.spyOn(turboModule, "turboTaskGraph");

      const project = await detectProject(root);
      await mapFeatures(root, project, []);

      expect(projectsSpy).not.toHaveBeenCalled();
      expect(taskGraphSpy).not.toHaveBeenCalled();
    },
  );
});
