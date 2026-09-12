import { mkdir, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;

describe("mapFeatures", () => {
  it("maps Ruby metadata, executables, source groups, and tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(
      root,
      "fixture.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'fixture-ruby'\n  spec.add_dependency 'redis'\nend\n",
    );
    await writeFixture(root, "Rakefile", "task :default\n");
    await writeFixture(root, "exe/fixture", "#!/usr/bin/env ruby\nputs 'ok'\n");
    await writeFixture(root, "script/helper.rb", "#!/usr/bin/env ruby\nputs 'helper'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(
      root,
      "lib/fixture/client.rb",
      "module Fixture\n  class Client\n  end\nend\n",
    );
    for (let index = 0; index < 12; index += 1) {
      await writeFixture(
        root,
        `lib/fixture/type/type${String(index).padStart(2, "0")}.rb`,
        "module Fixture\nend\n",
      );
    }
    await writeFixture(root, "spec/fixture/client_spec.rb", "RSpec.describe Fixture::Client\n");
    await writeFixture(root, "vendor/bundle/ignored.rb", "module Ignored\nend\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rubyProject = result.features.find(
      (feature) => feature.title === "Ruby project fixture-ruby",
    );
    const cli = result.features.find((feature) => feature.title === "Ruby CLI command fixture");
    const source = result.features.find((feature) => feature.title === "Ruby source lib/fixture");

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
    expect(titles).toContain("Ruby project fixture-ruby");
    expect(titles).toContain("Ruby CLI command fixture");
    expect(titles).toContain("Ruby CLI command helper.rb");
    expect(titles).toContain("Ruby Rake tasks");
    expect(titles).toContain("Ruby source lib");
    expect(titles).toContain("Ruby source lib/fixture");
    expect(titles).toContain("Ruby source lib/fixture/type");
    expect(titles).toContain("Ruby test suite spec");
    expect(rubyProject?.ownedFiles).toContainEqual({
      path: "fixture.gemspec",
      reason: "ruby project metadata",
    });
    expect(rubyProject?.trustBoundaries).toEqual(
      expect.arrayContaining(["database", "network", "serialization"]),
    );
    expect(cli?.entrypoints[0]?.path).toBe("exe/fixture");
    expect(source?.ownedFiles.map((ref) => ref.path)).toContain("lib/fixture/client.rb");
    expect(source?.tests).toEqual([
      { path: "spec/fixture/client_spec.rb", command: "bundle exec rspec" },
    ]);
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((ref) => ref.path)),
    ).not.toContain("vendor/bundle/ignored.rb");
  });

  it("treats gems.rb projects as Bundler-backed", async () => {
    const root = await fixtureRoot("clawpatch-map-gems-rb-");
    await writeFixture(
      root,
      "gems.rb",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "spec/fixture_spec.rb", "RSpec.describe Fixture\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
  });

  it("detects RuboCop extension gems as Ruby lint providers", async () => {
    const root = await fixtureRoot("clawpatch-map-rubocop-extension-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rubocop-rails'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");

    const project = await detectProject(root);

    expect(project.detected.commands.lint).toBe("bundle exec rubocop");
  });

  it("does not treat Ruby test helpers as Minitest tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-test-helper-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/test_helper.rb", "module TestHelper\nend\n");
    await writeFixture(root, "lib/test_utils.rb", "module TestUtils\nend\n");
    await writeFixture(root, "test/test_helper.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const owned = result.features.flatMap((feature) => feature.ownedFiles.map((ref) => ref.path));

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.map((feature) => feature.title)).not.toContain("Ruby test suite test");
    expect(owned).toContain("lib/test_helper.rb");
    expect(owned).toContain("lib/test_utils.rb");
    expect(owned).not.toContain("test/test_helper.rb");
  });

  it("detects co-located Ruby Minitest suffix tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-colocated-minitest-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "lib/fixture_test.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Ruby source lib");

    expect(project.detected.commands.test).toBe("bundle exec rake test");
    expect(source?.tests).toEqual([
      { path: "lib/fixture_test.rb", command: "bundle exec rake test" },
    ]);
  });

  it("keeps test-prefixed Ruby sources under lib reviewable", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-test-prefixed-source-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/test_client.rb", "module TestClient\nend\n");
    await writeFixture(root, "test/test_client_test.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Ruby source lib");

    expect(project.detected.languages).toContain("ruby");
    expect(source?.ownedFiles.map((ref) => ref.path)).toContain("lib/test_client.rb");
    expect(source?.tests).toEqual([
      { path: "test/test_client_test.rb", command: "bundle exec rake test" },
    ]);
  });

  it("maps scripts directory Ruby files as source only", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-scripts-source-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "scripts/support.rb", "module Support\nend\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Ruby source scripts");
    expect(titles).not.toContain("Ruby CLI command support.rb");
  });

  it("ignores generated nested gemspec artifacts", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-generated-gemspec-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "node-only" }));
    await writeFixture(
      root,
      "dist/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'built-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "tmp/runtime.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'tmp-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "log/runtime.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'log-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "target/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'target-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      ".build/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'build-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.languages).not.toContain("ruby");
    expect(project.detected.frameworks).not.toContain("rails");
    expect(titles).not.toContain("Ruby project built-artifact");
    expect(titles).not.toContain("Ruby project tmp-artifact");
    expect(titles).not.toContain("Ruby project log-artifact");
    expect(titles).not.toContain("Ruby project target-artifact");
    expect(titles).not.toContain("Ruby project build-artifact");
    expect(nodeAsset?.title).toBe("Node source app");
  });

  it("ignores gemspec directories during Ruby dependency scans", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-gemspec-dir-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "gemspec-dir" }));
    await mkdir(join(root, "fake.gemspec"));
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.frameworks).not.toContain("rails");
    expect(nodeAsset?.title).toBe("Node source app");
  });

  it("does not apply nested Ruby gemspec dependencies to root Rails detection", async () => {
    const root = await fixtureRoot("clawpatch-map-nested-ruby-gemspec-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "mixed-root" }));
    await writeFixture(
      root,
      "engine/engine.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'engine'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(root, "engine/lib/engine.rb", "module Engine\nend\n");
    await writeFixture(root, "engine/test/test_engine.rb", "require 'minitest/autorun'\n");
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rubySource = result.features.find(
      (feature) => feature.title === "Ruby source engine/lib",
    );
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.frameworks).not.toContain("rails");
    expect(project.detected.commands.test).toBe("rake test");
    expect(titles).not.toContain("Rails application configuration");
    expect(titles).toContain("Ruby test suite engine/test");
    expect(rubySource?.tests).toEqual([
      { path: "engine/test/test_engine.rb", command: "rake test" },
    ]);
    expect(nodeAsset?.title).toBe("Node source app");
  });

  it("maps Gemfile-only Jekyll sites without mistaking dependencies for project names", async () => {
    const root = await fixtureRoot("clawpatch-map-jekyll-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'jekyll'\ngem 'jekyll-feed'\ngem 'hive-ruby'\n",
    );
    await writeFixture(root, "_config.yml", "title: Docs\n");
    await writeFixture(root, "index.md", "---\nlayout: home\n---\n");
    await writeFixture(root, "_layouts/default.html", "{{ content }}\n");
    await writeFixture(root, "_includes/header.html", "<header></header>\n");
    await writeFixture(root, "_sass/site.scss", "body { color: black; }\n");
    await writeFixture(root, "assets/main.scss", "---\n---\n@import 'site';\n");
    await writeFixture(root, "_posts/2021-01-01-one.md", "---\ntitle: One\n---\n");
    await writeFixture(root, "_posts/2022-01-01-two.md", "---\ntitle: Two\n---\n");
    await writeFixture(root, "_topics/ruby.md", "---\ntitle: Ruby\n---\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rootName = basename(root);
    const rubyProject = result.features.find(
      (feature) => feature.title === `Ruby project ${rootName}`,
    );
    const siteConfig = result.features.find(
      (feature) => feature.title === "Jekyll site configuration",
    );

    expect(project.detected.frameworks).toContain("jekyll");
    expect(titles).toContain(`Ruby project ${rootName}`);
    expect(titles).not.toContain("Ruby project jekyll");
    expect(titles).toContain("Jekyll site configuration");
    expect(titles).toContain("Jekyll theme _layouts");
    expect(titles).toContain("Jekyll theme _includes");
    expect(titles).toContain("Jekyll theme _sass");
    expect(titles).toContain("Jekyll content _posts/2021");
    expect(titles).toContain("Jekyll content _posts/2022");
    expect(titles).toContain("Jekyll content _topics");
    expect(rubyProject?.entrypoints[0]?.symbol).toBeNull();
    expect(siteConfig?.ownedFiles.map((ref) => ref.path)).toContain("index.md");
  });

  it("maps Rails app structure and skips common Rails binstubs", async () => {
    const root = await fixtureRoot("clawpatch-map-rails-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "rails-webpacker-shell", dependencies: { "@rails/ujs": "1.0.0" } }),
    );
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n");
    await writeFixture(root, "config/application.rb", "module FixtureRails\nend\n");
    await writeFixture(root, "config/routes.rb", "Rails.application.routes.draw do\nend\n");
    await writeFixture(root, "config/database.yml", "production:\n  password: secret\n");
    await writeFixture(root, "config/secrets.yml", "redacted: placeholder\n");
    await writeFixture(
      root,
      "config/environments/test.rb",
      "Rails.application.configure do\nend\n",
    );
    await writeFixture(
      root,
      "config/initializers/filter.rb",
      "Rails.application.config.filter_parameters += [:password]\n",
    );
    for (let index = 0; index < 14; index += 1) {
      await writeFixture(
        root,
        `config/initializers/initializer_${String(index).padStart(2, "0")}.rb`,
        "Rails.application.configure {}\n",
      );
    }
    await writeFixture(
      root,
      "config/initializers/secret_token.rb",
      "Rails.application.config.secret_token = 'secret'\n",
    );
    await writeFixture(root, "db/schema.rb", "ActiveRecord::Schema.define do\nend\n");
    await writeFixture(root, "db/structure.sql", "CREATE TABLE widgets (id bigint);\n");
    await writeFixture(
      root,
      "db/migrate/20200101000000_create_widgets.rb",
      "class CreateWidgets < ActiveRecord::Migration[6.1]\nend\n",
    );
    for (let index = 1; index < 14; index += 1) {
      await writeFixture(
        root,
        `db/migrate/202001010000${String(index).padStart(2, "0")}_create_widgets_${index}.rb`,
        "class CreateWidgets < ActiveRecord::Migration[6.1]\nend\n",
      );
    }
    await writeFixture(
      root,
      "bin/rails",
      "#!/usr/bin/env ruby\nAPP_PATH = '../config/application'\n",
    );
    await writeFixture(
      root,
      "app/controllers/widgets_controller.rb",
      "class WidgetsController < ApplicationController\nend\n",
    );
    await writeFixture(root, "app/models/widget.rb", "class Widget < ApplicationRecord\nend\n");
    await writeFixture(root, "app/views/widgets/index.html.haml", "%h1 Widgets\n");
    await writeFixture(root, "app/views/widgets/index.json.jbuilder", "json.widgets []\n");
    await writeFixture(root, "app/assets/javascripts/widgets.coffee", "console.log 'widgets'\n");
    await writeFixture(root, "app/assets/javascripts/admin.tsx", "export function Admin() {}\n");
    await writeFixture(root, "app/assets/builds/application.js", "console.log('built');\n");
    await writeFixture(root, "app/assets/stylesheets/widgets.scss", ".widgets { color: black; }\n");
    await writeFixture(
      root,
      "app/javascript/controllers/widgets_controller.js",
      "export function connect() {}\n",
    );
    await writeFixture(
      root,
      "app/javascript/stylesheets/application.scss",
      ".widgets { display: grid; }\n",
    );
    await writeFixture(
      root,
      "app/components/widget_component.ts",
      "export function wireWidgetComponent() {}\n",
    );
    await writeFixture(root, "src/client.ts", "export function client() {}\n");
    await writeFixture(root, "lib/client.ts", "export function libClient() {}\n");
    await writeFixture(root, "pages/home.tsx", "export function Home() { return null; }\n");
    await writeFixture(
      root,
      "test/controllers/widgets_controller_test.rb",
      "class WidgetsControllerTest\nend\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const referencedFiles = result.features.flatMap((feature) => [
      ...feature.ownedFiles.map((ref) => ref.path),
      ...feature.contextFiles.map((ref) => ref.path),
    ]);
    const rootName = basename(root);
    const rubyProject = result.features.find(
      (feature) => feature.title === `Ruby project ${rootName}`,
    );
    const nodePackage = result.features.find(
      (feature) => feature.title === "Node package rails-webpacker-shell",
    );
    const railsConfig = result.features.find(
      (feature) => feature.title === "Rails application configuration",
    );
    const railsDatabaseFeatures = result.features.filter(
      (feature) => feature.source === "rails-database",
    );
    const railsAssetRefs = result.features
      .filter((feature) => feature.source === "rails-assets")
      .flatMap((feature) => feature.ownedFiles.map((ref) => ref.path));

    expect(project.detected.frameworks).toContain("rails");
    expect(titles).not.toContain("Ruby CLI command rails");
    expect(titles).not.toContain("Node source app/assets");
    expect(titles).toContain("Node source app");
    expect(titles).toContain("Node source app/javascript");
    expect(titles).toContain("Node source src");
    expect(titles).toContain("Node source lib");
    expect(titles).toContain("Node source pages");
    expect(titles).toContain("Rails application configuration");
    expect(titles).toContain("Rails database schema and migrations");
    expect(titles).toContain("Rails database schema and migrations db/migrate#2");
    expect(titles).toContain("Rails views app/views");
    expect(titles).toContain("Rails assets app/assets");
    expect(railsDatabaseFeatures.every((feature) => feature.ownedFiles.length <= 12)).toBe(true);
    expect(referencedFiles).toContain("db/structure.sql");
    expect(referencedFiles).toContain("app/components/widget_component.ts");
    expect(railsAssetRefs).toContain("app/assets/javascripts/admin.tsx");
    expect(railsAssetRefs).toContain("app/javascript/stylesheets/application.scss");
    expect(railsAssetRefs).not.toContain("app/javascript/controllers/widgets_controller.js");
    expect(railsAssetRefs).not.toContain("app/assets/builds/application.js");
    expect(nodePackage?.contextFiles).toContainEqual({
      path: "app/javascript/controllers/widgets_controller.js",
      reason: "package source overview",
    });
    expect(rubyProject?.trustBoundaries).toEqual(
      expect.arrayContaining(["database", "network", "serialization"]),
    );
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).toContain("config/routes.rb");
    expect(railsConfig?.ownedFiles.slice(0, 12).map((ref) => ref.path)).toContain(
      "config/routes.rb",
    );
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain("config/secrets.yml");
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain("config/database.yml");
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain(
      "config/initializers/secret_token.rb",
    );
    expect(
      result.features.filter((feature) =>
        feature.ownedFiles.some(
          (ref) => ref.path === "app/javascript/controllers/widgets_controller.js",
        ),
      ),
    ).toHaveLength(1);
    expect(referencedFiles).not.toContain("config/database.yml");
    expect(referencedFiles).not.toContain("config/secrets.yml");
    expect(referencedFiles).not.toContain("config/initializers/secret_token.rb");
  });

  it("maps literal Rails route declarations", async () => {
    const root = await fixtureRoot("clawpatch-map-rails-routes-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n");
    await writeFixture(root, "config/application.rb", "module FixtureRailsRoutes\nend\n");
    await writeFixture(
      root,
      "config/routes.rb",
      [
        "get '/outside-before', to: 'outside#show'",
        "def helper_route",
        "  get '/helper-outside', to: 'outside#show'",
        "end",
        "Rails.application.routes.draw do",
        "  root 'home#index'",
        "  get '/admin/users', to: 'admin/users#index'",
        "  post '/sessions', 'sessions#create'",
        "  put '/profiles/:id', to: 'profiles#update'",
        "  patch '/accounts/:id', to: 'accounts#update'",
        "  delete '/sessions/:id', to: 'sessions#destroy'",
        "  get dynamic_path, to: 'ignored#index'",
        "  get '/wildcards/*path', to: 'files#show'",
        "  get '/shorthand'",
        "  namespace :admin do",
        "    get '/scoped-users', to: 'users#index'",
        "    [1].each do |item|",
        "      item.to_s",
        "    end",
        "    get '/leaked', to: 'leaked#index'",
        "    get '/do-not-enter', to: 'gates#show'",
        "  end",
        "  resources :posts do",
        "    get '/featured', to: 'posts#featured'",
        "    member do",
        "      get '/preview', to: 'posts#preview'",
        "    end",
        "  end",
        "  scope path: '/api' do",
        "    get '/health', to: 'health#show'",
        "  end",
        "  scope(path: '/brace') {",
        "    get '/brace-health', to: 'health#show'",
        "    token = /\\}/",
        "    get '/brace-leaked', to: 'leaked#index'",
        "  }",
        "  get '/constrained', to: 'constrained#index', constraints: {",
        "    subdomain: 'api'",
        "  }",
        "  get '/regex-constrained', to: 'regex#index', constraints: { token: /\\{/ }",
        "  get '/hash-rocket-regex', to: 'regex#index', constraints: { :token => /\\{/ }",
        "  get '/public', to: 'public#index'",
        "  constraints subdomain: 'api' do",
        "    get '/constraint-health', to: 'health#show'",
        "  end",
        "  match '/legacy', to: 'legacy#show', via: :get",
        "  resources :posts",
        "end",
        "get '/outside-after', to: 'outside#show'",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/controllers/home_controller.rb",
      "class HomeController < ApplicationController\nend\n",
    );
    await writeFixture(
      root,
      "app/controllers/admin/users_controller.rb",
      "module Admin\n  class UsersController < ApplicationController\n  end\nend\n",
    );
    await writeFixture(
      root,
      "app/controllers/sessions_controller.rb",
      "class SessionsController < ApplicationController\nend\n",
    );
    await writeFixture(
      root,
      "app/controllers/profiles_controller.rb",
      "class ProfilesController < ApplicationController\nend\n",
    );
    await writeFixture(
      root,
      "app/controllers/accounts_controller.rb",
      "class AccountsController < ApplicationController\nend\n",
    );
    await writeFixture(
      root,
      "test/controllers/sessions_controller_test.rb",
      "class SessionsControllerTest\nend\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rootRoute = result.features.find((feature) => feature.title === "Rails route GET /");
    const adminRoute = result.features.find(
      (feature) => feature.title === "Rails route GET /admin/users",
    );
    const sessionRoute = result.features.find(
      (feature) => feature.title === "Rails route POST /sessions",
    );
    const profileRoute = result.features.find(
      (feature) => feature.title === "Rails route PUT /profiles/:id",
    );
    const accountRoute = result.features.find(
      (feature) => feature.title === "Rails route PATCH /accounts/:id",
    );
    const deleteSessionRoute = result.features.find(
      (feature) => feature.title === "Rails route DELETE /sessions/:id",
    );
    const constrainedRoute = result.features.find(
      (feature) => feature.title === "Rails route GET /constrained",
    );
    const regexConstrainedRoute = result.features.find(
      (feature) => feature.title === "Rails route GET /regex-constrained",
    );
    const hashRocketRegexRoute = result.features.find(
      (feature) => feature.title === "Rails route GET /hash-rocket-regex",
    );

    expect(project.detected.frameworks).toContain("rails");
    expect(titles).toEqual(
      expect.arrayContaining([
        "Rails route GET /",
        "Rails route GET /admin/users",
        "Rails route POST /sessions",
        "Rails route PUT /profiles/:id",
        "Rails route PATCH /accounts/:id",
        "Rails route DELETE /sessions/:id",
        "Rails route GET /constrained",
        "Rails route GET /regex-constrained",
        "Rails route GET /hash-rocket-regex",
      ]),
    );
    expect(titles).not.toContain("Rails route GET /wildcards/*path");
    expect(titles).not.toContain("Rails route GET /shorthand");
    expect(titles).not.toContain("Rails route GET /scoped-users");
    expect(titles).not.toContain("Rails route GET /leaked");
    expect(titles).not.toContain("Rails route GET /do-not-enter");
    expect(titles).not.toContain("Rails route GET /featured");
    expect(titles).not.toContain("Rails route GET /preview");
    expect(titles).not.toContain("Rails route GET /health");
    expect(titles).not.toContain("Rails route GET /brace-health");
    expect(titles).not.toContain("Rails route GET /brace-leaked");
    expect(titles).not.toContain("Rails route GET /constraint-health");
    expect(titles).not.toContain("Rails route GET /legacy");
    expect(titles).not.toContain("Rails route GET /outside-before");
    expect(titles).not.toContain("Rails route GET /helper-outside");
    expect(titles).not.toContain("Rails route GET /outside-after");
    expect(titles).toContain("Rails route GET /public");
    expect(rootRoute?.source).toBe("rails-route");
    expect(rootRoute?.entrypoints[0]).toMatchObject({
      path: "app/controllers/home_controller.rb",
      symbol: "home#index",
      route: "GET /",
    });
    expect(adminRoute?.entrypoints[0]).toMatchObject({
      path: "app/controllers/admin/users_controller.rb",
      symbol: "admin/users#index",
      route: "GET /admin/users",
    });
    expect(adminRoute?.contextFiles).toContainEqual({
      path: "config/routes.rb",
      reason: "route definition",
    });
    expect(adminRoute?.trustBoundaries).toContain("auth");
    expect(sessionRoute?.entrypoints[0]?.route).toBe("POST /sessions");
    expect(sessionRoute?.tests).toEqual([
      { path: "test/controllers/sessions_controller_test.rb", command: "bundle exec rake test" },
    ]);
    expect(sessionRoute?.trustBoundaries).toContain("auth");
    expect(profileRoute?.entrypoints[0]?.route).toBe("PUT /profiles/:id");
    expect(accountRoute?.entrypoints[0]?.route).toBe("PATCH /accounts/:id");
    expect(deleteSessionRoute?.entrypoints[0]?.route).toBe("DELETE /sessions/:id");
    expect(constrainedRoute?.entrypoints[0]?.route).toBe("GET /constrained");
    expect(regexConstrainedRoute?.entrypoints[0]?.route).toBe("GET /regex-constrained");
    expect(hashRocketRegexRoute?.entrypoints[0]?.route).toBe("GET /hash-rocket-regex");
  });

  symlinkIt("keeps Rails route files and handlers inside the repository", async () => {
    const root = await fixtureRoot("clawpatch-map-rails-route-symlinks-");
    const external = await fixtureRoot("clawpatch-map-rails-route-external-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n");
    await writeFixture(root, "config/application.rb", "module FixtureRailsRouteSymlinks\nend\n");
    await writeFixture(
      external,
      "routes.rb",
      "Rails.application.routes.draw do\n  get '/external', to: 'external#show'\nend\n",
    );
    await symlink(join(external, "routes.rb"), join(root, "config/routes.rb"));

    const skippedProject = await detectProject(root);
    const skipped = await mapFeatures(root, skippedProject, []);
    expect(skipped.features.map((feature) => feature.title)).not.toContain(
      "Rails route GET /external",
    );

    const safeRoot = await fixtureRoot("clawpatch-map-rails-route-handler-symlink-");
    await writeFixture(safeRoot, "Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n");
    await writeFixture(
      safeRoot,
      "config/application.rb",
      "module FixtureRailsRouteHandlerSymlink\nend\n",
    );
    await writeFixture(
      safeRoot,
      "config/routes.rb",
      "Rails.application.routes.draw do\n  get '/unsafe', to: 'unsafe#show'\nend\n",
    );
    await mkdir(join(safeRoot, "app/controllers"), { recursive: true });
    await writeFixture(external, "unsafe_controller.rb", "class UnsafeController\nend\n");
    await symlink(
      join(external, "unsafe_controller.rb"),
      join(safeRoot, "app/controllers/unsafe_controller.rb"),
    );

    const project = await detectProject(safeRoot);
    const result = await mapFeatures(safeRoot, project, []);
    const route = result.features.find((feature) => feature.title === "Rails route GET /unsafe");
    expect(route?.entrypoints[0]).toMatchObject({
      path: "config/routes.rb",
      symbol: "unsafe#show",
      route: "GET /unsafe",
    });
    expect(route?.ownedFiles).toEqual([
      { path: "config/routes.rb", reason: "rails route declaration" },
    ]);
  });
});
