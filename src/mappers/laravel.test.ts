import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
  it("detects and maps Laravel application slices", async () => {
    const root = await fixtureRoot("clawpatch-laravel-map-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/wault",
          type: "project",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "laravel/pint": "^1.0",
            "phpunit/phpunit": "^12.0",
          },
          scripts: {
            test: ["@php artisan config:clear --ansi", "@php artisan test"],
            "deploy:production:manual": "bash deploy/bin/deploy.sh",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "artisan", "#!/usr/bin/env php\n");
    await writeFixture(root, "phpunit.xml", "<phpunit />\n");
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\LandingPageController;\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/', LandingPageController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n" +
        "Route::resource('catalog', TrackController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/TrackController.php",
      "<?php\nnamespace App\\Http\\Controllers;\n" +
        "use App\\Http\\Requests\\StoreTrackRequest;\n" +
        "use App\\Services\\TrackUploadService;\n" +
        "final class TrackController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/LandingPageController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class LandingPageController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Requests/StoreTrackRequest.php",
      "<?php\nnamespace App\\Http\\Requests;\nfinal class StoreTrackRequest {}\n",
    );
    await writeFixture(
      root,
      "app/Services/TrackUploadService.php",
      "<?php\nnamespace App\\Services;\nfinal class TrackUploadService {}\n",
    );
    await writeFixture(
      root,
      "app/Jobs/RunSubmissionAnalysis.php",
      "<?php\nnamespace App\\Jobs;\nfinal class RunSubmissionAnalysis {}\n",
    );
    await writeFixture(
      root,
      "app/Console/Commands/ReleaseCut.php",
      "<?php\nnamespace App\\Console\\Commands;\nfinal class ReleaseCut { protected $signature = 'app:release-cut {version}'; }\n",
    );
    await writeFixture(
      root,
      "app/Console/Commands/ReportCatalogWatermarks.php",
      "<?php\nnamespace App\\Console\\Commands;\nuse Illuminate\\Console\\Attributes\\Signature;\n#[Signature('app:report-catalog-watermarks\n    {--json : Output JSON}')] final class ReportCatalogWatermarks {}\n",
    );
    await writeFixture(
      root,
      "app/Models/Track.php",
      "<?php\nnamespace App\\Models;\nfinal class Track {}\n",
    );
    await writeFixture(
      root,
      "database/migrations/2026_01_01_000000_create_tracks_table.php",
      "<?php\nreturn new class {};\n",
    );
    await writeFixture(
      root,
      "tests/Feature/TrackControllerTest.php",
      "<?php\nit('stores tracks', function () {});\n",
    );
    await writeFixture(
      root,
      "tests/Unit/TrackUploadServiceTest.php",
      "<?php\nit('uploads tracks', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const trackController = result.features.find(
      (feature) => feature.title === "Laravel controller TrackController",
    );
    const service = result.features.find(
      (feature) => feature.title === "Laravel service TrackUploadService",
    );

    expect(project.detected.languages).toContain("php");
    expect(project.detected.frameworks).toContain("laravel");
    expect(project.detected.packageManagers).toContain("composer");
    expect(project.detected.commands.test).toBe("composer test");
    expect(project.detected.commands.lint).toBe("vendor/bin/pint --test");
    expect(titles).toContain("Laravel project wault");
    expect(titles).toContain("Composer script test");
    expect(titles).toContain("Composer script deploy:production:manual");
    expect(titles).toContain("Laravel controller TrackController");
    expect(titles).toContain("Laravel controller LandingPageController");
    expect(titles).toContain("Laravel request StoreTrackRequest");
    expect(titles).toContain("Laravel command app:release-cut");
    expect(titles).toContain("Laravel command app:report-catalog-watermarks");
    expect(titles).toContain("Laravel job RunSubmissionAnalysis");
    expect(titles).toContain("Laravel service TrackUploadService");
    expect(titles).toContain("Laravel model Track");
    expect(titles).toContain("Laravel migrations database/migrations");
    expect(titles).toContain("Laravel test suite tests/Feature");
    expect(titles).toContain("Project config composer.json");
    expect(trackController?.entrypoints[0]?.route).toBe("/tracks");
    expect(trackController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
    expect(trackController?.contextFiles).toContainEqual({
      path: "app/Http/Requests/StoreTrackRequest.php",
      reason: "imported application class",
    });
    expect(trackController?.tests).toEqual([
      { path: "tests/Feature/TrackControllerTest.php", command: "composer test" },
    ]);
    expect(service?.tests).toEqual([
      { path: "tests/Unit/TrackUploadServiceTest.php", command: "composer test" },
    ]);
  });

  it("keeps Laravel routes scoped to same-basename controller namespaces", async () => {
    const root = await fixtureRoot("clawpatch-laravel-controller-namespaces-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/namespaced-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/admin.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Admin\\{UserController};\n" +
        "Route::prefix('admin')->middleware('auth')->get('/users', UserController::class);\n",
    );
    await writeFixture(
      root,
      "routes/api.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Api\\UserController;\n" +
        "Route::get('/users', UserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Admin/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Admin;\nfinal class UserController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const adminController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Admin/UserController.php",
    );
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(adminController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(adminController?.contextFiles).toContainEqual({
      path: "routes/admin.php",
      reason: "route definition",
    });
    expect(adminController?.contextFiles).not.toContainEqual({
      path: "routes/api.php",
      reason: "route definition",
    });
    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
    expect(apiController?.contextFiles).toContainEqual({
      path: "routes/api.php",
      reason: "route definition",
    });
    expect(apiController?.contextFiles).not.toContainEqual({
      path: "routes/admin.php",
      reason: "route definition",
    });
  });

  it("maps fully qualified Laravel controller route references", async () => {
    const root = await fixtureRoot("clawpatch-laravel-qualified-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/qualified-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "Route::get('/qualified', \\App\\Http\\Controllers\\QualifiedController::class);\n" +
        "Route::post('/qualified-array', [App\\Http\\Controllers\\ArrayQualifiedController::class, 'store']);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/QualifiedController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class QualifiedController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/ArrayQualifiedController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class ArrayQualifiedController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const qualifiedController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/QualifiedController.php",
    );
    const arrayQualifiedController = result.features.find(
      (feature) =>
        feature.entrypoints[0]?.path === "app/Http/Controllers/ArrayQualifiedController.php",
    );

    expect(qualifiedController?.entrypoints[0]?.route).toBe("/qualified");
    expect(qualifiedController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
    expect(arrayQualifiedController?.entrypoints[0]?.route).toBe("/qualified-array");
    expect(arrayQualifiedController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps aliased Laravel controller route imports", async () => {
    const root = await fixtureRoot("clawpatch-laravel-aliased-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/aliased-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Admin\\UserController as AdminUserController;\n" +
        "use App\\Http\\Controllers\\Api\\UserController as ApiUserController;\n" +
        "Route::get('/admin/users', AdminUserController::class);\n" +
        "Route::get('/api/users', ApiUserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Admin/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Admin;\nfinal class UserController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const adminController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Admin/UserController.php",
    );
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(adminController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
  });

  it("maps namespace-imported Laravel controller route references", async () => {
    const root = await fixtureRoot("clawpatch-laravel-namespace-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/namespace-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Api;\n" +
        "Route::get('/api/users', Api\\UserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
    expect(apiController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps parameterized Laravel fluent route prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-parameterized-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/parameterized-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\DashboardController;\n" +
        "Route::prefix('{tenant}')->get('/dashboard', DashboardController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/DashboardController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class DashboardController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const dashboard = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/DashboardController.php",
    );

    expect(dashboard?.entrypoints[0]?.route).toBe("/{tenant}/dashboard");
  });

  it("maps Laravel array-style route group prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-array-group-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/array-group-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        'Route::group(["prefix" => "admin"], function () {\n' +
        '    Route::get("/users", UserController::class);\n' +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users");
    expect(userController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps nested Laravel route groups inside array-style prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-nested-array-group-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/nested-array-group-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::group(['prefix' => 'admin'], function () {\n" +
        "    Route::controller(UserController::class)->group(function () {\n" +
        "        Route::get('/users', 'index');\n" +
        "    });\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users#index");
  });

  it("maps Laravel prefixes nested inside non-prefix array groups", async () => {
    const root = await fixtureRoot("clawpatch-laravel-non-prefix-array-group-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/non-prefix-array-group",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::group(['middleware' => 'auth'], function () {\n" +
        "    Route::group(['prefix' => 'admin'], function () {\n" +
        "        Route::get('/users', UserController::class);\n" +
        "    });\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users");
  });

  it("maps Laravel controller route groups", async () => {
    const root = await fixtureRoot("clawpatch-laravel-controller-groups-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/controller-groups",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::prefix('admin')->controller(UserController::class)->group(function () {\n" +
        "    Route::get('/users', 'index');\n" +
        "    Route::post('/users', 'store');\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users#index");
    expect(userController?.summary).toContain("POST /admin/users#store");
    expect(userController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("keeps Laravel controller feature IDs stable when first route changes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-stable-controller-id-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/stable-controller-id",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "app/Http/Controllers/TrackController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class TrackController {}\n",
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/tracks', TrackController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstController = first.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/TrackController.php",
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/catalog/tracks', TrackController::class);\n" +
        "Route::get('/tracks', TrackController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n",
    );

    const second = await mapFeatures(root, project, []);
    const secondController = second.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/TrackController.php",
    );

    expect(firstController?.featureId).toBeDefined();
    expect(secondController?.featureId).toBe(firstController?.featureId);
    expect(secondController?.entrypoints[0]?.route).toBe("/catalog/tracks");
  });

  it("ignores commented-out Laravel routes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-commented-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/commented-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\ArchiveController;\n" +
        "// Route::get('/old', ArchiveController::class);\n" +
        "/*\nRoute::get('/blocked', ArchiveController::class);\n*/\n" +
        "Route::get('/current', ArchiveController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/ArchiveController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class ArchiveController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const archiveController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/ArchiveController.php",
    );

    expect(archiveController?.entrypoints[0]?.route).toBe("/current");
    expect(archiveController?.summary).toContain("GET /current");
    expect(archiveController?.summary).not.toContain("/old");
    expect(archiveController?.summary).not.toContain("/blocked");
  });

  it("ignores commented-out Laravel command signatures", async () => {
    const root = await fixtureRoot("clawpatch-laravel-commented-command-signature-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/commented-command-signature",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "artisan", "#!/usr/bin/env php\n");
    await writeFixture(
      root,
      "app/Console/Commands/SyncCatalog.php",
      "<?php\nnamespace App\\Console\\Commands;\n" +
        "// protected $signature = 'app:old-sync';\n" +
        "/* #[Signature('app:blocked-sync')] */\n" +
        "final class SyncCatalog { protected $signature = 'app:sync-catalog {--force}'; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const command = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Console/Commands/SyncCatalog.php",
    );

    expect(titles).toContain("Laravel command app:sync-catalog");
    expect(titles).not.toContain("Laravel command app:old-sync");
    expect(titles).not.toContain("Laravel command app:blocked-sync");
    expect(command?.entrypoints[0]?.command).toBe("app:sync-catalog");
  });

  it("uses Composer validation scripts for PHP projects", async () => {
    const root = await fixtureRoot("clawpatch-php-composer-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/php-tool",
          require: {
            php: "^8.3",
          },
          scripts: {
            typecheck: "vendor/bin/phpstan analyse --level=max",
            analyse: "vendor/bin/phpstan analyse",
            lint: "vendor/bin/phpcs",
            format: "vendor/bin/php-cs-fixer fix --dry-run",
            test: "vendor/bin/phpunit",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "app/Service.php", "<?php\nfinal class Service {}\n");
    await writeFixture(root, "tests/LibTest.php", "<?php\nfinal class LibTest {}\n");
    await writeFixture(root, "tests/OtherTest.php", "<?php\nfinal class OtherTest {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const phpTestSuite = result.features.find((feature) =>
      feature.title.startsWith("PHP test suite tests"),
    );

    expect(project.detected.commands).toEqual({
      typecheck: "composer typecheck",
      lint: "composer lint",
      format: "composer format",
      test: "composer test",
    });
    expect(titles).toContain("Composer script test");
    expect(titles).toContain("Composer script typecheck");
    expect(phpTestSuite?.title).toBe("PHP test suite tests");
    expect(phpTestSuite?.tags).toEqual(["php", "test"]);
    expect(phpTestSuite?.tests.map((test) => test.path).toSorted()).toEqual([
      "tests/LibTest.php",
      "tests/OtherTest.php",
    ]);
    expect(titles).not.toContain("Laravel project php-tool");
  });

  it("uses PHPUnit for Laravel package projects without artisan", async () => {
    const root = await fixtureRoot("clawpatch-laravel-package-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/laravel-package",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "phpunit/phpunit": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "phpunit.xml", "<phpunit />\n");
    await writeFixture(root, "src/PackageServiceProvider.php", "<?php\nfinal class Provider {}\n");

    expect((await detectProject(root)).detected.commands.test).toBe("vendor/bin/phpunit");
  });

  it("uses Pest and PHPStan defaults for PHP packages", async () => {
    const root = await fixtureRoot("clawpatch-php-quality-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/php-quality",
          require: {
            php: "^8.3",
          },
          "require-dev": {
            "pestphp/pest": "^3.0",
            "phpstan/phpstan": "^2.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "src/PackageService.php", "<?php\nfinal class PackageService {}\n");
    await writeFixture(
      root,
      "tests/PackageServiceTest.php",
      "<?php\nit('works', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const phpTestSuite = result.features.find((feature) =>
      feature.title.startsWith("PHP test suite tests"),
    );

    expect(project.detected.commands).toMatchObject({
      typecheck: "vendor/bin/phpstan analyse",
      test: "vendor/bin/pest",
    });
    expect(phpTestSuite?.tests).toEqual([
      { path: "tests/PackageServiceTest.php", command: "vendor/bin/pest" },
    ]);
  });

  it("uses PHPUnit dependency test commands for Laravel package features", async () => {
    const root = await fixtureRoot("clawpatch-laravel-package-feature-tests-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/laravel-package-features",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "phpunit/phpunit": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "app/Http/Controllers/PackageController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class PackageController {}\n",
    );
    await writeFixture(
      root,
      "tests/Feature/PackageControllerTest.php",
      "<?php\nit('handles package routes', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const controller = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/PackageController.php",
    );

    expect(project.detected.commands.test).toBe("vendor/bin/phpunit");
    expect(controller?.tests).toEqual([
      { path: "tests/Feature/PackageControllerTest.php", command: "vendor/bin/phpunit" },
    ]);
  });
});
