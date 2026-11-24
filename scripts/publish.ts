// Stamps the index with the time it is published and signs the exact bytes of its root with the registry's key. The root
// holds each shard's checksum, so one signature covers every listing.
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { built, write } from "./build.ts";

const pem = process.env.REGISTRY_SIGNING_KEY;
if (!pem) throw new Error("REGISTRY_SIGNING_KEY is not set: run scripts/keygen.ts once and keep its key as a secret.");
const kid = process.env.REGISTRY_KEY_ID || "misty-registry";
const root = new URL("../", import.meta.url);

const publishedAt = new Date().toISOString();
const body = write(built(), { published_at: publishedAt });
const signature = sign(null, Buffer.from(body), createPrivateKey(pem)).toString("base64url");

const site = new URL("site/", root);
mkdirSync(site, { recursive: true });
writeFileSync(new URL("index.min.json.sig", site), `${JSON.stringify({ kid, alg: "EdDSA", signature })}\n`);
writeFileSync(new URL("CNAME", site), "registry.mistysys.com\n");
console.log(`site/index.min.json signed with ${kid}, published ${publishedAt}`);
