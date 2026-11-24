// Uploads the index's shards, which are named by their own checksum and so are put once and never replaced, then the
// root and its signature, last, so a Misty never reads a root whose shards aren't there yet.
//   node scripts/ship_index.ts
import { readdirSync } from "node:fs";
import { r2Get, r2Put } from "./r2.ts";

const site = new URL("../site/", import.meta.url);
for (const name of readdirSync(new URL("index/", site), { recursive: true }).map(String).filter((one) => one.endsWith(".json")).sort()) {
  const key = `index/${name}`;
  if (await r2Get(key)) {
    console.log(`${key} is hosted`);
    continue;
  }
  await r2Put(key, new URL(key, site).pathname, "application/json", "public, max-age=31536000, immutable");
  console.log(`${key} uploaded`);
}
await r2Put("index.min.json", new URL("index.min.json", site).pathname, "application/json", "public, max-age=300");
await r2Put("index.min.json.sig", new URL("index.min.json.sig", site).pathname, "application/json", "public, max-age=300");
console.log("index.min.json and its signature uploaded");
