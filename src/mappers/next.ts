import { join } from "node:path";
import { readPackageJson } from "../detect.js";
import { pathExists } from "../fs.js";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

export async function nextSeeds(root: string): Promise<FeatureSeed[]> {
  const prefixes = (await isNextProject(root))
    ? ["app", "pages", "src/app", "src/pages"]
    : ["app", "pages"];
  const files = await walk(root, prefixes);
  const routeFiles = files.filter(
    (file) =>
      /(^|\/)(page|route)\.(tsx|ts|jsx|js)$/u.test(file) ||
      /^(src\/)?pages\/.+\.(tsx|ts|jsx|js)$/u.test(file),
  );
  return routeFiles.map((file) => ({
    title: `Route ${routeFromFile(file)}`,
    summary: `Web route implemented by ${file}.`,
    kind: "route",
    source: isAppRoute(file) ? "next-app-route" : "next-pages-route",
    confidence: "high",
    entryPath: file,
    symbol: null,
    route: routeFromFile(file),
    command: null,
    tags: ["next", "web"],
    trustBoundaries: ["user-input", "network", "serialization"],
  }));
}

function isAppRoute(file: string): boolean {
  return file.startsWith("app/") || file.startsWith("src/app/");
}

async function isNextProject(root: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  if (
    dependencyFieldHas(pkg?.dependencies, "next") ||
    dependencyFieldHas(pkg?.devDependencies, "next")
  ) {
    return true;
  }
  for (const file of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (await pathExists(join(root, file))) {
      return true;
    }
  }
  return false;
}

function dependencyFieldHas(field: unknown, name: string): boolean {
  return typeof field === "object" && field !== null && Object.hasOwn(field, name);
}

function routeFromFile(file: string): string {
  let route = file
    .replace(/^src\//u, "")
    .replace(/^app\//u, "/")
    .replace(/^pages\//u, "/")
    .replace(/\/(page|route)\.[^.]+$/u, "")
    .replace(/\.[^.]+$/u, "")
    .replace(/\/index$/u, "")
    .replace(/\[(.+?)\]/gu, ":$1");
  if (route === "") {
    route = "/";
  }
  return route;
}
