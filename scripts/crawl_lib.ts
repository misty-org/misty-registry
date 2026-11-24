import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CATEGORY_IDS } from "./kinds.ts";
import { ID, LICENSES } from "./lib.ts";

/** The `---` block at the top of a Markdown file as plain key/values (a folded or literal value is joined on spaces). */
export function frontmatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const found = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!line) continue;
    let value = line[2].trim();
    if (value === "" || /^[>|][+-]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(" ");
    }
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    found[line[1]] = value;
  }
  return found;
}

/** The SPDX id of a license text this registry may carry, or null when it is another one or can't be told. */
export function detectLicense(text) {
  const t = String(text).replace(/\s+/g, " ");
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Mozilla Public License,? (Version |v\.? ?)2\.0/i.test(t)) return "MPL-2.0";
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return null;
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return null;
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|may be used to endorse/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(t)) return "ISC";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return "MIT";
  return null;
}

const LICENSE_FILE = /^(LICEN[SC]E|COPYING)(\.[A-Za-z]+)?$/i;
export const isLicenseFile = (name) => LICENSE_FILE.test(name);

/** A license named in a file's own front matter, only when it is exactly one this registry may carry. */
export const namedLicense = (value) => (LICENSES.has(value) ? value : null);

export const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** "frontend-design" reads as "Frontend design": sentence case, never the file's own slug. */
export function title(name) {
  const text = String(name).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text)) return text;
  const words = text.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One line cut at a word, never with an ellipsis. */
export function cut(text, most) {
  const one = String(text).replace(/\s+/g, " ").trim();
  if (one.length <= most) return one;
  const head = one.slice(0, most);
  const space = head.lastIndexOf(" ");
  return (space > most / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, "");
}

const RULES: [string, RegExp][] = [
  ["security", /secur|vulnerab|pentest|threat|crypto|owasp|malware|forensic/],
  ["testing", /\btest|\bqa\b|tdd|e2e|quality|playwright|cypress/],
  ["devops", /devops|deploy|kubernetes|docker|ci-?cd|infrastructure|terraform|cloud|\bsre\b|observab|monitoring|incident/],
  ["data", /\bdata|database|\bsql|analytics|\betl\b|warehouse|dashboard|spreadsheet|\bbi\b/],
  ["design", /design|\bux\b|\bui\b|figma|brand|visual|graphic|animation|canvas|theme|typograph/],
  ["marketing", /marketing|\bseo\b|growth|advertis|social media|copywrit|\bcro\b|campaign|\bads?\b/],
  ["business", /business|financ|sales|strategy|product manage|\bpm\b|legal|\bhr\b|recruit|project manage|operations|compliance|accounting/],
  ["science", /scien|biolog|chem|physic|medical|health|bioinformat|genom|clinical/],
  ["research", /research|academic|\bpaper|literature|citation/],
  ["media", /video|audio|music|image|photo|film|podcast|\b3d\b|\bgames?\b|gif|animation/],
  ["education", /teach|tutor|learn|course|education|lesson|student/],
  ["writing", /writ|editor|\bdocs?\b|documentation|blog|translat|content|\bnotes?\b|readme/],
  ["productivity", /productiv|obsidian|calendar|workflow|automation|email|\btasks?\b|planning/],
  ["integration", /\bmcp\b|integration|connector|slack|jira|notion|zapier|webhook|salesforce|hubspot/],
  ["development", /develop|\bcode|engineer|programming|software|backend|frontend|react|python|typescript|javascript|rust|\bgo\b|\bgit\b|github|\bapi\b|review|debug|refactor|architect|language/],
];

/**
 * The category a listing sorts under: the first rule that its folder names, else its name, else its description.
 * Always one of the registry's own categories, so the same thing is never filed under two spellings.
 */
const FOLDER_WORDS = /\b(plugins?|skills?|agents?|commands?|claude|codex|gemini|cursor|src|packages?|external|official|community|examples?|templates?|\.claude|\.github|\.codex|\.gemini|\.agents)\b/g;

export function categorize(...texts: string[]) {
  for (const [at, text] of texts.entries()) {
    const raw = String(text ?? "").toLowerCase();
    const lowered = at === 0 ? raw.replace(/[/_.-]+/g, " ").replace(FOLDER_WORDS, " ") : raw;
    for (const [id, rule] of RULES) if (rule.test(lowered)) return id;
  }
  return "general";
}

export const isCategory = (id: string) => CATEGORY_IDS.has(id);

/** What makes two copies of a skill or template the same thing: their text, with the spacing and line endings undone. */
export const digestOf = (text: string) =>
  createHash("sha256").update(String(text).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim()).digest("hex").slice(0, 32);

export const entryId = (source, name) => {
  const id = `${source}-${slug(name)}`;
  return ID.test(id) ? id : null;
};

const token = () => process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

/** The stars of GitHub repositories, a hundred to a question and a few questions at once, kept for three days beside the crawl. */
export async function starsOf(repos: string[], cachePath: string) {
  const cache: Record<string, { stars: number; at: number }> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const fresh = Date.now() - 3 * 24 * 3600 * 1000;
  const todo = [...new Set(repos)].filter((repo) => !(cache[repo]?.at > fresh));
  const groups: string[][] = [];
  for (let i = 0; i < todo.length; i += 100) groups.push(todo.slice(i, i + 100));
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const group = groups[next++];
      const query = `query{${group.map((repo, n) => { const [owner, name] = repo.split("/"); return `r${n}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){stargazerCount}`; }).join(" ")}}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "user-agent": "misty-registry-crawl" },
            body: JSON.stringify({ query }),
          });
          const data = (await response.json())?.data;
          if (!data) throw new Error("no data");
          group.forEach((repo, n) => (cache[repo] = { stars: data[`r${n}`]?.stargazerCount ?? 0, at: Date.now() }));
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 3000 * (attempt + 1)));
        }
      }
      if (next % 20 === 0) writeFileSync(cachePath, JSON.stringify(cache));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  writeFileSync(cachePath, JSON.stringify(cache));
  return (repo: string | null) => (repo ? cache[repo]?.stars ?? 0 : 0);
}
