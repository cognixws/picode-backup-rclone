// The conformance kit for backup storages (ADR-0368, decision 10): the
// subset of restic's REST protocol, version 2, that COGNIX[WS] uses, and the
// closed status. An adapter repository runs it in its CI against its own
// process; `rclone serve restic` passes it too.
//
//   node conformance.mjs --base http://127.0.0.1:PORT/repo/CONNECTION/REPOSITORY \
//     --secret SECRET [--status http://127.0.0.1:PORT/status] [--append-only]
//
// The repository at --base is created and written; use an empty one.
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { pathToFileURL } from "node:url";

const V2 = "application/vnd.x.restic.rest.v2";
const sha = (b) => createHash("sha256").update(b).digest("hex");

export async function runConformance({ base, secret, status = "", appendOnly = false, log = console.log }) {
  const auth = { "X-PiCode-Proxy-Secret": secret, Authorization: "Basic " + Buffer.from("picode:" + secret).toString("base64") };
  const call = (method, path, { body, headers = {}, credentials = true, root = base } = {}) =>
    fetch(root + path, { method, body, redirect: "manual", headers: { ...(credentials ? auth : {}), ...(body ? { "Content-Type": "application/octet-stream" } : {}), ...headers } });
  const wrong = { "X-PiCode-Proxy-Secret": secret + "-wrong", Authorization: "Basic " + Buffer.from("picode:" + secret + "-wrong").toString("base64") };
  // raw sends part of a body, or reads part of one, then drops the
  // connection, as the core does when a copy is paused.
  const raw = (method, path, { size = 0, send = 0, readThenDrop = false } = {}) => new Promise((resolve) => {
    const req = request(base + path, { method, headers: { ...auth, ...(size ? { "Content-Length": size, "Content-Type": "application/octet-stream" } : {}) } }, (res) => {
      if (readThenDrop) res.once("data", () => { req.destroy(); resolve(res.statusCode); });
      else { res.resume(); res.on("end", () => resolve(res.statusCode)); }
    });
    req.on("error", () => resolve(0));
    if (size) { req.write(randomBytes(send)); setTimeout(() => { req.destroy(); resolve(0); }, 200); }
    else req.end();
  });
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      log("ok   " + name);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      log("FAIL " + name + ": " + e.message);
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const bytesOf = async (res) => Buffer.from(await res.arrayBuffer());

  await check("refuses a request without the relay's secret, or with a wrong one, on every route", async () => {
    for (const [method, path] of [["GET", "/config"], ["GET", "/keys/"], ["POST", "/keys/" + sha(Buffer.from("x"))], ["DELETE", "/keys/" + sha(Buffer.from("x"))], ["POST", "/?create=true"]]) {
      for (const headers of [{}, wrong]) {
        const res = await call(method, path, { credentials: false, headers, body: method === "POST" && path.startsWith("/keys") ? Buffer.from("x") : undefined });
        expect(res.status === 401 || res.status === 403, `${method} ${path} answered ${res.status}`);
      }
    }
  });
  await check("the repositories ask for Basic: the header alone is refused", async () => {
    const res = await call("GET", "/keys/", { credentials: false, headers: { "X-PiCode-Proxy-Secret": secret, Accept: V2 } });
    expect(res.status === 401 || res.status === 403, "the header alone answered " + res.status);
  });
  await check("creates the repository, twice", async () => {
    for (const _ of [1, 2]) {
      const res = await call("POST", "/?create=true");
      expect(res.status === 200, "answered " + res.status);
    }
  });
  const config = randomBytes(213);
  await check("config: missing, written, sized, read", async () => {
    expect((await call("HEAD", "/config")).status === 404, "a missing config is not 404");
    expect((await call("POST", "/config", { body: config })).status === 200, "writing config failed");
    const head = await call("HEAD", "/config");
    expect(head.status === 200 && Number(head.headers.get("content-length")) === config.length, "HEAD config: " + head.status + " " + head.headers.get("content-length"));
    const got = await bytesOf(await call("GET", "/config"));
    expect(got.equals(config), "config read back differs");
  });
  const key = randomBytes(300);
  const keyName = sha(key);
  await check("an object: written, written again, sized, read", async () => {
    expect((await call("POST", "/keys/" + keyName, { body: key })).status === 200, "writing failed");
    const again = await call("POST", "/keys/" + keyName, { body: key });
    expect(again.status === 200 || again.status === 403, "writing the same object again answered " + again.status);
    const head = await call("HEAD", "/keys/" + keyName);
    expect(head.status === 200 && Number(head.headers.get("content-length")) === key.length, "HEAD: " + head.status);
    expect((await bytesOf(await call("GET", "/keys/" + keyName))).equals(key), "read back differs");
  });
  // A stored name never changes content because COGNIX[WS] names every
  // object by its hash and checks the hash on every read: a storage need not
  // refuse an overwrite (rclone serve restic replaces one), and the kit does
  // not ask it to.
  await check("an interrupted upload leaves no object", async () => {
    const name = sha(randomBytes(32));
    await raw("POST", "/data/" + name, { size: 1 << 20, send: 1 << 16 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await call("HEAD", "/data/" + name)).status === 404, "half an object is stored");
  });
  await check("ranges answer 206 with exactly the bytes asked", async () => {
    const part = await call("GET", "/keys/" + keyName, { headers: { Range: "bytes=10-49" } });
    expect(part.status === 206, "a range answered " + part.status);
    expect((await bytesOf(part)).equals(key.subarray(10, 50)), "the range's bytes differ");
    const tail = await call("GET", "/keys/" + keyName, { headers: { Range: "bytes=250-" } });
    expect(tail.status === 206, "an open range answered " + tail.status);
    expect((await bytesOf(tail)).equals(key.subarray(250)), "the open range's bytes differ");
  });
  await check("lists in version 2: name and size", async () => {
    const res = await call("GET", "/keys/", { headers: { Accept: V2 } });
    expect(res.status === 200, "answered " + res.status);
    const list = await res.json();
    expect(Array.isArray(list) && list.some((e) => e.name === keyName && e.size === key.length), "the listing misses the object or its size");
    const empty = await call("GET", "/locks/", { headers: { Accept: V2 } });
    expect(empty.status === 200, "an empty type answered " + empty.status);
    const none = await empty.json();
    expect(Array.isArray(none) && none.length === 0, "an empty type is not []");
  });
  await check("a missing object is 404", async () => {
    const missing = sha(randomBytes(8));
    expect((await call("GET", "/index/" + missing)).status === 404, "GET is not 404");
    expect((await call("HEAD", "/index/" + missing)).status === 404, "HEAD is not 404");
  });
  const pack = randomBytes(16 << 20);
  const packName = sha(pack);
  await check("a 16 MiB pack goes and comes back intact", async () => {
    expect((await call("POST", "/data/" + packName, { body: pack })).status === 200, "writing the pack failed");
    const got = await bytesOf(await call("GET", "/data/" + packName));
    expect(sha(got) === packName, "the pack read back differs");
    const list = await (await call("GET", "/data/", { headers: { Accept: V2 } })).json();
    expect(list.some((e) => e.name === packName && e.size === pack.length), "the pack is not listed");
  });
  await check("survives a download dropped halfway", async () => {
    await raw("GET", "/data/" + packName, { readThenDrop: true });
    await new Promise((r) => setTimeout(r, 300));
    expect((await call("HEAD", "/data/" + packName)).status === 200, "the storage stopped answering after a dropped download");
  });
  await check("repositories are apart", async () => {
    const sibling = base + "-apart";
    expect((await call("POST", "/?create=true", { root: sibling })).status === 200, "creating a second repository failed");
    expect((await call("HEAD", "/data/" + packName, { root: sibling })).status === 404, "an object shows in another repository");
  });
  await check(appendOnly ? "refuses deletes with 403 (append-only)" : "deletes, then the object is gone", async () => {
    const res = await call("DELETE", "/keys/" + keyName);
    if (appendOnly) {
      expect(res.status === 403, "a delete answered " + res.status);
      expect((await call("HEAD", "/keys/" + keyName)).status === 200, "the object went anyway");
    } else {
      expect(res.status === 200 || res.status === 204, "a delete answered " + res.status);
      expect((await call("HEAD", "/keys/" + keyName)).status === 404, "the object is still there");
    }
  });
  if (status) {
    await check("the status is the closed projection", async () => {
      const res = await fetch(status, { headers: auth });
      expect(res.status === 200, "answered " + res.status);
      const s = await res.json();
      expect(["ready", "needs-setup", "needs-attention"].includes(s.state), "state " + s.state);
      expect([undefined, "", "settings", "sign-in", "retry"].includes(s.next), "next " + s.next);
      expect(Array.isArray(s.connections) && s.connections.length <= 16, "connections");
      const ids = new Set();
      for (const c of s.connections) {
        expect(/^[A-Za-z0-9_-]{1,96}$/.test(c.id) && !ids.has(c.id), "connection id " + c.id);
        ids.add(c.id);
        // COGNIX[WS] refuses control and invisible formatting characters.
        expect(typeof c.label === "string" && c.label.trim() && [...c.label.trim()].length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(c.label), "connection label");
        for (const n of ["used", "total"]) expect(c[n] === undefined || (Number.isInteger(c[n]) && c[n] >= 0), n);
        expect(typeof c.deleteAllowed === "boolean", "deleteAllowed");
        expect((c.repositories || []).length <= 64, "at most 64 repositories");
        for (const r of c.repositories || []) expect(/^[A-Za-z0-9_-]{1,96}$/.test(r), "repository " + r);
      }
    });
  }
  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (name) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : ""; };
  const base = arg("base"), secret = arg("secret");
  if (!base || !secret) {
    console.error("usage: node conformance.mjs --base URL --secret SECRET [--status URL] [--append-only]");
    process.exit(2);
  }
  const { passed, failed } = await runConformance({ base, secret, status: arg("status"), appendOnly: process.argv.includes("--append-only") });
  console.log(`${passed} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
