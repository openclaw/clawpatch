export function shellQuotePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(path)) {
    return path;
  }
  if (platform === "win32") {
    return `"${path.replace(/%/gu, "^%").replace(/"/gu, '""')}"`;
  }
  return `"${path.replace(/(["\\$`])/gu, "\\$1")}"`;
}
