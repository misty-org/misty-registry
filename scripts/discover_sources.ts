// Finds repositories worth reading as sources: searches GitHub for skill, agent and plugin repositories with at least
// `--stars` stars, looks at each one's file tree, and keeps those that hold real SKILL.md folders, agent files or a
// plugin marketplace. It prints what it found; with --write it adds sources/<id>.json for each new one.
//   node scripts/discover_sources.ts [--stars 500] [--write]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "./crawl_lib.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const most = Number(args[args.indexOf("--stars") + 1]) || 500;
const write = args.includes("--write");
const TOPICS = [
  "agent-skills", "claude-skills", "claude-code-skills", "agent-skill", "skills", "codex-skills", "claude-code-plugins",
  "claude-code-plugin", "subagents", "claude-code-subagents", "claude-code-agents", "claude-code", "skill",
];

const gh = (...rest: string[]) => JSON.parse(execFileSync("gh", rest, { encoding: "utf8", maxBuffer: 64 << 20 }));

const found = new Map<string, { repo: string; stars: number; license: string | null }>();
for (const topic of TOPICS) {
  const page = gh("search", "repos", `--topic=${topic}`, "--sort", "stars", "--limit", "100", "--json", "fullName,stargazersCount,license");
  for (const one of page) {
    if (one.stargazersCount >= most) found.set(one.fullName, { repo: one.fullName, stars: one.stargazersCount, license: one.license?.key ?? null });
  }
}

const listed = new Set(
  readdirSync(join(root, "sources")).map((name) => JSON.parse(readFileSync(join(root, "sources", name), "utf8")).repo).filter(Boolean),
);

const results = [];
for (const candidate of [...found.values()].sort((a, b) => b.stars - a.stars)) {
  if (listed.has(candidate.repo)) continue;
  let tree;
  try {
    tree = gh("api", `repos/${candidate.repo}/git/trees/HEAD?recursive=1`).tree ?? [];
  } catch {
    continue;
  }
  const paths = tree.filter((item) => item.type === "blob").map((item) => item.path);
  const skills = paths.filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md")).length;
  const agents = paths.filter((path) => /(^|\/)agents\/[^/]+\.md$/.test(path) && !/README|CHANGELOG/i.test(path)).length;
  const marketplace = paths.includes(".claude-plugin/marketplace.json");
  if (!skills && !agents && !marketplace) continue;
  results.push({ ...candidate, skills, agents, marketplace });
}

for (const one of results) console.log(`${one.stars}\t${one.repo}\t${one.license ?? "none"}\tskills ${one.skills}\tagents ${one.agents}${one.marketplace ? "\tmarketplace" : ""}`);
console.log(`${results.length} new sources found from ${found.size} repositories with ${most}+ stars`);

if (write) {
  for (const one of results) {
    const id = slug(one.repo.replace("/", "-")).replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
    const file = join(root, "sources", `${id}.json`);
    if (existsSync(file)) continue;
    const source = {
      id,
      name: one.repo.split("/")[1],
      repo: one.repo,
      priority: 100,
      ...(one.marketplace ? { plugins: { index: ".claude-plugin/marketplace.json" } } : {}),
      ...(one.skills ? { skills: {} } : {}),
      ...(one.agents ? { templates: { match: "(^|/)agents/[^/]+\\.md$" } } : {}),
    };
    writeFileSync(file, `${JSON.stringify(source, null, 2)}\n`);
  }
  console.log("sources written");
}
