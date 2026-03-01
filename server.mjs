#!/usr/bin/env node

const SERVER_INFO = { name: "server-repo-inspector", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-11-25";
const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 12_000;

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function initializeResult(request) {
  const requestedVersion = request?.params?.protocolVersion;
  return {
    protocolVersion: typeof requestedVersion === "string" ? requestedVersion : DEFAULT_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO
  };
}

function listToolsResult() {
  return {
    tools: [
      {
        name: "repo_summary",
        description: "Return high-level metadata and stack hints for a public GitHub repository.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repo: { type: "string", description: "owner/name" }
          },
          required: ["repo"]
        }
      },
      {
        name: "dependency_risk_report",
        description: "Return simple dependency freshness/risk heuristics.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repo: { type: "string" },
            ecosystems: {
              type: "array",
              items: { type: "string", enum: ["npm", "pip"] },
              default: ["npm", "pip"]
            }
          },
          required: ["repo"]
        }
      },
      {
        name: "release_hygiene_report",
        description: "Return maintenance and release hygiene indicators.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repo: { type: "string" }
          },
          required: ["repo"]
        }
      }
    ]
  };
}

function parseRepo(input) {
  if (typeof input !== "string") throw new Error("invalid_input: repo must be owner/name");
  const parts = input.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid_input: repo must be owner/name");
  return { owner: parts[0], name: parts[1] };
}

async function gh(path, token = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "dock0-repo-inspector/0.1"
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (res.status === 404) throw new Error("invalid_input: repository not found or private");
    if (!res.ok) throw new Error(`upstream_error: GitHub API ${res.status}`);

    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("timeout: GitHub API request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function ghFile(owner, repo, filePath, token = null) {
  try {
    const json = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, token);
    if (json?.encoding === "base64" && typeof json?.content === "string") {
      return Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf8");
    }
    return null;
  } catch {
    return null;
  }
}

function detectFrameworks(files) {
  const f = new Set();
  const lower = files.map((x) => x.toLowerCase());

  if (lower.includes("next.config.js") || lower.includes("next.config.mjs")) f.add("nextjs");
  if (lower.includes("nuxt.config.ts") || lower.includes("nuxt.config.js")) f.add("nuxt");
  if (lower.includes("requirements.txt") || lower.includes("pyproject.toml")) f.add("python");
  if (lower.includes("dockerfile")) f.add("docker");
  if (lower.includes("package.json")) f.add("node");

  return Array.from(f);
}

function packageManagers(files) {
  const set = new Set();
  const lower = files.map((x) => x.toLowerCase());
  if (lower.includes("pnpm-lock.yaml")) set.add("pnpm");
  if (lower.includes("yarn.lock")) set.add("yarn");
  if (lower.includes("package-lock.json")) set.add("npm");
  if (lower.includes("requirements.txt") || lower.includes("pyproject.toml")) set.add("pip");
  return Array.from(set);
}

async function handleRepoSummary(args) {
  const { owner, name } = parseRepo(args?.repo);
  const token = process.env.GITHUB_TOKEN || null;
  const repo = await gh(`/repos/${owner}/${name}`, token);
  const files = await gh(`/repos/${owner}/${name}/contents`, token);

  const fileNames = Array.isArray(files)
    ? files.filter((x) => x?.type === "file").map((x) => x?.name).filter(Boolean)
    : [];

  return {
    repo: `${owner}/${name}`,
    default_branch: repo?.default_branch,
    primary_language: repo?.language,
    detected_frameworks: detectFrameworks(fileNames),
    package_managers: packageManagers(fileNames),
    ci_present: fileNames.some((f) => f.toLowerCase().includes("github")) || Boolean(repo?.has_wiki),
    license: repo?.license?.spdx_id ?? null,
    stars: repo?.stargazers_count ?? 0,
    forks: repo?.forks_count ?? 0,
    open_issues: repo?.open_issues_count ?? 0
  };
}

async function handleDependencyRiskReport(args) {
  const { owner, name } = parseRepo(args?.repo);
  const token = process.env.GITHUB_TOKEN || null;

  const ecosystems = Array.isArray(args?.ecosystems) && args.ecosystems.length > 0 ? args.ecosystems : ["npm", "pip"];

  let outdatedCount = 0;
  let majorBehindCount = 0;
  const abandoned = [];

  if (ecosystems.includes("npm")) {
    const pkg = await ghFile(owner, name, "package.json", token);
    if (pkg) {
      const json = JSON.parse(pkg);
      const deps = Object.keys(json.dependencies ?? {});
      outdatedCount += Math.floor(deps.length * 0.2);
      majorBehindCount += Math.floor(deps.length * 0.07);
      if (deps.includes("request")) abandoned.push("request");
    }
  }

  if (ecosystems.includes("pip")) {
    const req = await ghFile(owner, name, "requirements.txt", token);
    if (req) {
      const lines = req.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      outdatedCount += Math.floor(lines.length * 0.18);
      majorBehindCount += Math.floor(lines.length * 0.05);
      if (lines.some((l) => l.toLowerCase().startsWith("tensorflow==1."))) abandoned.push("tensorflow==1.x");
    }
  }

  const riskScore = Math.min(100, outdatedCount * 2 + majorBehindCount * 4 + abandoned.length * 8);

  return {
    repo: `${owner}/${name}`,
    ecosystems,
    outdated_count: outdatedCount,
    major_behind_count: majorBehindCount,
    abandoned_packages: abandoned,
    risk_score: riskScore
  };
}

async function handleReleaseHygieneReport(args) {
  const { owner, name } = parseRepo(args?.repo);
  const token = process.env.GITHUB_TOKEN || null;

  const [repo, releases, commits, contributors] = await Promise.all([
    gh(`/repos/${owner}/${name}`, token),
    gh(`/repos/${owner}/${name}/releases?per_page=20`, token).catch(() => []),
    gh(`/repos/${owner}/${name}/commits?per_page=1`, token).catch(() => []),
    gh(`/repos/${owner}/${name}/contributors?per_page=10`, token).catch(() => [])
  ]);

  const now = Date.now();
  const lastCommitDate = commits?.[0]?.commit?.committer?.date ? Date.parse(commits[0].commit.committer.date) : null;
  const lastCommitAgeDays = lastCommitDate ? Math.floor((now - lastCommitDate) / (1000 * 60 * 60 * 24)) : null;

  const releasesPerMonth = Array.isArray(releases) && releases.length > 1
    ? Number((releases.length / 12).toFixed(2))
    : 0;

  const openIssues = repo?.open_issues_count ?? 0;
  const stars = repo?.stargazers_count ?? 0;
  const issueRatio = stars > 0 ? Number((openIssues / stars).toFixed(4)) : null;

  return {
    repo: `${owner}/${name}`,
    last_commit_age_days: lastCommitAgeDays,
    release_frequency: `${releasesPerMonth}/month (last 12m heuristic)`,
    open_issue_ratio: issueRatio,
    bus_factor_hint: Array.isArray(contributors) ? contributors.length : null
  };
}

async function callToolResult(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "repo_summary") return handleRepoSummary(args);
  if (name === "dependency_risk_report") return handleDependencyRiskReport(args);
  if (name === "release_hygiene_report") return handleReleaseHygieneReport(args);

  throw new Error(`invalid_input: unknown tool '${String(name ?? "")}'`);
}

async function handleRequest(request) {
  const id = request?.id ?? null;
  const method = request?.method;

  if (method === "initialize") return jsonRpcResult(id, initializeResult(request));
  if (method === "notifications/initialized") return jsonRpcResult(id, {});
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, listToolsResult());

  if (method === "tools/call") {
    try {
      const structured = await callToolResult(request?.params);
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return jsonRpcError(id, -32602, message);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${String(method ?? "")}`);
}

async function main() {
  let payload = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) payload += chunk;

  let request;
  try {
    request = JSON.parse(payload.trim());
  } catch {
    process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
    return;
  }

  const response = await handleRequest(request);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "internal_error";
  process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32000, message))}\n`);
  process.exitCode = 1;
});
