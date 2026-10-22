import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { runConformance } from "./conformance.mjs";
import { serveRemote, storage } from "./helpers.mjs";
import { cleanFolder, connectionOf, validate } from "../lib/storages.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const sftpFields = (r, over = {}) => ({ host: "127.0.0.1", port: r.port, user: "tester", password: "tester-pass", ...over });

for (const [kind, appendOnly] of [["sftp", false], ["sftp", true], ["webdav", false]]) {
  test(`the conformance kit passes through rclone to ${kind}${appendOnly ? " (never delete)" : ""}`, { timeout: 180_000 }, async () => {
    const remote = await serveRemote(kind);
    const s = await storage();
    try {
      const fields = kind === "sftp" ? sftpFields(remote) : { url: `http://127.0.0.1:${remote.port}`, vendor: "other", user: "tester", password: "tester-pass" };
      const added = await s.page("/storages", "POST", { type: kind, name: "My " + kind, folder: "COGNIX[WS] backups", appendOnly, fields });
      assert.equal(added.status, 200, JSON.stringify(added));
      const st = await s.status();
      assert.equal(st.state, "ready", JSON.stringify(st));
      const c = st.connections[0];
      assert.equal(c.label, `My ${kind} · COGNIX[WS] backups`);
      assert.equal(c.deleteAllowed, !appendOnly);
      const { passed, failed } = await runConformance({ base: `${s.url}/repo/${c.id}/cognix-test`, secret: s.secret, status: s.url + "/status", appendOnly, log: () => {} });
      assert.deepEqual(failed, [], `${passed} passed`);
      const state = await s.page("/state");
      assert.ok(!JSON.stringify(state).includes("tester-pass"), "the page saw the password");
      assert.ok(!JSON.stringify(s.host.secrets).includes("tester-pass"), "the sealed storage keeps the plain password");
    } finally { s.stop(); remote.stop(); }
  });
}

test("a storage that refuses the password is never kept", { timeout: 60_000 }, async () => {
  const remote = await serveRemote("sftp");
  const s = await storage();
  try {
    const r = await s.page("/storages", "POST", { type: "sftp", name: "Bad", fields: sftpFields(remote, { password: "wrong" }) });
    assert.equal(r.status, 400);
    assert.match(r.error, /refused/);
    assert.deepEqual(Object.keys(s.host.secrets), []);
    assert.deepEqual(await s.status(), { state: "needs-setup", next: "settings", connections: [] });
  } finally { s.stop(); remote.stop(); }
});

test("four storages at most; removing one frees its slot and keeps its copies", { timeout: 120_000 }, async () => {
  const remote = await serveRemote("sftp");
  const s = await storage();
  try {
    for (let i = 1; i <= 4; i++) assert.equal((await s.page("/storages", "POST", { type: "sftp", name: "S" + i, folder: "f" + i, fields: sftpFields(remote) })).status, 200);
    const fifth = await s.page("/storages", "POST", { type: "sftp", name: "S5", fields: sftpFields(remote) });
    assert.equal(fifth.status, 400);
    const c = (await s.status()).connections[0];
    await fetch(`${s.url}/repo/${c.id}/r/?create=true`, { method: "POST", headers: s.basic });
    const st = await s.page("/state");
    const one = st.storages[0];
    const removed = await s.page("/storages/" + one.id, "DELETE");
    assert.equal(removed.storages.length, 3);
    assert.ok(readdirSync(remote.dir).includes("f1"), "removing a storage deleted its copies");
  } finally { s.stop(); remote.stop(); }
});

test("only status codes reach COGNIX[WS]; the page's relay never reaches the repositories; a wrong body is never kept", { timeout: 120_000 }, async () => {
  const remote = await serveRemote("sftp");
  const s = await storage();
  try {
    await s.page("/storages", "POST", { type: "sftp", name: "S", fields: sftpFields(remote) });
    const c = (await s.status()).connections[0];
    const base = `${s.url}/repo/${c.id}/r`;
    await fetch(base + "/?create=true", { method: "POST", headers: s.basic });
    const missing = await fetch(`${base}/keys/${"a".repeat(64)}`, { headers: s.basic });
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "");
    assert.equal((await fetch(`${base}/config`, { headers: { "X-PiCode-Proxy-Secret": s.secret } })).status, 401);
    const url = `${base}/data/${"b".repeat(64)}`;
    assert.notEqual((await fetch(url, { method: "POST", headers: s.basic, body: randomBytes(50_000) })).status, 200);
    assert.equal((await fetch(url, { method: "HEAD", headers: s.basic })).status, 404);
    // Cancelled uploads leave nothing and the next upload goes at once.
    await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve) => {
      const req = request(`${base}/data/${sha(Buffer.from("c" + i))}`, { method: "POST", headers: { ...s.basic, "Content-Length": 2 << 20 } });
      req.on("error", () => resolve());
      req.write(randomBytes(1 << 16));
      setTimeout(() => { req.destroy(); resolve(); }, 300);
    })));
    const body = randomBytes(1000);
    const t = Date.now();
    assert.equal((await fetch(`${base}/data/${sha(body)}`, { method: "POST", headers: s.basic, body })).status, 200);
    assert.ok(Date.now() - t < 5000, "the next upload waited " + (Date.now() - t) + " ms");
  } finally { s.stop(); remote.stop(); }
});

test("what the page sends is checked; a folder is plain names; the place follows the storage", () => {
  assert.throws(() => validate({ type: "ftp" }), /kind of storage/);
  assert.throws(() => validate({ type: "sftp", fields: { host: "x;rm", user: "u", password: "p" } }), /host/);
  assert.throws(() => validate({ type: "webdav", fields: { url: "http://example.com", user: "u", password: "p" } }), /https/);
  assert.throws(() => validate({ type: "webdav", fields: { url: "https://u:p@example.com", user: "u", password: "p" } }), /own fields/);
  assert.equal(cleanFolder(""), "COGNIX[WS] backups");
  assert.equal(cleanFolder("/a/b/"), "a/b");
  assert.throws(() => cleanFolder("a/../b"), /folder/);
  const a = connectionOf({ id: "aaaaaaaa", name: "One", folder: "f" });
  const renamed = connectionOf({ id: "aaaaaaaa", name: "Two", folder: "f" });
  assert.equal(a.id, renamed.id);
  assert.match(a.id, /^rc-[0-9a-f]{16}$/);
});
