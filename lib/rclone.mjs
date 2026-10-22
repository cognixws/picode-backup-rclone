// The rclone this version runs: downloaded once into the extension's data
// folder from rclone's GitHub release and checked against the SHA-256 rclone
// publishes, as the Cloudflare Tunnel extension does with cloudflared. A new
// rclone is a new version of this extension, reviewed like any other update.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

export const VERSION = "1.74.3";
export const ASSETS = {
  "linux-x64": { name: `rclone-v${VERSION}-linux-amd64.zip`, sha256: "dbee7ccd7a5d617e4ed4cd4555c16669b511abfe8d31164f61be35ac9e999bd2" },
  "linux-arm64": { name: `rclone-v${VERSION}-linux-arm64.zip`, sha256: "8f8d47446e061f80c3256659fe8e21f56d72d96aaefe1275d088ea5eb6b42aa7" },
  "darwin-x64": { name: `rclone-v${VERSION}-osx-amd64.zip`, sha256: "417cabd402d57806d597bd0ba8fb33a434ca8c2a1a5aa98de5a0bd4b52b39202" },
  "darwin-arm64": { name: `rclone-v${VERSION}-osx-arm64.zip`, sha256: "33a435ab17023b686918ce9a3975aceb75fe1796c694f38f1993024be1f063f5" },
  "win32-x64": { name: `rclone-v${VERSION}-windows-amd64.zip`, sha256: "ecb0ed9006e0d1a693757007716a11dab6c2cde6dac3f2fd87da962eaa73d11d" },
};
const ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export function assetFor(platform = process.platform, arch = process.arch) {
  return ASSETS[platform + "-" + arch] || null;
}

export function binaryPath(dataDir, platform = process.platform) {
  return join(dataDir, "bin", "rclone-" + VERSION + (platform === "win32" ? ".exe" : ""));
}

function fetchVerified(url, sha256, { redirects = 5, maxBytes = 80 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) { reject(new Error("download refused: " + u.hostname)); return; }
    const req = https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error("too many redirects")); return; }
        fetchVerified(new URL(res.headers.location, u).toString(), sha256, { redirects: redirects - 1, maxBytes }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("download failed: HTTP " + res.statusCode)); return; }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error("download too large")); return; } chunks.push(c); });
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (createHash("sha256").update(body).digest("hex") !== sha256) { reject(new Error("checksum mismatch")); return; }
        resolve(body);
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("download timed out")));
  });
}

// unzipOne reads one file out of a zip held in memory (stored or deflated),
// the one whose name ends with suffix.
export function unzipOne(zip, suffix) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28), extraLen = zip.readUInt16LE(at + 30), commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(suffix)) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("damaged zip");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error("unsupported zip method " + method);
  }
  throw new Error("rclone is not in the release archive");
}

// ensureBinary answers rclone's path: RCLONE_BIN when a test sets it, else
// the pinned release, downloaded once.
export async function ensureBinary(dataDir, { asset = assetFor(), env = process.env } = {}) {
  if (env.PICODE_RCLONE_TEST_BIN) return env.PICODE_RCLONE_TEST_BIN;
  if (!asset) throw Object.assign(new Error("unsupported platform"), { code: "unsupported-platform" });
  const path = binaryPath(dataDir);
  if (existsSync(path)) return path;
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  const zip = await fetchVerified(`https://github.com/rclone/rclone/releases/download/v${VERSION}/${asset.name}`, asset.sha256);
  const bin = unzipOne(zip, process.platform === "win32" ? "/rclone.exe" : "/rclone");
  const tmp = path + ".part";
  rmSync(tmp, { force: true });
  writeFileSync(tmp, bin, { mode: 0o700 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  return path;
}

// baseEnv keeps rclone off the person's own rclone config: every remote it
// uses comes from this extension, through RCLONE_CONFIG_<NAME>_<KEY>.
export function baseEnv() {
  const env = {};
  for (const k of ["PATH", "HOME", "SYSTEMROOT", "TEMP", "TMP", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[k]) env[k] = process.env[k];
  // "/notfound" is rclone's own name for "no config file": it reads none and
  // writes none, so a refreshed sign-in never lands on disk in plain text.
  env.RCLONE_CONFIG = "/notfound";
  return env;
}

export function run(bin, args, { env, timeoutMs = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error("rclone failed"), { stderr: String(stderr || ""), code: err.code }));
      resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// obscure turns a password into the form rclone keeps in its config.
export async function obscure(bin, env, password) {
  return (await run(bin, ["obscure", "-"], { env, input: password })).trim();
}

// authorize runs rclone's sign-in for an OAuth storage. onLink receives the
// page to open; the promise answers the token rclone printed.
export function authorize(bin, env, type, onLink, { timeoutMs = 10 * 60_000 } = {}) {
  let child;
  const done = new Promise((resolve, reject) => {
    child = spawn(bin, ["authorize", type, "--auth-no-open-browser"], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => reject(new Error("rclone did not start")));
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const read = (chunk) => {
      out += chunk;
      const link = /Please go to the following link: (http:\/\/127\.0\.0\.1:53682\/auth\?state=[A-Za-z0-9_-]+)/.exec(out);
      if (link && !read.sent) { read.sent = true; onLink(link[1]); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("close", (code) => {
      clearTimeout(timer);
      const block = /--->\s*(\{[\s\S]*?\})\s*<---End paste/.exec(out);
      if (code === 0 && block) {
        try { resolve(JSON.parse(block[1])); return; } catch { /* below */ }
      }
      reject(new Error(/address already in use|bind/i.test(out) ? "busy" : "the sign-in did not finish"));
    });
  });
  return { done, cancel: () => child?.kill() };
}
