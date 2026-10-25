"use strict";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  money = (v) =>
    Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
let me,
  csrf,
  state,
  catalog = [],
  att = [],
  users = [],
  page = "dashboard",
  cart = [],
  preview = null,
  installPrompt,
  editingPending = null,
  saving = false;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
let filters = { start: today(), end: today(), user: "" };
const idb = new Promise((resolve, reject) => {
  const r = indexedDB.open("controle-estoque-v1", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("data");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function localGet(key) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const r = db.transaction("data").objectStore("data").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function localSet(key, value) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const t = db.transaction("data", "readwrite");
    t.objectStore("data").put(value, key);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
async function changeQueue(fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const t = db.transaction("data", "readwrite"),
      store = t.objectStore("data"),
      r = store.get("queue");
    let value;
    r.onsuccess = () => {
      try {
        value = fn(r.result || []);
        store.put(value, "queue");
      } catch (e) {
        t.abort();
        reject(e);
      }
    };
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
  });
}
async function queue() {
  return (await localGet("queue")) || [];
}
function message(s) {
  $("#message").textContent = s;
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && options.body) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  if (csrf) headers.set("X-CSRF-Token", csrf);
  let r;
  try {
    r = await fetch("/api/" + path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (e) {
    throw new Error("Sem conexão. Utilize os recursos offline.");
  }
  if (!r.ok) {
    if (r.status === 401 && me) {
      $("#login").hidden = false;
      $("#app").hidden = true;
      $("#loginerror").textContent =
        "Sessão expirada. Entre novamente; suas pendências foram preservadas.";
    }
    const j = await r.json().catch(() => ({ error: "Falha no servidor." }));
    const err = new Error(j.error);
    err.status = r.status;
    throw err;
  }
  if (options.download) return r;
  return r.json();
}
async function status() {
  const q = await queue();
  $("#network").textContent =
    `${navigator.onLine ? "Online" : "Offline"} · ${q.length}/10 pendentes · Catálogo: ${state?.cachedAt ? new Date(state.cachedAt).toLocaleString("pt-BR") : "não sincronizado"}`;
}
async function refresh() {
  state = await api("state");
  catalog = await api("materials");
  att = await api("attendances");
  state.cachedAt = new Date().toISOString();
  if (me.role === "admin") users = await api("users");
  await localSet("cache:" + me.id, { state, catalog, att });
  await status();
}
async function activate() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#who").textContent =
    me.name + " · " + (me.role === "admin" ? "Administrador" : "Usuário");
  document
    .querySelectorAll(".admin")
    .forEach((e) => (e.hidden = me.role !== "admin"));
  if (navigator.onLine)
    await localSet("lastUser", {
      ...me,
      offlineUntil: Date.now() + 12 * 3600000,
    });
  if (navigator.onLine) await refresh();
  else {
    const c = await localGet("cache:" + me.id);
    if (!c) throw new Error("Primeira sincronização exige internet.");
    ({ state, catalog, att } = c);
  }
  await status();
  await render();
}
$("#loginform").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = new FormData(e.target);
    const r = await api("login", {
      method: "POST",
      body: Object.fromEntries(f),
    });
    me = r.user;
    csrf = r.csrf;
    e.target.reset();
    await activate();
    if ((await queue()).some((i) => i.user === me.id)) await syncQueue();
  } catch (e) {
    $("#loginerror").textContent = e.message;
  }
};
$("#logout").onclick = async () => {
  if ((await queue()).some((q) => q.user === me.id)) {
    message("Sincronize ou resolva seus lançamentos pendentes antes de sair.");
    return;
  }
  if (!navigator.onLine) {
    message("Reconecte para encerrar a sessão no servidor.");
    return;
  }
  try {
    await api("logout", { method: "POST" });
    await localSet("lastUser", null);
    await localSet("cache:" + me.id, null);
    location.reload();
  } catch (e) {
    message(e.message);
  }
};
$("#theme").onclick = () => {
  const t =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
};
document.documentElement.dataset.theme =
  localStorage.getItem("theme") ||
  (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#install").hidden = false;
});
$("#install").onclick = async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = null;
    $("#install").hidden = true;
  } else
    message(
      "No iPhone/iPad: Compartilhar → Adicionar à Tela de Início. No Android: menu do navegador → Instalar aplicativo. Requer HTTPS e primeira visita online.",
    );
};
function table(headers, rows) {
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">Nenhum registro.</td></tr>`}</tbody></table></div>`;
}
function matRows(ms) {
  return ms.map(
    (m) =>
      `<tr><td>${esc(m.code)}</td><td>${esc(m.description)}<br><small>${esc(m.location)} · ${esc(m.center)}/${esc(m.depot)}</small></td><td>${esc(m.balance)} ${esc(m.unit)}</td><td>${money(m.unit_cost)}</td><td>${m.active ? "Ativo" : "Inativo"}</td>${me.role === "admin" ? `<td><button data-material="${m.id}">Editar / inventário</button> <button data-delete-material="${m.id}">Excluir / inativar</button></td>` : ""}</tr>`,
  );
}
function filterForm() {
  return `<form id="filters" class="panel"><div class="fields"><label>Data inicial<input type="date" name="start" value="${esc(filters.start)}" required></label><label>Data final<input type="date" name="end" value="${esc(filters.end)}" required></label>${me.role === "admin" ? `<label>Usuário<select name="user"><option value="">Todos os usuários</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === filters.user ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>` : ""}<button class="primary">Aplicar filtros</button></div></form>`;
}
async function render() {
  message("");
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  const s = $("#screen");
  if (page === "dashboard" || page === "reports") {
    s.innerHTML = `<h1>${page === "dashboard" ? "Visão geral" : "Relatórios"}</h1>${filterForm()}<div id="dash">Carregando…</div>`;
    $("#filters").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.start > f.end) {
        message("Data inicial deve ser anterior à final.");
        return;
      }
      filters = { ...filters, ...f };
      await loadDash();
    };
    await loadDash();
  } else if (page === "materials") {
    s.innerHTML = `<h1>Consulta de materiais</h1><label>Pesquisar código, descrição ou localização<input id="search" placeholder="Digite para pesquisar"></label><div class="panel" id="mats"></div>${
      me.role === "admin"
        ? `<details class="panel"><summary>Cadastrar novo material</summary><form id="newmaterial"><div class="fields">${[
            ["code", "Código"],
            ["description", "Descrição"],
            ["unit", "Unidade"],
            ["center", "Centro"],
            ["depot", "Depósito"],
            ["balance", "Saldo inicial"],
            ["unit_cost", "Valor unitário"],
          ]
            .map(([k, v]) => `<label>${v}<input name="${k}" required></label>`)
            .join(
              "",
            )}</div><button class="primary">Cadastrar material</button></form></details>`
        : ""
    }`;
    const paint = () => {
      $("#mats").innerHTML = table(
        [
          "Código",
          "Descrição / localização",
          "Saldo",
          "Valor unitário",
          "Situação",
          ...(me.role === "admin" ? ["Ações"] : []),
        ],
        matRows(
          catalog.filter((m) =>
            (m.code + " " + m.description + " " + m.location)
              .toLocaleLowerCase("pt-BR")
              .includes($("#search").value.toLocaleLowerCase("pt-BR")),
          ),
        ),
      );
    };
    $("#search").oninput = paint;
    paint();
    if ($("#newmaterial"))
      $("#newmaterial").onsubmit = (e) => {
        e.preventDefault();
        run(async () => {
          await api("materials", {
            method: "POST",
            body: Object.fromEntries(new FormData(e.target)),
          });
          await refresh();
          await render();
        });
      };
  } else if (page === "entry") {
    s.innerHTML = `<h1>Novo atendimento</h1><div class="note">${navigator.onLine ? "Saldo validado no servidor ao confirmar." : "Offline: saldo da última sincronização. Até 10 atendimentos por dispositivo, sujeitos à validação ao reconectar."}</div><form id="entryform" class="panel"><div class="fields"><label>Ordem de serviço<input name="os" required pattern="[0-9]{1,20}" maxlength="20"></label><label>Responsável pela retirada<input name="receiver" required maxlength="150"></label></div><label>Pesquisar material<input id="itemsearch" placeholder="Código ou descrição"></label><div class="fields"><label>Material<select id="itemselect"></select></label><label>Quantidade<input id="qty" type="number" min="0.001" step="0.001" value="1"></label><button type="button" id="additem">Adicionar item</button></div><div id="cart"></div><label><input type="checkbox" name="confirm_duplicate">Confirmo uma nova retirada mesmo havendo material e OS iguais nos últimos 30 minutos.</label><div class="actions"><button class="primary">${navigator.onLine ? "Confirmar atendimento" : "Salvar offline"}</button></div></form><div id="pending"></div>`;
    const paintOptions = () => {
      $("#itemselect").innerHTML = catalog
        .filter(
          (m) =>
            m.active &&
            !m.deletion &&
            (m.code + " " + m.description)
              .toLowerCase()
              .includes($("#itemsearch").value.toLowerCase()),
        )
        .slice(0, 80)
        .map(
          (m) =>
            `<option value="${m.id}">${esc(m.code)} · ${esc(m.description)} · saldo ${esc(m.balance)} ${esc(m.unit)}</option>`,
        )
        .join("");
    };
    $("#itemsearch").oninput = paintOptions;
    paintOptions();
    paintCart();
    $("#additem").onclick = () => {
      const id = Number($("#itemselect").value),
        q = Number($("#qty").value);
      if (!id || !Number.isFinite(q) || q <= 0) {
        message("Selecione material e quantidade positiva.");
        return;
      }
      const ex = cart.find((i) => i.material_id === id);
      if (ex) ex.quantity = Number(ex.quantity) + q;
      else cart.push({ material_id: id, quantity: q });
      paintCart();
    };
    $("#entryform").onsubmit = saveEntry;
    await paintPending();
  } else if (page === "history") {
    if (navigator.onLine) att = await api("attendances");
    s.innerHTML = `<h1>Meus lançamentos</h1><p>Atendimentos de hoje: <strong>${att.filter((a) => a.user_id === me.id && a.status === "active" && new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(a.created)) === today()).length}</strong></p>${attendanceTable(att.filter((a) => a.user_id === me.id))}`;
  } else if (page === "import") {
    s.innerHTML = `<h1>Importar estoque SAP · MB52</h1><p>Carregue a posição completa de estoque extraída da operação MB52 em formato .xlsx.</p><div class="panel"><h2>1. Exportar os lançamentos do período</h2><p>O período começa na última importação ou inserção da base. Todos os lançamentos e alterações desse ciclo precisam ser exportados antes da nova importação.</p></div><div class="note">Ciclo ${state.cycle} · Desde ${new Date(state.started).toLocaleString("pt-BR")}<br>${state.revision === state.exported ? "Exportação em dia." : "Existem lançamentos ou alterações não exportados."}</div><button id="exportfull">Exportar ciclo completo em XLSX</button> <a href="/api/import/template">Baixar planilha modelo</a><form id="importform" class="panel"><h2>2. Selecionar a planilha MB52</h2><details><summary>Colunas esperadas da MB52</summary><p>Material · Texto breve material · Unid.medida básica · Centro · Depósito · Denominação depósito · Marc.p/elim.nív.dep. · Tipo de material · Utilização livre · Val.utiliz.livre</p></details><p>A nova base substitui a posição completa; materiais ausentes serão inativados e terão saldo zerado, preservando o histórico.</p><label>Arquivo MB52 em XLSX (até 3 MB)<input type="file" name="file" accept=".xlsx" required></label><button>Validar e visualizar</button></form><div id="preview"></div>`;
    $("#exportfull").onclick = () => downloadExport(true);
    $("#importform").onsubmit = async (e) => {
      e.preventDefault();
      try {
        preview = await api("import/preview", {
          method: "POST",
          body: new FormData(e.target),
        });
        $("#preview").innerHTML =
          `<div class="panel"><h2>3. Conferir e confirmar a importação</h2><p>${preview.count} itens · ${preview.missing} itens ausentes serão inativados e zerados</p>${preview.needs_export ? '<div class="note">Exporte o ciclo antes de confirmar.</div>' : ""}${table(
            [
              "Material",
              "Texto breve material",
              "Unid.medida básica",
              "Centro",
              "Depósito",
              "Denominação depósito",
              "Marc.p/elim.nív.dep.",
              "Tipo de material",
              "Utilização livre",
              "Val.utiliz.livre",
            ],
            preview.sample.map(
              (m) =>
                `<tr><td>${esc(m.code)}</td><td>${esc(m.description)}</td><td>${esc(m.unit)}</td><td>${esc(m.center)}</td><td>${esc(m.depot)}</td><td>${esc(m.depot_name)}</td><td>${esc(m.deletion)}</td><td>${esc(m.kind)}</td><td>${esc(m.base)}</td><td>${money(m.stock_value)}</td></tr>`,
            ),
          )}${preview.same ? '<div class="note"><strong>Atenção: todos os saldos são iguais aos da base anterior.</strong> Verifique se o arquivo está atualizado.</div><label class="check"><input id="sameconfirm" type="checkbox">Confirmo a importação com saldos iguais.</label>' : ""}<label class="check"><input id="reconciled" type="checkbox">Confirmei que a posição importada já contempla as retiradas dos ciclos anteriores, inclusive as baixas no SAP. Elas não serão descontadas novamente.</label><button id="confirmbase" class="primary" ${preview.needs_export ? "disabled" : ""}>Confirmar substituição da base</button></div>`;
        $("#confirmbase").onclick = confirmBase;
      } catch (e) {
        message(e.message);
      }
    };
  } else if (page === "users") {
    s.innerHTML = `<h1>Usuários</h1><form id="newuser" class="panel"><div class="fields"><label>Nome<input name="name" required></label><label>Login<input name="login" required pattern="[a-z0-9_.-]{3,80}"></label><label>Senha inicial<input type="password" name="password" minlength="12" required autocomplete="new-password"></label><label>Perfil<select name="role"><option value="user">Usuário</option><option value="admin">Administrador</option></select></label><button class="primary">Criar usuário</button></div></form>${table(
      ["Nome", "Login", "Perfil", "Situação", "Ação"],
      users.map(
        (u) =>
          `<tr><td>${esc(u.name)}</td><td>${esc(u.login)}</td><td>${esc(u.role)}</td><td>${u.active ? "Ativo" : "Inativo"}</td><td><button data-user="${u.id}">Editar</button> <button data-delete-user="${u.id}">Excluir / desativar</button></td></tr>`,
      ),
    )}<div id="useredit"></div>`;
    $("#newuser").onsubmit = async (e) => {
      e.preventDefault();
      await run(async () => {
        await api("users", {
          method: "POST",
          body: Object.fromEntries(new FormData(e.target)),
        });
        await refresh();
        await render();
        message("Usuário criado.");
      });
    };
  } else if (page === "audit") {
    const rows = await api("audit");
    s.innerHTML =
      "<h1>Auditoria</h1>" +
      table(
        ["Data", "Usuário", "Ação", "Detalhes"],
        rows.map(
          (a) =>
            `<tr><td>${new Date(a.created).toLocaleString("pt-BR")}</td><td>${a.user_id}</td><td>${esc(a.action)}</td><td><details><summary>Ver histórico</summary><pre>${esc(JSON.stringify(a.detail, null, 2))}</pre></details></td></tr>`,
        ),
      );
  }
}
function attendanceTable(rows) {
  return table(
    ["Data / usuário", "OS / recebedor", "Itens", "Valor", "Situação", "Ações"],
    rows.map(
      (a) =>
        `<tr><td>${new Date(a.created).toLocaleString("pt-BR")}<br>${esc(a.user)}</td><td>${esc(a.os)}<br>${esc(a.receiver)}</td><td>${a.items.map((i) => `${esc(i.code)} · ${esc(i.quantity)} ${esc(i.unit)}`).join("<br>")}</td><td>${money(a.items.reduce((s, i) => s + Number(i.total ?? Number(i.quantity) * Number(i.cost)), 0))}</td><td>${a.status === "active" ? "Ativo" : "Cancelado"}<br>${a.sap_document ? "SAP: " + esc(a.sap_document) : "SAP pendente"}</td><td><button data-print="${a.id}">Comprovante</button>${a.status === "active" && a.cycle === state.cycle && !a.sap_document ? ` <button data-edit="${a.id}">Editar itens</button> <button data-cancel="${a.id}">Cancelar</button>` : ""}${me.role === "admin" && a.status === "active" && !a.sap_document ? ` <button data-sap="${a.id}">Confirmar SAP</button>` : ""}</td></tr>`,
    ),
  );
}
async function loadDash() {
  try {
    const d = await api("dashboard?" + new URLSearchParams(filters));
    $("#dash").innerHTML =
      `<div class="metrics"><div class="panel"><small>Retiradas por unidade</small><strong class="value">${
        Object.entries(d.units)
          .map(([u, q]) => esc(q) + " " + esc(u))
          .join(" / ") || "0"
      }</strong></div><div class="panel"><small>Atendimentos</small><strong class="value">${d.attendances}</strong></div><div class="panel"><small>Valor total de saídas</small><strong class="value">${money(d.total)}</strong></div></div><div class="panel"><h2>Atendimentos por dia</h2>${
        Object.entries(d.days)
          .map(
            ([day, n]) =>
              `<div class="chartrow"><span>${esc(day)}</span><div><progress max="${Math.max(1, ...Object.values(d.days))}" value="${n}" aria-label="${esc(day)}: ${n} atendimentos"></progress></div><span>${n}</span></div>`,
          )
          .join("") || "Sem atendimentos no período."
      }</div>${me.role === "admin" ? '<button id="exportfiltered">Exportar relatório XLSX</button>' : ""}<div class="panel">${attendanceTable(d.records)}</div><div id="editarea"></div>`;
    att = d.records;
    if ($("#exportfiltered"))
      $("#exportfiltered").onclick = () => downloadExport(false);
  } catch (e) {
    $("#dash").textContent = e.message;
  }
}
function paintCart() {
  $("#cart").innerHTML = table(
    ["Código da peça", "Material", "Quantidade", "Ação"],
    cart.map(
      (i, n) =>
        `<tr><td>${esc(catalog.find((m) => m.id === i.material_id)?.code)}</td><td>${esc(catalog.find((m) => m.id === i.material_id)?.description)}</td><td>${esc(i.quantity)}</td><td><button type="button" data-remove="${n}">Remover</button></td></tr>`,
    ),
  );
}
async function saveEntry(e) {
  e.preventDefault();
  if (saving) return;
  if (
    !navigator.onLine &&
    Date.now() - Date.parse(state.cachedAt) > 12 * 3600000
  ) {
    message("Acesso offline expirou. Reconecte e entre novamente.");
    return;
  }
  if (!cart.length) {
    message("Adicione pelo menos um material.");
    return;
  }
  const f = Object.fromEntries(new FormData(e.target));
  const payload = {
    ...f,
    confirm_duplicate: e.target.elements.confirm_duplicate.checked,
    items: cart.map((i) => ({ ...i })),
    cycle: state.cycle,
    client_id: editingPending || crypto.randomUUID(),
  };
  saving = true;
  try {
    await run(async () => {
      await changeQueue((q) => {
        const existing = q.findIndex(
          (i) => i.payload.client_id === payload.client_id && i.user === me.id,
        );
        if (existing >= 0) q[existing] = { user: me.id, payload };
        else {
          if (q.length >= 10)
            throw new Error("Limite de 10 atendimentos pendentes atingido.");
          q.push({ user: me.id, payload });
        }
        return q;
      });
      cart = [];
      editingPending = null;
      if (navigator.onLine) await syncQueue();
      else {
        await render();
        message("Atendimento salvo offline no dispositivo.");
      }
      await status();
    });
  } finally {
    saving = false;
  }
}
let syncing = false;
async function syncQueue() {
  if (syncing) return;
  syncing = true;
  try {
    const r = await api("me");
    if (r.user.id !== me.id)
      throw new Error("Sessão pertence a outro usuário.");
    csrf = r.csrf;
    let q = await queue();
    for (const item of [...q]) {
      if (item.user !== me.id) continue;
      try {
        await api("attendances", { method: "POST", body: item.payload });
        q = await changeQueue((current) =>
          current.filter((x) => x.payload.client_id !== item.payload.client_id),
        );
      } catch (e) {
        q = await changeQueue((current) =>
          current.map((x) =>
            x.payload.client_id === item.payload.client_id
              ? { ...x, error: e.message }
              : x,
          ),
        );
        break;
      }
    }
    await refresh();
    await render();
    if (q.length)
      message("Há pendências que exigem conferência. Abra Novo atendimento.");
    else message("Sincronização concluída.");
  } finally {
    syncing = false;
    await status();
  }
}
async function paintPending() {
  const q = (await queue()).filter((i) => i.user === me.id);
  $("#pending").innerHTML = q.length
    ? `<div class="panel"><h2>Lançamentos pendentes</h2>${q.map((i) => `<p>OS ${esc(i.payload.os)} · ${esc(i.error || "Aguardando sincronização")} <button data-review-pending="${esc(i.payload.client_id)}">Revisar</button></p>`).join("")}</div>`
    : "";
}
async function confirmBase() {
  await run(async () => {
    if ((await queue()).length)
      throw new Error("Sincronize os lançamentos pendentes deste dispositivo.");
    if (!$("#reconciled").checked)
      throw new Error("Confirme a conciliação da nova posição.");
    if (preview.same && !$("#sameconfirm").checked)
      throw new Error("Confirme os saldos iguais.");
    const f = new FormData($("#importform"));
    for (const k of ["cycle", "revision", "digest"]) f.set(k, preview[k]);
    f.set("reconciled", "true");
    f.set("confirm_same", String(preview.same && $("#sameconfirm").checked));
    await api("import/confirm", { method: "POST", body: f });
    await refresh();
    await render();
    message("Nova base importada. Histórico preservado.");
  });
}
async function downloadExport(full) {
  await run(async () => {
    const r = await api("export", {
      method: "POST",
      body: { ...filters, full },
      download: true,
    });
    const blob = await r.blob(),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "Lancamentos_estoque.xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    await refresh();
    message("Arquivo gerado. Confira o download antes de substituir a base.");
  });
}
async function run(fn) {
  try {
    await fn();
  } catch (e) {
    message(e.message);
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  await run(async () => {
    if (b.dataset.page) {
      if (cart.length && !confirm("Descartar itens ainda não confirmados?"))
        return;
      cart = [];
      editingPending = null;
      page = b.dataset.page;
      await render();
    }
    if (b.dataset.remove !== undefined) {
      cart.splice(Number(b.dataset.remove), 1);
      paintCart();
    }
    if (b.dataset.reviewPending) {
      const q = await queue(),
        p = q.find(
          (i) =>
            i.payload.client_id === b.dataset.reviewPending && i.user === me.id,
        );
      if (!p) return;
      if (
        !confirm(
          "Revisar esta pendência na base atual? Confira saldo e conciliação antes de reenviar.",
        )
      )
        return;
      editingPending = p.payload.client_id;
      cart = p.payload.items.map((i) => ({ ...i }));
      const form = $("#entryform");
      form.elements.os.value = p.payload.os;
      form.elements.receiver.value = p.payload.receiver;
      paintCart();
      await paintPending();
      message(
        "Pendência preservada. Revise os itens e confirme para reenviar na base atual.",
      );
    }
    if (b.dataset.cancel) {
      const a = att.find((x) => x.id === Number(b.dataset.cancel)),
        reason = prompt("Motivo do cancelamento:");
      if (!reason) return;
      await api("attendances/" + a.id, {
        method: "PATCH",
        body: { revision: a.revision, cancel: true, reason },
      });
      await refresh();
      await render();
    }
    if (b.dataset.sap) {
      const document = prompt(
        "Número do documento de material SAP (baixa já efetuada):",
      );
      if (!document) return;
      await api("attendances/" + b.dataset.sap + "/sap", {
        method: "PATCH",
        body: { document },
      });
      await refresh();
      await render();
    }
    if (b.dataset.print) {
      const a = att.find((x) => x.id === Number(b.dataset.print));
      const area = document.createElement("div");
      area.id = "ticket";
      area.className = "panel";
      area.innerHTML = `<h1>Comprovante de retirada #${a.id}</h1><p>OS ${esc(a.os)} · Recebedor ${esc(a.receiver)}</p><p>Liberação ${esc(a.user)} · ${new Date(a.created).toLocaleString("pt-BR")}</p>${table(
        ["Material", "Descrição", "Qtd.", "Valor"],
        a.items.map(
          (i) =>
            `<tr><td>${esc(i.code)}</td><td>${esc(i.description)}</td><td>${esc(i.quantity)} ${esc(i.unit)}</td><td>${money(Number(i.total ?? Number(i.quantity) * Number(i.cost)))}</td></tr>`,
        ),
      )}<p>Assinatura do recebedor: _________________________</p>`;
      const screen = $("#screen");
      screen.hidden = true;
      screen.after(area);
      window.print();
      area.remove();
      screen.hidden = false;
    }
    if (b.dataset.edit) {
      const a = att.find((x) => x.id === Number(b.dataset.edit));
      let area = $("#editarea");
      if (!area) {
        area = document.createElement("div");
        area.id = "editarea";
        $("#screen").append(area);
      }
      area.innerHTML = `<form id="editatt" class="panel"><h2>Corrigir atendimento ${a.id}</h2><label>Ordem de serviço<input name="os" value="${esc(a.os)}" pattern="[0-9]{1,20}" required></label><label>Responsável pela retirada<input name="receiver" value="${esc(a.receiver)}" required></label>${a.items.map((i) => `<label>${esc(i.description)}<input name="q${i.material_id}" type="number" min="0.001" step="0.001" value="${esc(i.quantity)}" required></label>`).join("")}<label>Justificativa<input name="reason" required></label><button class="primary">Salvar correção</button></form>`;
      $("#editatt").onsubmit = (ev) => {
        ev.preventDefault();
        run(async () => {
          const f = new FormData(ev.target);
          await api("attendances/" + a.id, {
            method: "PATCH",
            body: {
              revision: a.revision,
              os: f.get("os"),
              receiver: f.get("receiver"),
              reason: f.get("reason"),
              items: a.items.map((i) => ({
                material_id: i.material_id,
                quantity: f.get("q" + i.material_id),
              })),
            },
          });
          await refresh();
          await render();
          message(
            "Correção registrada no histórico. Nova exportação será necessária.",
          );
        });
      };
    }
    if (b.dataset.deleteMaterial) {
      if (
        !confirm(
          "Excluir ou inativar este material? O saldo deve estar zerado.",
        )
      )
        return;
      await api("materials/" + b.dataset.deleteMaterial, { method: "DELETE" });
      await refresh();
      await render();
    }
    if (b.dataset.material) {
      const m = catalog.find((x) => x.id === Number(b.dataset.material));
      const location = prompt("Localização física:", m.location);
      if (location === null) return;
      const description = prompt("Descrição:", m.description);
      if (!description) return;
      const minimum = prompt("Estoque mínimo:", m.minimum);
      if (minimum === null) return;
      await api("materials/" + m.id, {
        method: "PATCH",
        body: { location, description, minimum, active: m.active },
      });
      if (confirm("Registrar também contagem de inventário?")) {
        const counted = prompt("Quantidade contada:", m.balance),
          reason = prompt(
            "Motivo do ajuste (deve também ser conciliado no SAP):",
          );
        if (counted !== null && reason)
          await api("inventory/" + m.id, {
            method: "POST",
            body: { cycle: state.cycle, expected: m.balance, counted, reason },
          });
      }
      await refresh();
      await render();
    }
    if (b.dataset.deleteUser) {
      if (
        !confirm(
          "Excluir cadastro sem histórico ou desativar usuário com histórico?",
        )
      )
        return;
      await api("users/" + b.dataset.deleteUser, { method: "DELETE" });
      await refresh();
      await render();
    }
    if (b.dataset.user) {
      const u = users.find((x) => x.id === Number(b.dataset.user));
      $("#useredit").innerHTML =
        `<form id="edituser" class="panel"><h2>Editar ${esc(u.login)}</h2><label>Nome<input name="name" value="${esc(u.name)}" required></label><label>Login<input name="login" value="${esc(u.login)}" pattern="[a-z0-9_.-]{3,80}" required></label><label>Perfil<select name="role"><option value="user" ${u.role === "user" ? "selected" : ""}>Usuário</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrador</option></select></label><label>Nova senha (opcional)<input name="password" type="password" minlength="12" autocomplete="new-password"></label><label><input type="checkbox" name="active" ${u.active ? "checked" : ""}>Ativo</label><button>Salvar alterações</button></form>`;
      $("#edituser").onsubmit = (ev) => {
        ev.preventDefault();
        run(async () => {
          const f = Object.fromEntries(new FormData(ev.target));
          f.active = ev.target.elements.active.checked;
          await api("users/" + u.id, { method: "PATCH", body: f });
          if (u.id === me.id) {
            location.reload();
            return;
          }
          await refresh();
          await render();
        });
      };
    }
  });
});
$("#sync").onclick = () => run(syncQueue);
window.addEventListener("online", () => {
  if (me) run(syncQueue);
});
window.addEventListener("offline", () => {
  if (me) status();
});
(async () => {
  if ("serviceWorker" in navigator)
    await navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    const r = await api("me");
    me = r.user;
    csrf = r.csrf;
    await activate();
    if ((await queue()).length) await syncQueue();
  } catch (e) {
    if (!navigator.onLine) {
      me = await localGet("lastUser");
      if (me && me.offlineUntil > Date.now()) await activate();
      else
        $("#loginerror").textContent =
          "Reconecte e entre para habilitar o acesso offline.";
    } else if (e.status !== 401) $("#loginerror").textContent = e.message;
  }
})();
