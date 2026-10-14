/* wechat-flow console UI. No build step, no dependencies. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
let csrf = "";

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  let body = opts.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    if (typeof body !== "string") body = JSON.stringify(body);
  }
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("x-csrf-token", csrf);

  const res = await fetch(path, { ...opts, method, body, headers, credentials: "same-origin" });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { ok: false, message: text }; }
  if (!res.ok) {
    const err = new Error((parsed && (parsed.message || parsed.code)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed ? parsed.data : null;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function flash(node, text, kind = "") {
  if (!node) return;
  node.textContent = text;
  node.className = `msg ${kind}`;
}

function sourceBadge(source) {
  const label = { inherited: "继承", explicit: "显式", overridden: "覆盖" }[source] || source;
  return el("span", { class: `badge ${source}`, text: label });
}

// ── login ───────────────────────────────────────────────────────────────────

function initLogin() {
  const form = $("#login-form");
  const msg = $("#msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    flash(msg, "");
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: { username: $("#username").value.trim(), password: $("#password").value },
      });
      csrf = data.csrfToken;
      location.href = "/app";
    } catch (err) {
      flash(msg, err.message, "error");
    }
  });
  api("/api/me").then(() => { location.href = "/app"; }).catch(() => {});
}

// ── index ───────────────────────────────────────────────────────────────────

async function initIndex() {
  const me = await api("/api/me");
  csrf = me.csrfToken;
  if ($("#who")) $("#who").textContent = `${me.user.username}（${me.isAdmin ? "管理员" : "负责人"}）`;
  if ($("#nav-settings")) $("#nav-settings").hidden = !me.isAdmin;
  if ($("#nav-admin")) $("#nav-admin").hidden = !me.isAdmin;
  if ($("#create-card")) $("#create-card").hidden = !me.isAdmin;

  const msg = $("#msg");
  const tbody = $("#accounts");

  const render = async () => {
    const { accounts } = await api("/api/accounts");
    tbody.innerHTML = "";
    $("#empty").hidden = accounts.length > 0;
    for (const a of accounts) {
      const enabled = a.enabled === null ? "—" : a.enabled ? el("span", { class: "badge on", text: "启用" }) : el("span", { class: "badge off", text: "停用" });
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("a", { href: `/account?id=${a.id}`, text: a.alias })]),
          el("td", { text: a.displayName || "—" }),
          el("td", { class: "mono", text: a.cdpPort ?? "—" }),
          el("td", { text: a.publishMethod || "—" }),
          el("td", {}, [enabled]),
          el("td", { class: "mono", text: a.overrideKeys.length ? a.overrideKeys.join(", ") : "—" }),
          el("td", {}, [
            el("button", { class: "danger", text: "删除", onclick: () => removeAccount(a) }),
          ]),
        ]),
      );
    }
  };

  const removeAccount = async (a) => {
    if (!confirm(`删除账号 ${a.alias}？仅注销，data/${a.alias}/ 不会被删除。`)) return;
    try {
      await api(`/api/accounts/${a.id}`, { method: "DELETE" });
      flash(msg, `已删除 ${a.alias}`, "ok");
      await render();
    } catch (err) {
      flash(msg, err.message, "error");
    }
  };

  if ($("#create")) {
    $("#create").addEventListener("click", async () => {
      const alias = $("#new-alias").value.trim();
      const portRaw = $("#new-port").value.trim();
      const overrides = {};
      if ($("#new-name").value.trim()) overrides.displayName = $("#new-name").value.trim();
      if (portRaw) overrides.cdpPort = Number(portRaw);
      try {
        await api("/api/accounts", { method: "POST", body: { alias, overrides } });
        flash(msg, `已创建 ${alias}`, "ok");
        $("#new-alias").value = $("#new-name").value = $("#new-port").value = "";
        await render();
      } catch (err) {
        flash(msg, err.message, "error");
      }
    });
  }

  if ($("#change-pw")) {
    $("#change-pw").addEventListener("click", async () => {
      try {
        await api("/api/password", {
          method: "POST",
          body: { currentPassword: $("#cur-pw").value, newPassword: $("#new-pw").value },
        });
        $("#cur-pw").value = $("#new-pw").value = "";
        flash(msg, "密码已更新（其他会话已注销）", "ok");
      } catch (err) {
        flash(msg, err.message, "error");
      }
    });
  }

  if ($("#logout")) {
    $("#logout").addEventListener("click", async () => {
      try { await api("/api/logout", { method: "POST" }); } catch { /* ignore */ }
      location.href = "/";
    });
  }

  await render();
}

// ── account detail ──────────────────────────────────────────────────────────

async function initAccount() {
  const me = await api("/api/me");
  csrf = me.csrfToken;
  if ($("#who")) $("#who").textContent = `${me.user.username}（${me.isAdmin ? "管理员" : "负责人"}）`;

  const id = new URLSearchParams(location.search).get("id");
  if (!id) { location.href = "/app"; return; }
  const msg = $("#msg");
  let detail = null;

  const render = () => {
    $("#alias").textContent = detail.alias;
    const tbody = $("#effective");
    tbody.innerHTML = "";
    for (const key of Object.keys(detail.effective).sort()) {
      const source = detail.sources[key] || "inherited";
      const value = detail.effective[key];
      const cell = el("td", { class: "mono" });
      cell.textContent = typeof value === "string" ? value : JSON.stringify(value);
      const resetBtn = source !== "inherited"
        ? el("button", { class: "ghost", text: "重置为继承", onclick: () => resetOverride(key) })
        : null;
      tbody.append(el("tr", {}, [el("td", { class: "mono", text: key }), el("td", {}, [sourceBadge(source)]), cell, el("td", {}, [resetBtn])]));
    }
    $("#overrides").value = JSON.stringify(detail.overrides, null, 2);
    $("#global").textContent = JSON.stringify(detail.global, null, 2);
  };

  const resetOverride = async (key) => {
    if (!confirm(`移除覆盖项「${key}」，恢复继承全局默认？`)) return;
    try {
      detail = await api(`/api/accounts/${id}/reset-override`, { method: "POST", body: { key } });
      flash(msg, `已重置 ${key}`, "ok");
      render();
    } catch (err) {
      flash(msg, err.message, "error");
    }
  };

  // C5: 邮箱配置 + 凭据（只写不读）
  const splitList = (s) => String(s || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

  const renderEmail = (email) => {
    const configured = email && email.configured;
    $("#email-to").value = configured ? (email.to || []).join(", ") : "";
    $("#email-cc").value = configured ? (email.cc || []).join(", ") : "";
    $("#email-prefix").value = configured ? email.subjectPrefix || "" : "";
  };

  const loadEmail = async () => {
    const email = await api(`/api/accounts/${id}/email`);
    renderEmail(email);
  };

  const renderSecrets = (secrets) => {
    const tbody = $("#secrets-list");
    tbody.innerHTML = "";
    for (const s of secrets) {
      const badge = s.configured
        ? el("span", { class: "badge on", text: "已配置" })
        : el("span", { class: "badge off", text: "未配置" });
      const del = s.configured
        ? el("button", { class: "danger", text: "删除", onclick: () => removeSecret(s.kind) })
        : null;
      tbody.append(
        el("tr", {}, [
          el("td", { class: "mono", text: s.kind }),
          el("td", {}, [badge]),
          el("td", { class: "mono", text: s.keyVersion ?? "—" }),
          el("td", { class: "mono", text: s.updatedAt ?? "—" }),
          el("td", {}, [del]),
        ]),
      );
    }
  };

  const loadSecrets = async () => {
    const { secrets } = await api(`/api/accounts/${id}/secrets`);
    renderSecrets(secrets);
  };

  const removeSecret = async (kind) => {
    if (!confirm(`删除凭据「${kind}」？删除后该凭据立即失效。`)) return;
    try {
      await api(`/api/accounts/${id}/secrets/${kind}`, { method: "DELETE" });
      await loadSecrets();
      flash($("#secret-msg"), `已删除 ${kind}`, "ok");
    } catch (err) {
      flash($("#secret-msg"), err.message, "error");
    }
  };

  $("#email-save").addEventListener("click", async () => {
    const emsg = $("#email-msg");
    try {
      const saved = await api(`/api/accounts/${id}/email`, {
        method: "PUT",
        body: {
          to: splitList($("#email-to").value),
          cc: splitList($("#email-cc").value),
          subjectPrefix: $("#email-prefix").value.trim(),
        },
      });
      renderEmail(saved);
      flash(emsg, "邮箱配置已保存", "ok");
    } catch (err) {
      flash(emsg, err.message, "error");
    }
  });

  $("#email-delete").addEventListener("click", async () => {
    if (!confirm("删除该账号的邮箱配置？删除后隧道变更邮件将不再下发到此账号。")) return;
    try {
      await api(`/api/accounts/${id}/email`, { method: "DELETE" });
      renderEmail(null);
      flash($("#email-msg"), "邮箱配置已删除", "ok");
    } catch (err) {
      flash($("#email-msg"), err.message, "error");
    }
  });

  $("#secret-save").addEventListener("click", async () => {
    const smsg = $("#secret-msg");
    const kind = $("#secret-kind").value;
    const value = $("#secret-value").value;
    if (!value) {
      flash(smsg, "请输入明文后再保存", "error");
      return;
    }
    try {
      await api(`/api/accounts/${id}/secrets/${kind}`, { method: "PUT", body: { value } });
      $("#secret-value").value = "";
      await loadSecrets();
      flash(smsg, `已保存 ${kind}（仅显示状态，不回显明文）`, "ok");
    } catch (err) {
      flash(smsg, err.message, "error");
    }
  });

  $("#save").addEventListener("click", async () => {
    let overrides;
    try {
      overrides = JSON.parse($("#overrides").value || "{}");
    } catch (err) {
      flash(msg, `JSON 解析失败：${err.message}`, "error");
      return;
    }
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
      flash(msg, "覆盖项必须是 JSON 对象", "error");
      return;
    }
    try {
      detail = await api(`/api/accounts/${id}`, { method: "PUT", body: { overrides } });
      flash(msg, "已保存", "ok");
      render();
    } catch (err) {
      flash(msg, err.message, "error");
    }
  });

  $("#reload").addEventListener("click", () => { render(); flash(msg, "已放弃修改"); });

  detail = await api(`/api/accounts/${id}`);
  render();
  await loadEmail();
  await loadSecrets();
}

// ── settings ────────────────────────────────────────────────────────────────

async function initSettings() {
  const me = await api("/api/me");
  csrf = me.csrfToken;
  if (!me.isAdmin) { location.href = "/app"; return; }
  if ($("#who")) $("#who").textContent = `${me.user.username}（管理员）`;
  const msg = $("#msg");
  let global = null;

  const load = async () => {
    const data = await api("/api/settings");
    global = data.global;
    $("#global-json").value = JSON.stringify(global, null, 2);
  };

  $("#save").addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse($("#global-json").value || "{}");
    } catch (err) {
      flash(msg, `JSON 解析失败：${err.message}`, "error");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      flash(msg, "global 必须是 JSON 对象", "error");
      return;
    }
    try {
      await api("/api/settings", { method: "PUT", body: { global: parsed } });
      flash(msg, "已保存并写回 config.json", "ok");
      await load();
    } catch (err) {
      flash(msg, err.message, "error");
    }
  });

  $("#reload").addEventListener("click", async () => { await load(); flash(msg, "已放弃修改"); });

  const renderUsers = async () => {
    const { users } = await api("/api/users");
    const tbody = $("#users");
    tbody.innerHTML = "";
    for (const u of users) {
      tbody.append(
        el("tr", {}, [
          el("td", { class: "mono", text: u.id }),
          el("td", { text: u.username }),
          el("td", { text: u.role === "admin" ? "管理员" : "负责人" }),
          el("td", {}, [u.disabled ? el("span", { class: "badge off", text: "停用" }) : el("span", { class: "badge on", text: "正常" })]),
          el("td", { class: "mono", text: (u.accounts || []).join(", ") || "—" }),
        ]),
      );
    }
  };

  const renderAudit = async () => {
    const { entries } = await api("/api/audit?limit=100");
    const tbody = $("#audit");
    tbody.innerHTML = "";
    for (const e of entries) {
      tbody.append(
        el("tr", {}, [
          el("td", { class: "mono", text: e.ts }),
          el("td", { text: e.action }),
          el("td", { class: "mono", text: e.target || "—" }),
          el("td", {}, [e.ok ? el("span", { class: "badge on", text: "成功" }) : el("span", { class: "badge off", text: "失败" })]),
          el("td", { class: "mono", text: e.ip || "—" }),
        ]),
      );
    }
  };

  await load();
  await renderUsers();
  await renderAudit();
}

// ── bootstrap ───────────────────────────────────────────────────────────────

(async () => {
  const page = document.body.dataset.page;
  try {
    if (page === "login") return initLogin();
    if (page === "index") return await initIndex();
    if (page === "account") return await initAccount();
    if (page === "settings") return await initSettings();
  } catch (err) {
    if (err && err.status === 401) { location.href = "/"; return; }
    console.error(err);
    const msg = $("#msg");
    if (msg) flash(msg, err.message, "error");
    else alert(err.message);
  }
})();
