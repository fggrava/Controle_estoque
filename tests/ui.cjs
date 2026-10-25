/* Teste de DOM e persistência offline. npm install --no-save jsdom fake-indexeddb */
const { JSDOM } = require("jsdom");
const { indexedDB } = require("fake-indexeddb");
const fs = require("fs");
const assert = require("node:assert/strict");
const { webcrypto } = require("crypto");
const root = process.env.PROJECT_ROOT || process.cwd();
const dom = new JSDOM(fs.readFileSync(root + "/templates/index.html", "utf8"), {
  url: "http://localhost",
  runScripts: "outside-only",
});
const w = dom.window;
w.indexedDB = indexedDB;
w.structuredClone = structuredClone;
w.Headers = Headers;
w.Response = Response;
Object.defineProperty(w, "crypto", { value: webcrypto });
w.matchMedia = () => ({ matches: false });
w.confirm = () => true;
let online = true;
Object.defineProperty(w.navigator, "onLine", { get: () => online });
const material = {
  id: 1,
  code: "000123",
  description: "Peça teste",
  unit: "UN",
  center: "1002",
  depot: "0101",
  balance: "100",
  unit_cost: "5",
  active: true,
  deletion: "",
  minimum: "0",
  location: "",
};
let submitted = [];
w.fetch = async (url, opt = {}) => {
  const route = String(url);
  let data;
  if (route === "/api/me")
    data = { user: { id: 1, name: "Admin", role: "admin" }, csrf: "csrf" };
  else if (route === "/api/state")
    data = {
      cycle: 1,
      revision: 0,
      exported: 0,
      started: new Date().toISOString(),
    };
  else if (route === "/api/materials") data = [material];
  else if (route === "/api/attendances" && opt.method === "POST") {
    submitted.push(JSON.parse(opt.body));
    data = { id: submitted.length };
  } else if (route === "/api/attendances") data = [];
  else if (route === "/api/users")
    data = [{ id: 1, name: "Admin", role: "admin" }];
  else if (route.startsWith("/api/dashboard"))
    data = { attendances: 0, total: "0", units: {}, days: {}, records: [] };
  else throw Error("Rota inesperada " + route);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
};
w.eval(
  fs.readFileSync(root + "/static/app.js", "utf8") + ";window.__queue=queue;",
);
const wait = () => new Promise((r) => setTimeout(r, 80));
(async () => {
  await wait();
  assert.equal(w.document.querySelector("#app").hidden, false);
  assert.ok(w.document.querySelector("input[name=start]"));
  assert.ok(w.document.querySelector("select[name=user]"));
  w.document.querySelector("[data-page=entry]").click();
  await wait();
  online = false;
  for (let i = 0; i < 11; i++) {
    w.document.querySelector("#additem").click();
    const f = w.document.querySelector("#entryform");
    f.elements.os.value = "123";
    f.elements.receiver.value = "Pessoa";
    f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await wait();
  }
  let q = await w.__queue();
  assert.equal(q.length, 10);
  assert.match(w.document.querySelector("#message").textContent, /Limite/);
  const original = q[0].payload.client_id;
  w.document.querySelector("[data-review-pending]").click();
  await wait();
  assert.equal(
    (await w.__queue()).length,
    10,
    "Revisar não deve apagar a pendência",
  );
  w.document.querySelector("[data-page=materials]").click();
  await wait();
  assert.equal((await w.__queue()).length, 10);
  w.document.querySelector("#search").value = "000123";
  w.document.querySelector("#search").dispatchEvent(new w.Event("input"));
  assert.match(w.document.querySelector("#mats").textContent, /Peça teste/);
  online = true;
  w.document.querySelector("#sync").click();
  await wait();
  await wait();
  assert.equal((await w.__queue()).length, 0);
  assert.equal(submitted.length, 10);
  assert.equal(submitted[0].client_id, original);
  console.log(
    "UI: filtros, consulta, limite offline, revisão sem perda e sincronização aprovados.",
  );
  w.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  w.close();
});
