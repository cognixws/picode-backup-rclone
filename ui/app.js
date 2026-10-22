// The extension's page: the storages COGNIX[WS] copies backups to through
// rclone, adding one (a sign-in for Dropbox and OneDrive, a form for the
// others) and removing one. Passwords and tokens stay in the process.
(async function () {
  const root = document.getElementById("root");
  const processDoor = await picode.use("process"), links = await picode.use("links");
  let state = null, busy = "", error = "", adding = "", confirm = "", form = {}, poll = 0;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const button = (label, action, cls = "", extra = "") => `<button type="button" class="${cls}" data-action="${action}" ${extra} ${busy ? "disabled" : ""}>${label}</button>`;
  async function request(path, method = "GET", body) {
    if (!processDoor) throw new Error("The extension is off or its process is not running.");
    const r = await processDoor.request(path, { method, body: body ?? (method === "POST" ? {} : undefined) });
    let d; try { d = JSON.parse(r.body); } catch { throw new Error("The extension returned an unreadable answer."); }
    if (r.status >= 400) throw new Error(d.error || "That did not work. Try again.");
    return d;
  }
  async function load() {
    try { state = await request("/state"); if (state.error && !error) error = state.error; } catch (e) { error = e.message; }
    root.setAttribute("aria-busy", "false");
    render();
    clearTimeout(poll);
    if (state?.signingIn) poll = setTimeout(load, 2500);
  }
  const FIELD = {
    host: ["Server", "text", "sftp.example.com"], port: ["Port", "number", "22"], user: ["User", "text", ""], password: ["Password", "password", ""],
    url: ["Address", "url", "https://cloud.example.com/remote.php/dav/files/you"], vendor: ["Server kind", "select", ""],
  };
  function field(key) {
    const [label, type, placeholder] = FIELD[key];
    const v = esc(form[key] ?? "");
    if (type === "select") return `<label class="fld"><span>${label}</span><select data-field="${key}"><option value="nextcloud"${form[key] === "nextcloud" ? " selected" : ""}>Nextcloud</option><option value="owncloud"${form[key] === "owncloud" ? " selected" : ""}>ownCloud</option><option value="other"${!form[key] || form[key] === "other" ? " selected" : ""}>Other</option></select></label>`;
    const help = key === "password" ? `<small class="muted">Kept protected on this computer.</small>` : "";
    return `<label class="fld"><span>${label}</span><input data-field="${key}" type="${type}" placeholder="${esc(placeholder)}" value="${v}" autocomplete="off">${help}</label>`;
  }
  function addForm() {
    const t = state.types.find((x) => x.id === adding);
    return `<section class="panel" aria-label="Add a storage"><form data-form="add" novalidate>
      <label class="fld"><span>Name</span><input data-field="name" value="${esc(form.name ?? t.label.split(" (")[0])}"></label>
      <label class="fld"><span>Folder in the storage</span><input data-field="folder" value="${esc(form.folder ?? "COGNIX[WS] backups")}"></label>
      ${t.fields.map(field).join("")}
      <label class="chk"><input type="checkbox" data-field="appendOnly" ${form.appendOnly ? "checked" : ""}><span>Never delete here<small class="muted">Keep every copy in this storage even when a destination allows deleting old ones.</small></span></label>
      <div class="row">${button(t.signIn ? "Sign in with " + esc(t.label) : "Add " + esc(t.label), "submit-add", "primary")}${button("Cancel", "cancel-add")}</div>
      ${t.signIn ? `<p class="muted">Your browser opens ${esc(t.label)}'s sign-in for rclone. COGNIX[WS] keeps the sign-in protected on this computer.</p>` : ""}
    </form></section>`;
  }
  function body() {
    if (!state) return error ? `<div class="notice error" role="alert"><span>${esc(error)}</span>${button("Try again", "reload")}</div>` : "";
    if (!state.ready) return `<div class="notice error" role="alert"><span>${esc(state.error)}</span>${button("Try again", "reload")}</div>`;
    if (state.signingIn) return `<div class="notice is-busy" role="status"><span>Finish signing in to ${esc(state.signingIn.name)} in your browser…</span><span class="row">${state.signingIn.link ? button("Open the sign-in again", "reopen") : ""}${button("Cancel", "cancel-sign-in")}</span></div>`;
    const list = state.storages.length ? `<ul class="list">${state.storages.map((s) => `<li><div><b>${esc(s.name)}</b><small class="muted">${esc(s.kind)} · ${esc(s.folder)}${s.appendOnly ? " · never deletes" : ""}</small></div>${confirm === s.id ? `<span class="row"><span>Remove? Its copies stay there.</span>${button("Remove", "remove-yes", "danger", `data-id="${s.id}"`)}${button("Cancel", "remove-no")}</span>` : button("Remove", "remove", "", `data-id="${s.id}"`)}</li>`).join("")}</ul>` : adding || error ? "" : `<div class="notice"><span>Add a storage to copy your backups there.</span></div>`;
    const picker = adding ? addForm() : state.slotsLeft > 0 ? `<div class="row add">${state.types.map((t) => button("Add " + esc(t.label), "add", "", `data-type="${t.id}"`)).join("")}</div>` : `<p class="muted">Four storages at most: remove one to add another.</p>`;
    return list + picker + `<p class="muted">Then choose the storage in Backups → Destinations → Add destination.</p>`;
  }
  function render() {
    root.innerHTML = `<header><h1>More storage</h1><p class="muted">Encrypted copies of your backups in Dropbox, OneDrive, an SFTP server or WebDAV, through rclone.</p></header>${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ""}${body()}`;
  }
  function readForm() {
    for (const el of root.querySelectorAll("[data-field]")) form[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
  }
  async function act(name, el) {
    error = "";
    try {
      if (name === "reload") return load();
      if (name === "add") { adding = el.dataset.type; form = {}; return render(); }
      if (name === "cancel-add") { adding = ""; form = {}; return render(); }
      if (name === "remove") { confirm = el.dataset.id; return render(); }
      if (name === "remove-no") { confirm = ""; return render(); }
      if (name === "reopen") { void Promise.resolve(links.open(state.signingIn.link)).catch(() => {}); return; }
      busy = name; render();
      if (name === "submit-add") {
        readForm();
        const { name: label, folder, appendOnly, ...fields } = form;
        const r = await request("/storages", "POST", { type: adding, name: label, folder, appendOnly: !!appendOnly, fields });
        if (r.link) void Promise.resolve(links.open(r.link)).catch(() => {});
        adding = ""; form = {};
      } else if (name === "remove-yes") { confirm = ""; await request("/storages/" + el.dataset.id, "DELETE"); }
      else if (name === "cancel-sign-in") await request("/sign-in/cancel", "POST");
    } catch (e) { error = e.message; }
    busy = "";
    await load();
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("button[data-action]"); if (b) { e.preventDefault(); if (adding) readForm(); void act(b.dataset.action, b); } });
  root.addEventListener("submit", (e) => { e.preventDefault(); readForm(); void act("submit-add"); });
  // The storages and a sign-in change outside this page too (the browser,
  // a restart): it looks again when shown and every 15 seconds.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy && !adding) void load(); });
  setInterval(() => { if (!document.hidden && !busy && !adding && !confirm) void load(); }, 15_000);
  await load();
})();
