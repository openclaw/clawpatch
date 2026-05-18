import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";

/**
 * Cross-repo context loader for dead-service detection.
 *
 * Loads context from two sources:
 * 1. Service Wiki (~/.hermes/skills/devops/service-wiki/) — markdown files with
 *    repo→service mapping, API endpoints, auth patterns, DB schemas
 * 2. Graphify (graphify-out/graph.json) — nodes representing API endpoints,
 *    DB tables, services; edges representing calls, references, shares_data_with
 *
 * Both sources are optional. If they don't exist, the module gracefully degrades
 * to no cross-repo context.
 */

export type EndpointCaller = {
  endpoint: string;
  callers: string[];
  confidence: "confirmed" | "suspected" | "none";
};

export type TableAccess = {
  table: string;
  writers: string[];
  readers: string[];
};

export type ServiceDependency = {
  service: string;
  dependsOn: string[];
  dependedBy: string[];
};

export type CrossRepoContext = {
  endpointCallers: EndpointCaller[];
  tableAccess: TableAccess[];
  serviceDependencies: ServiceDependency[];
  sources: string[];
};

type GraphifyNode = {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string | null;
  community?: number;
  norm_label?: string;
};

type GraphifyGraph = {
  nodes: GraphifyNode[];
  edges?: Array<{
    source: string;
    target: string;
    label?: string;
    type?: string;
  }>;
};

const EMPTY_CONTEXT: CrossRepoContext = {
  endpointCallers: [],
  tableAccess: [],
  serviceDependencies: [],
  sources: [],
};

/**
 * Load cross-repo context for the given repository.
 * Reads from service wiki and graphify data (if available).
 * Never throws — gracefully degrades to empty context.
 */
export async function loadCrossRepoContext(root: string): Promise<CrossRepoContext> {
  const endpointCallers: EndpointCaller[] = [];
  const tableAccess: TableAccess[] = [];
  const serviceDependencies: ServiceDependency[] = [];
  const sources: string[] = [];

  // Load from service wiki
  const wikiContext = await loadServiceWikiContext(root);
  if (wikiContext.loaded) {
    endpointCallers.push(...wikiContext.endpointCallers);
    tableAccess.push(...wikiContext.tableAccess);
    serviceDependencies.push(...wikiContext.serviceDependencies);
    sources.push("service-wiki");
  }

  // Load from graphify
  const graphifyContext = await loadGraphifyContext(root);
  if (graphifyContext.loaded) {
    // Merge graphify data — don't duplicate entries from wiki
    for (const ep of graphifyContext.endpointCallers) {
      const existing = endpointCallers.find((e) => e.endpoint === ep.endpoint);
      if (existing === undefined) {
        endpointCallers.push(ep);
      } else {
        // Merge callers (avoid duplicates)
        const mergedCallers = [...new Set([...existing.callers, ...ep.callers])];
        existing.callers = mergedCallers;
        // Upgrade confidence if either source confirms
        if (ep.confidence === "confirmed" || existing.confidence === "confirmed") {
          existing.confidence = "confirmed";
        }
      }
    }
    for (const ta of graphifyContext.tableAccess) {
      const existing = tableAccess.find((t) => t.table === ta.table);
      if (existing === undefined) {
        tableAccess.push(ta);
      } else {
        existing.writers = [...new Set([...existing.writers, ...ta.writers])];
        existing.readers = [...new Set([...existing.readers, ...ta.readers])];
      }
    }
    for (const dep of graphifyContext.serviceDependencies) {
      const existing = serviceDependencies.find((d) => d.service === dep.service);
      if (existing === undefined) {
        serviceDependencies.push(dep);
      } else {
        existing.dependsOn = [...new Set([...existing.dependsOn, ...dep.dependsOn])];
        existing.dependedBy = [...new Set([...existing.dependedBy, ...dep.dependedBy])];
      }
    }
    sources.push("graphify");
  }

  if (endpointCallers.length === 0 && tableAccess.length === 0 && serviceDependencies.length === 0) {
    return EMPTY_CONTEXT;
  }

  return { endpointCallers, tableAccess, serviceDependencies, sources };
}

/**
 * Format cross-repo context as a text block for injection into the review prompt.
 */
export function formatCrossRepoContext(context: CrossRepoContext): string {
  if (context.endpointCallers.length === 0 && context.tableAccess.length === 0 && context.serviceDependencies.length === 0) {
    return "";
  }

  const lines: string[] = ["Cross-repo context (sources: " + context.sources.join(", ") + "):"];

  for (const ep of context.endpointCallers) {
    const callerStr = ep.callers.length > 0 ? ep.callers.join(", ") : "(none found in scanned repos)";
    const confidenceStr = ep.confidence === "none" ? " [no caller found]" : ep.confidence === "confirmed" ? " [audited all known repos]" : "";
    lines.push(`- Endpoint: ${ep.endpoint}`);
    lines.push(`  Known callers: ${callerStr}${confidenceStr}`);
  }

  for (const ta of context.tableAccess) {
    const writerStr = ta.writers.length > 0 ? ta.writers.join(", ") : "(none found)";
    const readerStr = ta.readers.length > 0 ? ta.readers.join(", ") : "(none found)";
    lines.push(`- Table: ${ta.table}`);
    lines.push(`  Writers: ${writerStr}`);
    lines.push(`  Readers: ${readerStr}`);
  }

  for (const dep of context.serviceDependencies) {
    lines.push(`- Service: ${dep.service}`);
    if (dep.dependsOn.length > 0) {
      lines.push(`  Depends on: ${dep.dependsOn.join(", ")}`);
    }
    if (dep.dependedBy.length > 0) {
      lines.push(`  Depended by: ${dep.dependedBy.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extract route patterns from feature records for cross-repo matching.
 */
export function featureRoutes(features: Array<{ route: string | null }>): string[] {
  const routes: string[] = [];
  for (const feature of features) {
    if (feature.route !== null && feature.route.length > 0) {
      routes.push(feature.route);
    }
  }
  return routes;
}

// --- Service Wiki Loader ---

type WikiContext = {
  loaded: boolean;
  endpointCallers: EndpointCaller[];
  tableAccess: TableAccess[];
  serviceDependencies: ServiceDependency[];
};

async function loadServiceWikiContext(root: string): Promise<WikiContext & { loaded: boolean }> {
  const wikiDir = join(homedir(), ".hermes", "skills", "devops", "service-wiki");
  if (!(await pathExists(wikiDir))) {
    return { loaded: false, endpointCallers: [], tableAccess: [], serviceDependencies: [] };
  }

  const refsDir = join(wikiDir, "references");
  const endpointCallers: EndpointCaller[] = [];
  const tableAccess: TableAccess[] = [];
  const serviceDependencies: ServiceDependency[] = [];

  // Parse repo-mapping.md for service dependencies
  const repoMapping = await readWikiFile(join(refsDir, "repo-mapping.md"));
  if (repoMapping !== null) {
    const deps = parseRepoMapping(repoMapping);
    serviceDependencies.push(...deps);
  }

  // Parse repo-service-mapping.md for additional context
  const repoServiceMapping = await readWikiFile(join(refsDir, "repo-service-mapping.md"));
  if (repoServiceMapping !== null) {
    const deps = parseRepoMapping(repoServiceMapping);
    // Merge with existing
    for (const dep of deps) {
      const existing = serviceDependencies.find((d) => d.service === dep.service);
      if (existing === undefined) {
        serviceDependencies.push(dep);
      } else {
        existing.dependsOn = [...new Set([...existing.dependsOn, ...dep.dependsOn])];
        existing.dependedBy = [...new Set([...existing.dependedBy, ...dep.dependedBy])];
      }
    }
  }

  // Parse data-source-quirks.md for DB access patterns
  const dataSourceQuirks = await readWikiFile(join(refsDir, "data-source-quirks.md"));
  if (dataSourceQuirks !== null) {
    const tables = parseDataSourceQuirks(dataSourceQuirks);
    tableAccess.push(...tables);
  }

  // Try to find a wiki page for this specific repo
  const repoWikiPage = await findRepoWikiPage(root, wikiDir);
  if (repoWikiPage !== null) {
    const endpoints = parseWikiEndpoints(repoWikiPage);
    endpointCallers.push(...endpoints);
    const tables = parseWikiTables(repoWikiPage);
    tableAccess.push(...tables);
  }

  return {
    loaded: endpointCallers.length > 0 || tableAccess.length > 0 || serviceDependencies.length > 0,
    endpointCallers,
    tableAccess,
    serviceDependencies,
  };
}

async function readWikiFile(path: string): Promise<string | null> {
  if (!(await pathExists(path))) {
    return null;
  }
  return readFile(path, "utf8").catch(() => null);
}

/**
 * Parse repo-mapping markdown for service→repo relationships.
 * Extracts from pipe-delimited tables like:
 * | `team-telnyx/quote-generator` | `wiki/quote-generator.md` | Python/FastAPI |
 */
function parseRepoMapping(source: string): ServiceDependency[] {
  const deps: ServiceDependency[] = [];
  const repoPattern = /`([^`]+\/[^`]+)`/gu;
  const repos: string[] = [];

  for (const match of source.matchAll(repoPattern)) {
    const repo = match[1];
    if (repo !== undefined && !repo.startsWith("aaronjo")) {
      repos.push(repo);
    }
  }

  // Build a basic dependency map — each repo in the same section is a related service
  for (const repo of repos) {
    const serviceName = repo.split("/").at(-1) ?? repo;
    deps.push({
      service: serviceName,
      dependsOn: [],
      dependedBy: [],
    });
  }

  return deps;
}

/**
 * Parse data-source-quirks.md for DB table access patterns.
 * Looks for table references in the format "table_name" or schema.table_name.
 */
function parseDataSourceQuirks(source: string): TableAccess[] {
  const tables: TableAccess[] = [];
  const tablePattern = /(?:table[s]?\s+(?:named\s+)?|FROM\s+|INSERT\s+INTO\s+|UPDATE\s+)([`"]?)(\w+(?:\.\w+)?)(?:\1)/giu;

  const seenTables = new Set<string>();
  for (const match of source.matchAll(tablePattern)) {
    const tableName = match[2];
    if (tableName === undefined || seenTables.has(tableName)) {
      continue;
    }
    seenTables.add(tableName);
    tables.push({
      table: tableName,
      writers: [],
      readers: [],
    });
  }

  return tables;
}

/**
 * Find the wiki page corresponding to the given repo.
 */
async function findRepoWikiPage(root: string, wikiDir: string): Promise<string | null> {
  // Try to determine the repo name from the directory
  const dirName = root.split("/").at(-1) ?? "";

  // Map of common directory names to wiki page names
  const wikiPageCandidates = [
    join(wikiDir, "references", `${dirName}.md`),
    // Try kebab-case
    join(wikiDir, "references", `${dirName.replace(/_/g, "-")}.md`),
  ];

  for (const candidate of wikiPageCandidates) {
    if (await pathExists(candidate)) {
      return readFile(candidate, "utf8").catch(() => null);
    }
  }

  return null;
}

/**
 * Parse endpoint references from a wiki page.
 * Looks for HTTP method + path patterns like: GET /api/v1/quotes
 */
function parseWikiEndpoints(source: string): EndpointCaller[] {
  const endpoints: EndpointCaller[] = [];
  // Match patterns like "GET /path", "POST /path", or full URLs
  const endpointPattern = /(?:^|\s)(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s,<")\]]+)/gimu;
  const seen = new Set<string>();

  for (const match of source.matchAll(endpointPattern)) {
    const method = match[1];
    const path = match[2];
    if (method === undefined || path === undefined) {
      continue;
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    // Try to find callers in the surrounding context
    const callers = findCallersInContext(source, key);

    endpoints.push({
      endpoint: key,
      callers,
      confidence: callers.length > 0 ? "suspected" : "none",
    });
  }

  return endpoints;
}

/**
 * Try to find callers of an endpoint in the wiki page text.
 */
function findCallersInContext(source: string, endpoint: string): string[] {
  const callers: string[] = [];
  // Look for patterns like "called by X", "consumed by X", "X calls this"
  const callerPattern = /(?:called by|consumed by|called from|invoked by|used by)\s+([^\n,.]+)/giu;
  for (const match of source.matchAll(callerPattern)) {
    const caller = match[1]?.trim();
    if (caller !== undefined && caller.length > 0) {
      callers.push(caller);
    }
  }
  return callers;
}

/**
 * Parse DB table references from a wiki page.
 */
function parseWikiTables(source: string): TableAccess[] {
  const tables: TableAccess[] = [];
  // Match table names: backtick-quoted identifiers or schema.table patterns
  const tablePattern = /`(\w+(?:_\w+)*)`/gu;
  const seen = new Set<string>();

  for (const match of source.matchAll(tablePattern)) {
    const name = match[1];
    if (name === undefined || seen.has(name) || name.length < 3) {
      continue;
    }
    // Heuristic: likely a table name if it contains underscores and doesn't look like a code variable
    if (name.includes("_") && !/^(GET|POST|PUT|DELETE|PATCH|test|spec|import|from|def|class|return|async|await)$/i.test(name)) {
      seen.add(name);
      // Try to find writers/readers in context
      const writers = findTableWriters(source, name);
      const readers = findTableReaders(source, name);
      tables.push({ table: name, writers, readers });
    }
  }

  return tables;
}

function findTableWriters(source: string, tableName: string): string[] {
  const writers: string[] = [];
  const writerPattern = new RegExp(
    `(?:writes? to|populate[sd]?|insert[sd]? into|upsert[sd]? into|updates?)\\s+(?:the\\s+)?(?:\`)?${escapeRegex(tableName)}(?:\`)?`,
    "giu",
  );
  for (const match of source.matchAll(writerPattern)) {
    // Look for the subject of the sentence
    const before = source.slice(Math.max(0, (match.index ?? 0) - 80), match.index);
    const subject = /([A-Za-z_][-A-Za-z0-9_ ]+)\s+(?:DAG|dag|cron|pipeline|job|process)/u.exec(before)?.[1]?.trim();
    if (subject !== undefined) {
      writers.push(subject.trim());
    }
  }
  return writers;
}

function findTableReaders(source: string, tableName: string): string[] {
  const readers: string[] = [];
  const readerPattern = new RegExp(
    `(?:reads? from|quer(?:y|ies|ied)|select[sd]? from|consumes? data from)\\s+(?:the\\s+)?(?:\`)?${escapeRegex(tableName)}(?:\`)?`,
    "giu",
  );
  for (const match of source.matchAll(readerPattern)) {
    const before = source.slice(Math.max(0, (match.index ?? 0) - 80), match.index);
    const subject = /([A-Za-z_][-A-Za-z0-9_ ]+)\s+(?:endpoint|service|client|route)/u.exec(before)?.[1]?.trim();
    if (subject !== undefined) {
      readers.push(subject.trim());
    }
  }
  return readers;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// --- Graphify Loader ---

type GraphifyContext = {
  loaded: boolean;
  endpointCallers: EndpointCaller[];
  tableAccess: TableAccess[];
  serviceDependencies: ServiceDependency[];
};

async function loadGraphifyContext(root: string): Promise<GraphifyContext> {
  // Try loading from the repo's graphify-out directory first
  const graphPaths = [
    join(root, "graphify-out", "graph.json"),
    // Also try the workspace-level graph
    join(homedir(), ".hermes", "workspace", "memory", "service-wiki", "graphify-out", "graph.json"),
    join(homedir(), ".hermes", "workspace", "memory", "graphify-out", "graph.json"),
  ];

  let graph: GraphifyGraph | null = null;
  let graphSource: string | null = null;

  for (const graphPath of graphPaths) {
    if (await pathExists(graphPath)) {
      const raw = await readFile(graphPath, "utf8").catch(() => null);
      if (raw !== null) {
        try {
          graph = JSON.parse(raw) as GraphifyGraph;
          graphSource = graphPath;
          break;
        } catch {
          // Invalid JSON, skip
        }
      }
    }
  }

  if (graph === null) {
    return { loaded: false, endpointCallers: [], tableAccess: [], serviceDependencies: [] };
  }

  const endpointCallers: EndpointCaller[] = [];
  const tableAccess: TableAccess[] = [];
  const serviceDependencies: ServiceDependency[] = [];

  // Extract API endpoint nodes
  const endpointNodes = (graph.nodes ?? []).filter(
    (node) =>
      node.label !== undefined &&
      (/^(GET|POST|PUT|DELETE|PATCH)\s+\//iu.test(node.label) ||
        /endpoint|route|api/iu.test(node.label)),
  );

  for (const node of endpointNodes) {
    const callers = findCallersFromEdges(graph, node.id);
    endpointCallers.push({
      endpoint: node.label,
      callers,
      confidence: callers.length > 0 ? "suspected" : "none",
    });
  }

  // Extract DB table nodes
  const tableNodes = (graph.nodes ?? []).filter(
    (node) =>
      node.label !== undefined &&
      (/table[:\s]/iu.test(node.label) ||
        /_(?:table|cache|repo)$/iu.test(node.label) ||
        /margins|quotes|rate_decks|sales_hierarchy|cost_codes/iu.test(node.label)),
  );

  for (const node of tableNodes) {
    const writers = findWritersFromEdges(graph, node.id);
    const readers = findReadersFromEdges(graph, node.id);
    tableAccess.push({
      table: node.label,
      writers,
      readers,
    });
  }

  // Extract service dependency nodes
  const serviceNodes = (graph.nodes ?? []).filter(
    (node) =>
      node.label !== undefined &&
      node.file_type === "document" &&
      /wiki/iu.test(node.source_file ?? ""),
  );

  // Build service dependencies from edges
  for (const node of serviceNodes) {
    const dependsOn = (graph.edges ?? [])
      .filter((edge) => edge.source === node.id)
      .map((edge) => {
        const target = graph?.nodes?.find((n) => n.id === edge.target);
        return target?.label ?? edge.target;
      });

    const dependedBy = (graph.edges ?? [])
      .filter((edge) => edge.target === node.id)
      .map((edge) => {
        const source = graph?.nodes?.find((n) => n.id === edge.source);
        return source?.label ?? edge.source;
      });

    if (dependsOn.length > 0 || dependedBy.length > 0) {
      serviceDependencies.push({
        service: node.label,
        dependsOn,
        dependedBy,
      });
    }
  }

  // If graph has no edges (common for markdown-only graphs), extract what we can from node labels
  if ((graph.edges ?? []).length === 0) {
    // Use community groupings as a weak signal of related services
    const communities = new Map<number, string[]>();
    for (const node of graph.nodes ?? []) {
      if (node.community !== undefined) {
        const members = communities.get(node.community) ?? [];
        members.push(node.label);
        communities.set(node.community, members);
      }
    }
    // Communities with margin-related nodes indicate related services
    for (const [, members] of communities) {
      const hasMarginNode = members.some(
        (m) => /margin/iu.test(m),
      );
      if (hasMarginNode && members.length > 1) {
        // These nodes are in the same community — likely related
        for (const member of members) {
          if (/margin/iu.test(member)) {
            tableAccess.push({
              table: member,
              writers: members.filter((m) => m !== member && /dag|airflow|cron/iu.test(m)),
              readers: members.filter((m) => m !== member && /endpoint|route|api|service/iu.test(m)),
            });
          }
        }
      }
    }
  }

  return {
    loaded: endpointCallers.length > 0 || tableAccess.length > 0 || serviceDependencies.length > 0,
    endpointCallers,
    tableAccess,
    serviceDependencies,
  };
}

function findCallersFromEdges(graph: GraphifyGraph, nodeId: string): string[] {
  const callers: string[] = [];
  for (const edge of graph.edges ?? []) {
    if (edge.target === nodeId) {
      const sourceNode = graph.nodes?.find((n) => n.id === edge.source);
      callers.push(sourceNode?.label ?? edge.source);
    }
  }
  return callers;
}

function findWritersFromEdges(graph: GraphifyGraph, nodeId: string): string[] {
  const writers: string[] = [];
  for (const edge of graph.edges ?? []) {
    if (edge.target === nodeId && /writes?|populates?|inserts?|upsert/iu.test(edge.label ?? "")) {
      const sourceNode = graph.nodes?.find((n) => n.id === edge.source);
      writers.push(sourceNode?.label ?? edge.source);
    }
  }
  return writers;
}

function findReadersFromEdges(graph: GraphifyGraph, nodeId: string): string[] {
  const readers: string[] = [];
  for (const edge of graph.edges ?? []) {
    if (edge.source === nodeId && /reads?|queries?|consumes?/iu.test(edge.label ?? "")) {
      const targetNode = graph.nodes?.find((n) => n.id === edge.target);
      readers.push(targetNode?.label ?? edge.target);
    }
  }
  return readers;
}
