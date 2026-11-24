import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EMPTY = createHash("sha256").update("").digest("hex");

let credentials = null;

async function access() {
  if (credentials) return credentials;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.REGISTRY_BUCKET || "misty-registry";
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed to reach the bucket");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.result?.id || body.result.status !== "active") {
    throw new Error(
      `the Cloudflare token isn't an active account token (${response.status}); save the token value R2 showed, not its access key`,
    );
  }
  credentials = {
    bucket,
    endpoint: `https://${account}.r2.cloudflarestorage.com/${bucket}`,
    user: `${body.result.id}:${createHash("sha256").update(token).digest("hex")}`,
  };
  return credentials;
}

function curl(args, user) {
  return execFileSync("curl", ["--silent", "--show-error", "--aws-sigv4", "aws:amz:auto:s3", "-K", "-", ...args], {
    input: `user = "${user}"\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
}

const keyPath = (key) => key.split("/").map(encodeURIComponent).join("/");

export async function r2Get(key) {
  const { endpoint, user, bucket } = await access();
  const output = curl(
    ["-H", `x-amz-content-sha256: ${EMPTY}`, "-w", "\n%{http_code}", `${endpoint}/${keyPath(key)}`],
    user,
  );
  const split = output.lastIndexOf(10);
  const status = Number(output.subarray(split + 1).toString());
  const body = output.subarray(0, split);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`${bucket}/${key} answered ${status}: ${body.toString().slice(0, 300)}`);
  return body;
}

/** Whether the bucket holds `key`, asking for its headers only, so a large object isn't downloaded to find out. */
export async function r2Head(key) {
  const { endpoint, user, bucket } = await access();
  const output = curl(
    ["--head", "-o", "/dev/null", "-H", `x-amz-content-sha256: ${EMPTY}`, "-w", "%{http_code}", `${endpoint}/${keyPath(key)}`],
    user,
  ).toString();
  const status = Number(output.trim().slice(-3));
  if (status === 404) return false;
  if (status !== 200) throw new Error(`${bucket}/${key} answered ${status}`);
  return true;
}

export async function r2Put(key, file, type, cacheControl) {
  const { endpoint, user, bucket } = await access();
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const output = curl(
    [
      "--upload-file",
      file,
      "-H",
      `x-amz-content-sha256: ${sha}`,
      "-H",
      `content-type: ${type}`,
      "-H",
      `cache-control: ${cacheControl}`,
      "-w",
      "\n%{http_code}",
      `${endpoint}/${keyPath(key)}`,
    ],
    user,
  ).toString();
  const status = Number(output.slice(output.lastIndexOf("\n") + 1));
  if (status !== 200) throw new Error(`putting ${bucket}/${key} answered ${status}: ${output.slice(0, 300)}`);
}

/** Every key in the bucket that starts with `prefix`, a thousand to a question (S3's ListObjectsV2). */
export async function r2List(prefix) {
  const { endpoint, user, bucket } = await access();
  const keys = [];
  let token = "";
  for (;;) {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const output = curl(["-H", `x-amz-content-sha256: ${EMPTY}`, "-w", "\n%{http_code}", `${endpoint}?${query}`], user).toString();
    const split = output.lastIndexOf("\n");
    const status = Number(output.slice(split + 1));
    const body = output.slice(0, split);
    if (status !== 200) throw new Error(`listing ${bucket}/${prefix} answered ${status}: ${body.slice(0, 300)}`);
    for (const [, key] of body.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(key.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    token = /<IsTruncated>true<\/IsTruncated>/.test(body) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? "") : "";
    if (!token) return keys;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, key, file, type, cacheControl] = process.argv.slice(2);
  if (command !== "put" || !key || !file || !type || !cacheControl) {
    throw new Error("node scripts/r2.ts put <key> <file> <content-type> <cache-control>");
  }
  await r2Put(key, file, type, cacheControl);
  console.log(`${key} uploaded`);
}
