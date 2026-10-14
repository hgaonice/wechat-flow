"use strict";
/*
 * C3 content workbench.
 * Reuses the globals defined by app.js (loaded first, both `defer`):
 *   $ , api , el , flash  — and the `csrf` binding that `api` reads.
 * No build step, no dependencies.
 */
(() => {
  const state = { accountId: null, accounts: [], planRows: [], detail: null, es: null, articles: [] };

  const $msg = () => $("#msg");

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function weekdayCn(date) {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const d = new Date(`${date}T00:00:00`);
    return Number.isNaN(d.getTime()) ? "" : names[d.getDay()];
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  async function boot() {
    const me = await api("/api/me");
    csrf = me.csrfToken; // app.js binding read by api()
    if ($("#who")) $("#who").textContent = `${me.user.username}（${me.isAdmin ? "管理员" : "负责人"}）`;
    if ($("#nav-admin")) $("#nav-admin").hidden = !me.isAdmin;
    $("#logout").addEventListener("click", async () => {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      location.href = "/";
    });

    const qsId = new URLSearchParams(location.search).get("id");
    const { accounts } = await api("/api/accounts");
    state.accounts = accounts;
    const sel = $("#account");
    sel.innerHTML = "";
    if (!accounts.length) {
      sel.append(el("option", { value: "", text: "（无可用账号）" }));
      flash($msg(), "当前用户没有可访问的账号", "error");
      return;
    }
    for (const a of accounts) {
      sel.append(el("option", { value: a.id, text: `${a.alias}${a.displayName ? " · " + a.displayName : ""}` }));
    }
    if (qsId && accounts.some((a) => String(a.id) === qsId)) sel.value = qsId;
    state.accountId = Number(sel.value);
    sel.addEventListener("change", () => {
      state.accountId = Number(sel.value);
      onAccountChanged();
    });

    $("#reload").addEventListener("click", onAccountChanged);
    $("#add-day").addEventListener("click", () => addDayRow());
    $("#save-plan").addEventListener("click", savePlan);
    $("#plan-load").addEventListener("click", loadPlan);
    $("#plan-find").addEventListener("click", findDate);
    $("#gen").addEventListener("click", startGenerate);
    $("#push").addEventListener("click", startPush);
    $("#retry-gen").addEventListener("click", startGenerate);
    $("#retry-push").addEventListener("click", startPush);
    $("#regen").addEventListener("click", regenerate);
    $("#diff-btn").addEventListener("click", runDiff);

    $("#action-date").value = todayISO();
    $("#find-date").value = todayISO();
    await onAccountChanged();
  }

  function currentAccount() {
    return state.accounts.find((a) => a.id === state.accountId);
  }

  async function onAccountChanged() {
    const acc = currentAccount();
    if ($("#account-name")) $("#account-name").textContent = acc ? acc.alias : "";
    closeEs();
    state.detail = null;
    $("#detail-card").hidden = true;
    await Promise.all([loadPlan(), loadArticles()]);
  }

  // ── plan editor ──────────────────────────────────────────────────────────

  function addDayRow(day = {}) {
    const tbody = $("#plan-days");
    const tr = el("tr", {});
    const dateI = el("input", { type: "date", value: day.date || $("#find-date").value || todayISO() });
    const weekI = el("input", { value: day.weekday || weekdayCn(dateI.value), placeholder: "周二" });
    const moduleI = el("input", { value: day.module || "", placeholder: "函数" });
    const topicI = el("input", { value: day.topic || "", placeholder: "一次函数图象" });
    const summaryI = el("input", { value: day.summary || "", placeholder: "概要" });
    const outlineI = el("input", {
      value: Array.isArray(day.outline) ? day.outline.join(", ") : day.outline || "",
      placeholder: "引入, 讲解, 练习",
    });
    const wordsI = el("input", { type: "number", value: day.targetWords || 1200, min: 300, max: 5000 });
    dateI.addEventListener("change", () => {
      weekI.value = weekdayCn(dateI.value);
    });
    const entry = { tr, dateI, weekI, moduleI, topicI, summaryI, outlineI, wordsI };
    const removeBtn = el("button", {
      class: "danger",
      text: "×",
      title: "删除该天",
      onclick: () => {
        tr.remove();
        state.planRows = state.planRows.filter((r) => r !== entry);
      },
    });
    for (const c of [dateI, weekI, moduleI, topicI, summaryI, outlineI, wordsI, removeBtn]) {
      tr.append(el("td", {}, [c]));
    }
    tbody.append(tr);
    state.planRows.push(entry);
  }

  function setPlanRows(days) {
    $("#plan-days").innerHTML = "";
    state.planRows = [];
    for (const d of days) addDayRow(d);
    if (!days.length) addDayRow({});
  }

  function collectPlanDays() {
    return state.planRows.map((r) => {
      const outline = r.outlineI.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        date: r.dateI.value,
        weekday: r.weekI.value.trim() || weekdayCn(r.dateI.value),
        module: r.moduleI.value.trim(),
        topic: r.topicI.value.trim(),
        summary: r.summaryI.value.trim(),
        outline,
        targetWords: Number(r.wordsI.value) || 1200,
      };
    });
  }

  async function loadPlan() {
    const type = $("#period-type").value;
    const key = $("#period-key").value.trim();
    if (!key) {
      setPlanRows([]);
      return;
    }
    try {
      const { plans } = await api(
        `/api/accounts/${state.accountId}/plans?period_type=${encodeURIComponent(type)}&period_key=${encodeURIComponent(key)}`,
      );
      const plan = plans[0];
      const days = plan && plan.items && Array.isArray(plan.items.days) ? plan.items.days : [];
      setPlanRows(days);
      flash($("#plan-msg"), plan ? `已载入 ${type} ${key}（${days.length} 天）` : `未找到 ${type} ${key}，可编辑后保存`, "");
    } catch (err) {
      flash($("#plan-msg"), err.message, "error");
    }
  }

  async function findDate() {
    const date = $("#find-date").value;
    if (!date) return;
    try {
      const found = await api(`/api/accounts/${state.accountId}/plans/find?date=${encodeURIComponent(date)}`);
      if (!found.found) {
        flash($("#plan-msg"), `${date} 不在任何计划中`, "error");
        return;
      }
      $("#period-type").value = found.periodKey.includes("W") ? "week" : "month";
      $("#period-key").value = found.periodKey;
      await loadPlan();
      flash($("#plan-msg"), `已定位 ${found.periodKey} 中的 ${date}`, "ok");
    } catch (err) {
      flash($("#plan-msg"), err.message, "error");
    }
  }

  async function savePlan() {
    const type = $("#period-type").value;
    const key = $("#period-key").value.trim();
    const days = collectPlanDays();
    try {
      await api(`/api/accounts/${state.accountId}/plans`, {
        method: "PUT",
        body: { period_type: type, period_key: key, items: { days } },
      });
      flash($("#plan-msg"), `已保存 ${type} ${key}（${days.length} 天）并同步到 engine`, "ok");
    } catch (err) {
      flash($("#plan-msg"), err.message, "error");
    }
  }

  // ── jobs + SSE ───────────────────────────────────────────────────────────

  const bar = () => $("#bar");
  const logEl = () => $("#job-log");

  function appendLog(level, text) {
    const box = logEl();
    const line = el("div", { class: level || "info" });
    line.textContent = text;
    box.append(line);
    while (box.childNodes.length > 500) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function closeEs() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
  }

  function trackJob(jobId, { onDone } = {}) {
    closeEs();
    logEl().textContent = "";
    bar().style.width = "0%";
    $("#fail-panel").hidden = true;
    $("#job-status").textContent = `任务 #${jobId} 已入队…`;
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    state.es = es;

    es.addEventListener("job.progress", (e) => {
      const d = JSON.parse(e.data);
      const pct = Math.max(0, Math.min(100, d.progress || 0));
      bar().style.width = `${pct}%`;
      $("#job-status").textContent = `#${jobId} ${d.status} · ${pct}%${d.message ? " · " + d.message : ""}`;
    });
    es.addEventListener("job.log", (e) => {
      const d = JSON.parse(e.data);
      appendLog(d.level, `[${fmtTime(d.ts)}] ${d.message}`);
    });
    es.addEventListener("job.done", (e) => {
      const d = JSON.parse(e.data);
      const ok = d.status === "succeeded";
      bar().style.width = "100%";
      $("#job-status").textContent = `#${jobId} 结束：${d.status}`;
      if (!ok && d.error) {
        $("#fail-msg").textContent = `失败：${d.error}`;
        $("#fail-panel").hidden = false;
      }
      appendLog(ok ? "info" : "error", `任务结束：${d.status}${d.error ? " · " + d.error : ""}`);
      closeEs();
      if (onDone) onDone(d);
    });
    es.onerror = () => {
      /* transient: the browser auto-reconnects with Last-Event-ID; job.done closes it */
    };
  }

  async function startGenerate() {
    const date = $("#action-date").value;
    if (!date) {
      flash($msg(), "请选择日期", "error");
      return;
    }
    try {
      const { job } = await api(`/api/accounts/${state.accountId}/articles/generate`, {
        method: "POST",
        body: { date },
      });
      flash($msg(), `已入队生成任务 #${job.id}`, "ok");
      trackJob(job.id, {
        onDone: async (d) => {
          await loadArticles();
          if (d.status === "succeeded" && state.articles.length) await loadDetail(state.articles[0].id);
        },
      });
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function startPush() {
    const date = $("#action-date").value;
    if (!date) {
      flash($msg(), "请选择日期", "error");
      return;
    }
    const openId = state.detail ? state.detail.article.id : null;
    try {
      const { job } = await api(`/api/accounts/${state.accountId}/jobs`, {
        method: "POST",
        body: { kind: "publish", payload: { date, reuse: true } },
      });
      flash($msg(), `已入队推送任务 #${job.id}`, "ok");
      trackJob(job.id, {
        onDone: async () => {
          await loadArticles();
          if (openId) await loadDetail(openId);
        },
      });
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  // ── articles ─────────────────────────────────────────────────────────────

  async function loadArticles() {
    try {
      const { articles } = await api(`/api/accounts/${state.accountId}/articles`);
      state.articles = articles;
      const tbody = $("#articles");
      tbody.innerHTML = "";
      $("#articles-empty").hidden = articles.length > 0;
      for (const a of articles) {
        const status = el("span", {
          class: `badge ${a.status === "pushed" ? "on" : "off"}`,
          text: a.status,
        });
        const verify =
          a.verified === null
            ? el("span", { class: "muted", text: "—" })
            : a.verified
              ? el("span", { class: "badge on", text: "通过" })
              : el("span", { class: "badge off", text: "未通过" });
        tbody.append(
          el("tr", {}, [
            el("td", { class: "mono", text: `v${a.version}` }),
            el("td", { class: "mono", text: a.date }),
            el("td", { text: a.title || "—" }),
            el("td", {}, [status]),
            el("td", {}, [verify]),
            el("td", { class: "mono", text: a.parentId ? `#${a.parentId}` : "—" }),
            el("td", {}, [
              el("button", { class: "ghost", text: "查看", onclick: () => loadDetail(a.id) }),
            ]),
          ]),
        );
      }
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function loadDetail(id) {
    try {
      const d = await api(`/api/articles/${id}`);
      state.detail = d;
      const a = d.article;
      $("#detail-card").hidden = false;
      $("#detail-meta").textContent = `#${a.id} · v${a.version} · ${a.date} · ${a.status} · 文件 ${a.filePath || "—"}`;
      $("#article-md").textContent = d.content || "（快照文件缺失或为空）";

      const cover = $("#cover");
      if (d.coverUrl) {
        cover.src = d.coverUrl;
        cover.hidden = false;
        $("#cover-missing").hidden = true;
      } else {
        cover.hidden = true;
        $("#cover-missing").hidden = false;
      }

      const verify = $("#verify");
      verify.innerHTML = "";
      verify.append(
        a.verified === null
          ? el("span", { class: "muted", text: "尚无推送记录" })
          : a.verified
            ? el("span", { class: "badge on", text: "草稿校验通过" })
            : el("span", { class: "badge off", text: "草稿校验未通过" }),
      );
      if (a.verifyDetail) verify.append(el("div", { class: "muted", text: a.verifyDetail }));

      const tb = $("#drafts");
      tb.innerHTML = "";
      for (const dr of d.drafts) {
        tb.append(
          el("tr", {}, [
            el("td", { class: "mono", text: fmtTime(dr.pushAt) }),
            el("td", {}, [
              dr.verified
                ? el("span", { class: "badge on", text: "通过" })
                : el("span", { class: "badge off", text: "未通过" }),
            ]),
            el("td", { class: "mono", text: dr.verifyDetail || "—" }),
          ]),
        );
      }

      const chips = $("#versions");
      chips.innerHTML = "";
      for (const v of d.versions) {
        chips.append(
          el("button", {
            class: `chip${v.id === a.id ? " active" : ""}`,
            text: `v${v.version}${v.parentId ? "" : "（初版）"}`,
            onclick: () => loadDetail(v.id),
          }),
        );
      }

      const sa = $("#diff-a");
      const sb = $("#diff-b");
      sa.innerHTML = "";
      sb.innerHTML = "";
      for (const v of d.versions) {
        const label = `v${v.version} #${v.id}`;
        sa.append(el("option", { value: v.id, text: label }));
        sb.append(el("option", { value: v.id, text: label }));
      }
      if (d.versions.length >= 2) {
        sa.value = d.versions[0].id;
        sb.value = d.versions[d.versions.length - 1].id;
      }
      $("#diff").innerHTML = "";
      $("#feedback").value = "";
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function regenerate() {
    if (!state.detail) return;
    const articleId = state.detail.article.id;
    const date = state.detail.article.date;
    const feedback = $("#feedback").value.trim();
    try {
      const { job } = await api(`/api/articles/${articleId}/regenerate`, {
        method: "POST",
        body: { feedback },
      });
      flash($("#detail-msg"), `已入队重生成任务 #${job.id}`, "ok");
      trackJob(job.id, {
        onDone: async (d) => {
          await loadArticles();
          if (d.status === "succeeded") {
            const newest = state.articles.find((x) => x.date === date);
            if (newest) await loadDetail(newest.id);
          }
        },
      });
    } catch (err) {
      flash($("#detail-msg"), err.message, "error");
    }
  }

  // ── version diff ─────────────────────────────────────────────────────────

  async function runDiff() {
    const aId = Number($("#diff-a").value);
    const bId = Number($("#diff-b").value);
    if (!aId || !bId) return;
    try {
      const [A, B] = await Promise.all([api(`/api/articles/${aId}`), api(`/api/articles/${bId}`)]);
      const rows = lineDiff((A.content || "").split("\n"), (B.content || "").split("\n"));
      const box = $("#diff");
      box.innerHTML = "";
      for (const r of rows) {
        const line = el("div", { class: r.t });
        line.textContent = (r.t === "add" ? "+ " : r.t === "del" ? "- " : "  ") + r.l;
        box.append(line);
      }
      const changed = rows.filter((r) => r.t !== "ctx").length;
      flash($("#detail-msg"), `v${A.article.version} → v${B.article.version}：${changed} 行差异`, "");
    } catch (err) {
      flash($("#detail-msg"), err.message, "error");
    }
  }

  /** LCS line diff; falls back to a set diff for very large inputs. */
  function lineDiff(a, b) {
    const n = a.length;
    const m = b.length;
    if (n * m > 4000000) {
      const bs = new Set(b);
      const as = new Set(a);
      const out = [];
      for (const l of a) if (!bs.has(l)) out.push({ t: "del", l });
      for (const l of b) if (!as.has(l)) out.push({ t: "add", l });
      return out;
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ t: "ctx", l: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ t: "del", l: a[i++] });
      } else {
        out.push({ t: "add", l: b[j++] });
      }
    }
    while (i < n) out.push({ t: "del", l: a[i++] });
    while (j < m) out.push({ t: "add", l: b[j++] });
    return out;
  }

  boot().catch((err) => {
    if (err && err.status === 401) {
      location.href = "/";
      return;
    }
    console.error(err);
    const m = $msg();
    if (m) flash(m, err.message, "error");
  });
})();
