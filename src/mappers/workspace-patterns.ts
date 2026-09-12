export function parsePnpmWorkspace(source: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*/u, "");
    if (/^\S/u.test(line)) {
      inPackages = /^packages\s*:/u.test(line);
    }
    if (!inPackages) {
      continue;
    }
    const match = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      patterns.push(match[1]);
    }
  }
  return patterns;
}

export function isExcludedWorkspace(packageRoot: string, excludes: string[]): boolean {
  return excludes.some((pattern) => workspacePatternMatches(pattern, packageRoot));
}

function workspacePatternMatches(pattern: string, packageRoot: string): boolean {
  return (
    pattern === packageRoot ||
    (hasWorkspaceGlob(pattern) && workspaceGlobMatches(pattern, packageRoot))
  );
}

function workspaceGlobMatches(pattern: string, packageRoot: string): boolean {
  return globSegmentsMatch(pattern.split("/"), packageRoot.split("/"));
}

function globSegmentsMatch(pattern: string[], candidate: string[]): boolean {
  const [segment, ...remainingPattern] = pattern;
  if (segment === undefined) {
    return candidate.length === 0;
  }
  if (segment === "**") {
    return (
      globSegmentsMatch(remainingPattern, candidate) ||
      (candidate.length > 0 && globSegmentsMatch(pattern, candidate.slice(1)))
    );
  }
  const [candidateSegment, ...remainingCandidate] = candidate;
  if (candidateSegment === undefined || !globSegmentRegExp(segment).test(candidateSegment)) {
    return false;
  }
  return globSegmentsMatch(remainingPattern, remainingCandidate);
}

export function hasWorkspaceGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

export function globSegmentRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
}
