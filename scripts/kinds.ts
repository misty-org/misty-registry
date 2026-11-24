// What the registry lists, in one place: the kinds of thing, the categories they sort under, and how copies of the
// same thing found in several repositories become one entry.

/** What Explore sorts by, the same for every kind of listing. */
export const CATEGORIES = [
  ["development", "Development"],
  ["design", "Design"],
  ["testing", "Testing"],
  ["security", "Security"],
  ["devops", "DevOps and cloud"],
  ["data", "Data"],
  ["writing", "Writing and docs"],
  ["marketing", "Marketing"],
  ["business", "Business"],
  ["research", "Research"],
  ["science", "Science and health"],
  ["media", "Media"],
  ["education", "Education"],
  ["productivity", "Productivity"],
  ["integration", "Integrations"],
  ["general", "General"],
] as const;

export const CATEGORY_IDS = new Set<string>(CATEGORIES.map(([id]) => id));

/**
 * The kinds of listing the crawls and the hand-written folders fill. Each is a shard of the index of its own, read
 * only when someone opens it. An app, an engine, a speech model and an ignore template have their own shapes and are
 * not listings.
 *
 * - plugins, skills, templates: files in a maker's repository, pinned at a commit, read from the sources.
 * - mcps: MCP servers, picked by hand (`mcps/<id>.json`): a hosted one reached at its address, one that runs from a
 *   package its maker published, or both.
 */
export const LISTINGS = ["plugins", "skills", "templates", "mcps"] as const;
export type Listing = (typeof LISTINGS)[number];

/** The most the root index and one shard may be, in bytes: past these a listing is split further, never read whole. */
export const MOST_ROOT_BYTES = 1 << 20;
export const MOST_SHARD_BYTES = 6 << 20;

/** The most other places one entry may name as having the same thing. */
export const MOST_ALSO = 8;

type Candidate = { entry: any; priority: number };

/**
 * One entry per thing: listings whose content digest matches are the same thing found twice, so the one from the
 * source with the lowest priority number stays and names the others in `also`. An entry with no digest, such as a
 * hand-written one, never merges.
 */
export function dedupe(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority || a.entry.id.localeCompare(b.entry.id));
  const first = new Map<string, any>();
  const where = (entry: any) => (entry.source ? { repo: entry.source.repo, path: entry.source.path } : { registry: entry.registry.name });
  const kept: any[] = [];
  for (const { entry } of sorted) {
    const winner = entry.digest ? first.get(entry.digest) : undefined;
    if (!winner) {
      const copy = { ...entry };
      if (copy.digest) first.set(copy.digest, copy);
      kept.push(copy);
      continue;
    }
    const other = where(entry);
    const also = winner.also ?? [];
    if (also.length < MOST_ALSO && !also.some((one: any) => JSON.stringify(one) === JSON.stringify(other))) {
      winner.also = [...also, other];
    }
  }
  return kept.sort((a, b) => a.id.localeCompare(b.id));
}
