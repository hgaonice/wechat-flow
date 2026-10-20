"use strict";
/*
 * C5 运维总览页 (/admin).
 *
 * Reuses the globals defined by app.js (loaded first, both `defer`):
 *   $ , api , el , flash — and the `csrf` binding that `api` reads.
 * Read-only overview + two admin actions (restart tunnel / re-send the
 * address mail for a ledger row). No build step, no dependencies.
 *
 * Failure is surfaced, never faked: 403 → 无权限 banner, 503
 * `tunnel_unavailable` → 隧道未启用 banner, otherwise the error text.
 */
(() => {
  const STATUS_LABEL = { up: "在线", down: "离线", error: "错误", expired: "已过期" };
  const statusLabel = (s) => STATUS_LABEL[s] || s || "—";
  const statusClass = (s) => {
    if (s === "up") return "ds-badge ds-badge--ok";
    if (s === "down" || s === "error") return "ds-badge ds-badge--danger";
    return "ds-badge";
  };
  const shortTime = (v) => (typeof v === "string" && v.includes("T") ? `${v.slice(0, 10)} ${v.slice(11, 19)}` : v);

  const showBanner = (text) => {
    const b = $("#banner");
    if (!b) return;
    $("#banner-msg").textContent = text;
    b.hidden = false;
  };
  const hideBanner = () => {
    const b = $("#banner");
    if (b) b.hidden = true;
  };

  function stat(label, value, kind) {
    return el("div", { class: "ds-stat" + (kind ? ` ds-stat--${kind}` : "") }, [
      el("div", { class: "ds-stat__label", text: label }),
      el("div", { class: "ds-stat__value", text: value === null || value === undefined || value === "" ? "—" : String(value) }),
    ]);
  }

  let currentId = null;

  function renderTunnel(t) {
    const host = $("#tunnel-stats");
    host.innerHTML = "";
    const badge = el("span", { class: statusClass(t.status), text: statusLabel(t.status) });
    host.append(
      el("div", { class: "ds-stat" }, [
        el("div", { class: "ds-stat__label", text: "状态" }),
        el("div", { class: "ds-stat__value" }, [badge]),
      ]),
      stat("进程", t.running ? `运行中 (pid ${t.pid ?? "?"})` : "未运行"),
      stat("地址", t.url),
      stat("起始", shortTime(t.since)),
      stat("最近检查", shortTime(t.lastCheckedAt)),
      stat("通知尝试", t.notifyAttempts ?? 0),
      stat("已通知", shortTime(t.notifiedAt) || "未通知"),
    );
    $("#tunnel-detail").textContent = t.detail ? `detail: ${t.detail}` : "";
  }

  function renderServer(s) {
    const host = $("#server-stats");
    host.innerHTML = "";
    host.append(
      stat("主机名", s.hostname),
      stat("内网 IP", s.internalIp),
      stat("控制台端口", s.port),
      stat("当前时间", shortTime(s.now)),
    );
  }

  function renderAccounts(list) {
    const tbody = $("#accounts");
    tbody.innerHTML = "";
    $("#accounts-empty").hidden = list.length > 0;
    for (const a of list) {
      const enabled =
        a.enabled === null
          ? "—"
          : a.enabled
            ? el("span", { class: "ds-badge ds-badge--ok", text: "启用" })
            : el("span", { class: "ds-badge ds-badge--danger", text: "停用" });
      const email = a.email && a.email.configured ? (a.email.to || []).join(", ") : "未配置";
      const kinds = Object.entries(a.secrets || {})
        .filter(([, v]) => v)
        .map(([k]) => k);
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("a", { href: `/account?id=${a.id}`, text: a.alias })]),
          el("td", { text: a.displayName || "—" }),
          el("td", {}, [enabled]),
          el("td", { class: "ds-mono", text: email }),
          el("td", { class: "ds-mono", text: kinds.length ? kinds.join(", ") : "—" }),
          el("td", { class: "ds-mono ds-num", text: a.cdpPort ?? "—" }),
        ]),
      );
    }
  }

  function renderTunnels(list) {
    const tbody = $("#tunnels");
    tbody.innerHTML = "";
    $("#tunnels-empty").hidden = list.length > 0;
    for (const t of list) {
      const badge = el("span", { class: statusClass(t.status), text: statusLabel(t.status) });
      tbody.append(
        el("tr", {}, [
          el("td", { class: "ds-mono ds-num", text: t.id }),
          el("td", {}, [badge]),
          el("td", { class: "ds-mono", text: t.url || "—" }),
          el("td", { class: "ds-mono ds-num", text: t.pid ?? "—" }),
          el("td", { class: "ds-mono", text: shortTime(t.createdAt) || "—" }),
          el("td", { class: "ds-mono", text: shortTime(t.expiresAt) || shortTime(t.lastCheckedAt) || "—" }),
          el("td", { class: "ds-mono", text: shortTime(t.notifiedAt) || "—" }),
          el("td", { class: "ds-mono ds-num", text: t.replacedBy ?? "—" }),
          el("td", {}, [
            el("button", {
              class: "ds-btn ds-btn--ghost ds-btn--sm",
              text: "重发邮件",
              onclick: () => notifyRow(t.id),
            }),
          ]),
        ]),
      );
    }
  }

  async function load() {
    const [overview, tunnelsResp, currentResp] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/tunnels?limit=20"),
      api("/api/tunnels/current"),
    ]);
    renderTunnel(overview.tunnel);
    renderServer(overview.server);
    renderAccounts(overview.accounts);
    renderTunnels(tunnelsResp.tunnels);
    currentId = currentResp.current ? currentResp.current.id : null;
    const jobsMsg = $("#msg");
    jobsMsg.textContent = `运行中任务：${overview.jobsRunning ?? 0}`;
    jobsMsg.hidden = false;
  }

  function handleActionError(err, msg) {
    if (err && err.status === 403) {
      showBanner("无权限：仅管理员可执行此操作。");
      flash(msg, err.message, "error");
      return;
    }
    if (err && err.status === 503) {
      showBanner("隧道未启用（设置 CONSOLE_TUNNEL=1 后可用）。");
      flash(msg, err.message, "error");
      return;
    }
    flash(msg, err.message, "error");
  }

  async function restart() {
    hideBanner();
    const msg = $("#tunnel-msg");
    flash(msg, "正在重启隧道…");
    try {
      await api("/api/tunnels/restart", { method: "POST" });
      flash(msg, "隧道已重启", "ok");
      await load();
    } catch (err) {
      handleActionError(err, msg);
    }
  }

  async function notifyRow(id) {
    hideBanner();
    const msg = $("#tunnels-msg");
    try {
      const r = await api(`/api/tunnels/${id}/notify`, { method: "POST" });
      if (r.sent) {
        flash(msg, `已发送（attempts=${r.attempts}${r.recipients != null ? `，收件人=${r.recipients}` : ""}）`, "ok");
      } else {
        flash(msg, `未发送（${r.skipped || r.error || "未知原因"}）`, "error");
      }
      await load();
    } catch (err) {
      handleActionError(err, msg);
    }
  }

  async function boot() {
    const me = await api("/api/me");
    csrf = me.csrfToken; // app.js binding read by api()
    if ($("#who")) $("#who").textContent = `${me.user.username}（${me.isAdmin ? "管理员" : "负责人"}）`;
    $("#logout").addEventListener("click", async () => {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      location.href = "/";
    });
    if (!me.isAdmin) {
      showBanner("无权限：本页仅管理员可见。");
      return;
    }

    $("#tunnel-restart").addEventListener("click", restart);
    $("#tunnel-notify").addEventListener("click", () => {
      if (currentId === null) {
        flash($("#tunnel-msg"), "当前没有可用隧道行，无法重发", "error");
        return;
      }
      notifyRow(currentId);
    });
    $("#tunnel-refresh").addEventListener("click", () => {
      load().catch((err) => flash($("#tunnel-msg"), err.message, "error"));
    });
    $("#banner-close").addEventListener("click", hideBanner);

    try {
      await load();
    } catch (err) {
      if (err && err.status === 403) {
        showBanner("无权限：无法读取运维总览。");
        return;
      }
      if (err && err.status === 503) {
        showBanner("隧道未启用（设置 CONSOLE_TUNNEL=1 后可用）。");
        return;
      }
      throw err;
    }
  }

  boot().catch((err) => {
    if (err && err.status === 401) {
      location.href = "/";
      return;
    }
    console.error(err);
    showBanner(err.message || String(err));
  });
})();
