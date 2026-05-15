import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

export async function nextSeeds(root: string): Promise<FeatureSeed[]> {
  const files = await walk(root, ["app", "pages", "src/app", "src/pages"]);
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
