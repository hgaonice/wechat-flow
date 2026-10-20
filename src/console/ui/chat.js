"use strict";
/*
 * C4 agent chat window (human-in-the-loop).
 * Reuses the globals defined by app.js (loaded first, both `defer`):
 *   $ , api , el , flash  — and the `csrf` binding that `api` reads.
 * No build step, no dependencies.
 */
(() => {
  const state = {
    accounts: [],
    accountId: null,
    chatId: null,
    session: null,
    messages: [],
    decisions: [],
    tools: [],
    stream: { text: "", thinking: "" },
    live: false,
    busy: false,
    es: null,
  };

  const $msg = () => $("#msg");
  const STATUS_LABEL = { active: "活跃", idle: "空闲", closed: "已关闭", lost: "已丢失" };
  const statusLabel = (s) => STATUS_LABEL[s] || s || "—";

  // ── rendering ─────────────────────────────────────────────────────────────

  function renderHeader() {
    const s = state.session;
    $("#chat-title").textContent = s ? s.title || `会话 #${s.id}` : "未选择会话";
    const badge = $("#chat-status");
    badge.textContent = s ? statusLabel(s.status) : "—";
    badge.className = `ds-badge${s ? " " + statusVariant(s.status) : ""}`;
    $("#chat-busy").hidden = !state.busy;
    $("#abort").hidden = !state.busy;
    $("#chat-model").textContent = s && s.piSessionId ? `pi:${s.piSessionId.slice(0, 8)}` : s && s.sessionFile ? "有历史会话" : "";
    const ready = Boolean(s);
    for (const id of ["#send", "#steer", "#followup", "#model", "#fork", "#clone", "#abort", "#delete-chat"]) {
      const node = $(id);
      if (node) node.disabled = id === "#abort" ? !state.busy : !ready;
    }
    $("#composer-input").disabled = !ready;
  }

  function renderTranscript() {
    const box = $("#messages");
    box.innerHTML = "";
    for (const m of state.messages) {
      const meta = m.meta || {};
      const errMsg =
        typeof meta.errorMessage === "string"
          ? meta.errorMessage
          : meta.stopReason === "error" && !m.content
            ? "（原因未记录，多为模型网关暂时不可用或限流）"
            : null;
      const bubble = el("div", { class: `ds-bubble ${bubbleVariant(m.role)}${errMsg ? " is-error" : ""}` }, [
        el("div", { class: "ds-bubble__role", text: roleLabel(m.role) }),
      ]);
      if (errMsg) {
        // 模型请求失败：显式报错，不渲染空正文（H5 失败显形）
        bubble.append(el("div", { class: "ds-bubble__error", text: `⚠ 模型请求失败：${errMsg}` }));
      } else {
        bubble.append(el("div", { class: "ds-bubble__body", text: m.content || "" }));
      }
      box.append(bubble);
    }
    renderStreamInto(box);
    renderDecisionsInto(box);
    if (!box.childNodes.length) {
      box.append(
        el("div", { class: "ds-empty" }, [
          el("div", { text: "暂无消息" }),
          el("div", { class: "ds-muted", text: "在下方输入框发送第一条消息，或在左侧新建会话。" }),
        ]),
      );
    }
    renderTools();
    scrollBottom();
  }

  function statusVariant(status) {
    return { active: "ds-badge--ok", busy: "ds-badge--warn", lost: "ds-badge--danger" }[status] || "";
  }

  function bubbleVariant(role) {
    return role === "user" ? "ds-bubble--user" : role === "assistant" ? "ds-bubble--agent" : "is-system";
  }

  function roleLabel(role) {
    return { user: "我", assistant: "agent", system: "系统" }[role] || role;
  }

  function renderStreamInto(box) {
    if (state.stream.thinking) {
      box.append(
        el("div", { class: "ds-bubble is-thinking" }, [
          el("div", { class: "ds-bubble__role", text: "思考中" }),
          el("div", { class: "ds-bubble__body", text: state.stream.thinking }),
        ]),
      );
    }
    if (state.stream.text) {
      box.append(
        el("div", { class: "ds-bubble ds-bubble--agent is-streaming" }, [
          el("div", { class: "ds-bubble__role", text: "agent" }),
          el("div", { class: "ds-bubble__body", text: state.stream.text }),
        ]),
      );
    }
  }

  function renderDecisionsInto(box) {
    if (!state.decisions.length) return;
    box.append(el("div", { class: "ds-decision__head", text: "决策" }));
    for (const d of state.decisions) box.append(decisionCard(d));
  }

  function decisionCard(d) {
    const card = el("div", { class: `ds-decision${d.status === "pending" ? "" : " is-done"}` });
    card.append(el("div", { class: "ds-decision__title", text: d.title || dialogTitle(d.method) }));
    if (d.message) card.append(el("div", { class: "ds-decision__msg", text: d.message }));

    if (d.status !== "pending") {
      card.append(
        el("div", { class: "ds-decision__state", text: `${statusLabelDecision(d.status)}${d.answeredAt ? " · " + d.answeredAt : ""}` }),
      );
      if (d.response !== null && d.response !== undefined) {
        card.append(el("div", { class: "ds-decision__state ds-mono", text: JSON.stringify(d.response) }));
      }
      return card;
    }

    const actions = el("div", { class: "ds-decision__actions" });
    const answer = (body) => submitDecision(d.id, body);
    if (d.method === "confirm") {
      actions.append(el("button", { class: "ds-btn ds-btn--primary ds-btn--sm", text: "确认", onclick: () => answer({ confirmed: true }) }));
      actions.append(el("button", { class: "ds-btn ds-btn--ghost ds-btn--sm", text: "拒绝", onclick: () => answer({ confirmed: false }) }));
    } else if (d.method === "select") {
      const options = Array.isArray(d.options) ? d.options : [];
      if (!options.length) actions.append(el("span", { class: "ds-muted", text: "（无候选）" }));
      for (const opt of options) {
        const label = typeof opt === "string" ? opt : String(opt && (opt.label ?? opt.value ?? JSON.stringify(opt)));
        const value = typeof opt === "string" ? opt : String(opt && (opt.value ?? opt.label ?? ""));
        actions.append(el("button", { class: "ds-btn ds-btn--ghost ds-btn--sm", text: label, onclick: () => answer({ value }) }));
      }
    } else if (d.method === "editor") {
      const ta = el("textarea", { rows: "4" });
      actions.append(ta);
      actions.append(el("button", { class: "ds-btn ds-btn--primary ds-btn--sm", text: "提交", onclick: () => answer({ value: ta.value }) }));
    } else {
      const input = el("input", { type: "text", placeholder: "输入…" });
      actions.append(input);
      actions.append(el("button", { class: "ds-btn ds-btn--primary ds-btn--sm", text: "提交", onclick: () => answer({ value: input.value }) }));
    }
    actions.append(el("span", { class: "ds-spacer" }));
    actions.append(el("button", { class: "ds-btn ds-btn--ghost ds-btn--sm", text: "取消此决策", onclick: () => answer({ cancelled: true }) }));
    card.append(actions);
    return card;
  }

  function dialogTitle(method) {
    return { confirm: "需要确认", select: "请选择", input: "需要输入", editor: "请编辑内容" }[method] || "需要决策";
  }

  function statusLabelDecision(s) {
    return { pending: "等待回复", answered: "已回答", cancelled: "已取消", expired: "已超时", lost: "已丢失" }[s] || s;
  }

  function renderTools() {
    const box = $("#tools");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = state.tools.length === 0;
    for (const t of state.tools.slice(-12)) {
      box.append(
        el("div", { class: `ds-tool-row${t.isError ? " is-error" : ""}` }, [
          el("span", { text: t.phase === "start" ? "▶ " : "✓ " }),
          el("span", { class: "ds-tool-row__name", text: t.name }),
          t.isError ? el("span", { text: " 失败" }) : null,
        ]),
      );
    }
  }

  function scrollBottom() {
    const box = $("#messages");
    box.scrollTop = box.scrollHeight;
  }

  function showBanner(text) {
    $("#banner-msg").textContent = text;
    $("#banner").hidden = false;
  }
  function hideBanner() {
    $("#banner").hidden = true;
  }

  // ── data ──────────────────────────────────────────────────────────────────

  async function loadAccounts() {
    const { accounts } = await api("/api/accounts");
    state.accounts = accounts;
    const sel = $("#account");
    sel.innerHTML = "";
    for (const a of accounts) {
      sel.append(el("option", { value: a.id, text: `${a.alias}${a.displayName ? " · " + a.displayName : ""}` }));
    }
    const qsId = new URLSearchParams(location.search).get("id");
    const pick = accounts.find((a) => String(a.id) === qsId) || accounts[0];
    if (!pick) {
      flash($msg(), "当前用户没有可访问的账号", "error");
      return false;
    }
    sel.value = String(pick.id);
    state.accountId = pick.id;
    return true;
  }

  async function loadSessions() {
    if (!state.accountId) return;
    const { chats } = await api(`/api/accounts/${state.accountId}/chats`);
    const list = $("#chat-list");
    list.innerHTML = "";
    if (!chats.length) {
      list.append(el("li", { class: "ds-muted", text: "暂无会话，点击「新建会话」。" }));
      return;
    }
    for (const c of chats) {
      list.append(
        el("li", { class: `ds-chat-item${c.id === state.chatId ? " is-active" : ""}`, onclick: () => openChat(c.id) }, [
          el("div", { class: "ds-chat-item__title", text: c.title || `会话 #${c.id}` }),
          el("div", { class: "ds-chat-item__meta" }, [
            el("span", { class: `ds-badge ${statusVariant(c.status)}`, text: statusLabel(c.status) }),
            c.busy ? el("span", { class: "ds-badge ds-badge--warn", text: "运行中" }) : null,
            c.pendingDecisions ? el("span", { class: "ds-badge ds-badge--warn", text: `待决策 ${c.pendingDecisions}` }) : null,
          ]),
        ]),
      );
    }
  }

  async function openChat(id) {
    const detail = await api(`/api/chats/${id}`);
    state.chatId = id;
    state.session = detail.session;
    state.messages = detail.messages;
    state.decisions = detail.decisions;
    state.live = detail.live;
    state.busy = detail.busy;
    state.tools = [];
    state.stream = { text: "", thinking: "" };
    hideBanner();
    renderHeader();
    renderTranscript();
    subscribe();
    await loadSessions();
  }

  async function refreshDetail() {
    if (!state.chatId) return;
    const detail = await api(`/api/chats/${state.chatId}`);
    state.session = detail.session;
    state.messages = detail.messages;
    state.decisions = detail.decisions;
    state.live = detail.live;
    state.busy = detail.busy;
    renderHeader();
    renderTranscript();
  }

  function subscribe() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    if (!state.chatId) return;
    const es = new EventSource(`/api/chats/${state.chatId}/stream`);
    state.es = es;
    const on = (type, fn) =>
      es.addEventListener(type, (ev) => {
        let data = {};
        try {
          data = ev.data ? JSON.parse(ev.data) : {};
        } catch {
          data = {};
        }
        fn(data);
      });

    on("chat.delta", (d) => {
      const delta = typeof d.delta === "string" ? d.delta : "";
      if (!delta) return;
      state.stream.text += delta;
      renderTranscript();
    });
    on("chat.thinking", (d) => {
      const delta = typeof d.delta === "string" ? d.delta : "";
      if (!delta) return;
      state.stream.thinking += delta;
      renderTranscript();
    });
    on("chat.message", (m) => {
      state.messages.push(m);
      if (m.role === "assistant") state.stream = { text: "", thinking: "" };
      renderTranscript();
    });
    on("chat.tool_call", (d) => upsertTool({ id: d.toolCallId, name: d.toolName, phase: d.phase }));
    on("chat.tool", (d) => upsertTool({ id: d.toolCallId, name: d.toolName, phase: d.phase, isError: d.isError }));
    on("chat.busy", () => {
      state.busy = true;
      renderHeader();
    });
    on("chat.settled", () => {
      state.busy = false;
      renderHeader();
      loadSessions().catch(() => {});
    });
    on("chat.aborted", () => {
      state.busy = false;
      renderHeader();
    });
    on("chat.status", (d) => flash($msg(), d.text || d.key || "", ""));
    on("chat.notify", (d) => flash($msg(), d.message || d.text || "通知", ""));
    on("chat.title", (d) => {
      if (state.session) state.session.title = d.title;
      renderHeader();
      loadSessions().catch(() => {});
    });
    on("chat.closed", () => {
      state.live = false;
      state.busy = false;
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      renderHeader();
    });
    on("chat.lost", (d) => {
      state.live = false;
      state.busy = false;
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      const stderr = Array.isArray(d.stderr) && d.stderr.length ? `：${d.stderr.slice(-3).join(" / ")}` : "";
      showBanner(`会话进程异常退出（code=${d.code ?? "?"} signal=${d.signal ?? "-"}）${stderr}`);
      renderHeader();
      refreshDetail().catch(() => {});
    });
    on("chat.forked", (d) => flash($msg(), d.cancelled ? "分叉已取消" : "已分叉", "ok"));
    on("chat.cloned", (d) => flash($msg(), d.cancelled ? "克隆已取消" : "已克隆", "ok"));
    on("decision.pending", upsertDecision);
    on("decision.answered", upsertDecision);
    on("decision.expired", upsertDecision);
    on("chat.resync", () => {
      flash($msg(), "事件流存在缺口，正在重新同步…", "");
      refreshDetail().catch(() => {});
    });
    es.onerror = () => {
      /* EventSource auto-reconnects (and resends Last-Event-ID); stay quiet. */
    };
  }

  function upsertTool(t) {
    const key = t.id || `${t.name}:${t.phase}`;
    const existing = state.tools.find((x) => x.key === key);
    if (existing) {
      existing.phase = t.phase;
      if (t.isError !== undefined) existing.isError = t.isError;
    } else {
      state.tools.push({ key, name: t.name || "unknown", phase: t.phase, isError: t.isError });
    }
    renderTools();
  }

  function upsertDecision(d) {
    const i = state.decisions.findIndex((x) => x.id === d.id);
    if (i >= 0) state.decisions[i] = d;
    else state.decisions.push(d);
    renderTranscript();
    loadSessions().catch(() => {});
  }

  // ── commands ──────────────────────────────────────────────────────────────

  async function submitDecision(id, body) {
    try {
      const { decision } = await api(`/api/decisions/${id}`, { method: "POST", body });
      upsertDecision(decision);
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function send(kind) {
    if (!state.chatId) return;
    const input = $("#composer-input");
    const message = input.value.trim();
    if (!message) return;
    const path = kind === "steer" ? "steer" : kind === "follow-up" ? "follow-up" : "messages";
    try {
      const data = await api(`/api/chats/${state.chatId}/${path}`, { method: "POST", body: { message } });
      input.value = "";
      flash($msg(), `已${kind === "steer" ? "引导" : kind === "follow-up" ? "追问" : "发送"}（disposition=${data.disposition}）`, "ok");
      $("#hint").textContent = data.disposition ? `disposition=${data.disposition}` : "";
      if (!state.busy) {
        state.busy = true;
        renderHeader();
      }
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function newChat() {
    try {
      const { chat } = await api(`/api/accounts/${state.accountId}/chats`, { method: "POST", body: {} });
      await loadSessions();
      await openChat(chat.id);
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function deleteChat() {
    if (!state.chatId) return;
    const okDel = await window.DS.confirm({
      title: `删除会话 #${state.chatId}`,
      body: "将关闭该会话的 agent 进程，并把未决决策标记为丢失。此操作不可撤销。",
      okText: "删除",
      danger: true,
    });
    if (!okDel) return;
    try {
      await api(`/api/chats/${state.chatId}`, { method: "DELETE" });
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      state.chatId = null;
      state.session = null;
      state.messages = [];
      state.decisions = [];
      state.tools = [];
      state.stream = { text: "", thinking: "" };
      renderHeader();
      renderTranscript();
      await loadSessions();
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function abort() {
    if (!state.chatId) return;
    try {
      await api(`/api/chats/${state.chatId}/abort`, { method: "POST", body: {} });
      state.busy = false;
      renderHeader();
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function setModel() {
    if (!state.chatId) return;
    const provider = await window.DS.prompt({
      title: "切换模型 · provider",
      label: "provider",
      placeholder: "例如 anthropic / openai",
    });
    if (!provider) return;
    const modelId = await window.DS.prompt({
      title: "切换模型 · modelId",
      label: "modelId",
      placeholder: "例如 claude-sonnet-4-5",
    });
    if (!modelId) return;
    try {
      await api(`/api/chats/${state.chatId}/model`, { method: "POST", body: { provider, modelId } });
      flash($msg(), `模型已切换为 ${provider}/${modelId}`, "ok");
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function fork() {
    if (!state.chatId) return;
    const entryId = await window.DS.prompt({
      title: "分叉会话",
      body: "从指定 entryId 处开新分支（可用 get_entries 获取，暂仅支持手动输入）。",
      label: "entryId",
      placeholder: "例如 12",
    });
    if (!entryId) return;
    try {
      const r = await api(`/api/chats/${state.chatId}/fork`, { method: "POST", body: { entryId } });
      flash($msg(), r.cancelled ? "分叉已取消" : "已分叉", "ok");
      await refreshDetail();
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  async function clone() {
    if (!state.chatId) return;
    const okClone = await window.DS.confirm({
      title: "克隆会话",
      body: "保留完整历史并复制为新分支。",
      okText: "克隆",
    });
    if (!okClone) return;
    try {
      const r = await api(`/api/chats/${state.chatId}/clone`, { method: "POST", body: {} });
      flash($msg(), r.cancelled ? "克隆已取消" : "已克隆", "ok");
    } catch (err) {
      flash($msg(), err.message, "error");
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────

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

    $("#account").addEventListener("change", async (e) => {
      state.accountId = Number(e.target.value);
      state.chatId = null;
      state.session = null;
      state.messages = [];
      state.decisions = [];
      state.tools = [];
      state.stream = { text: "", thinking: "" };
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      renderHeader();
      renderTranscript();
      await loadSessions();
    });
    $("#reload").addEventListener("click", () => loadSessions().catch((err) => flash($msg(), err.message, "error")));
    $("#new-chat").addEventListener("click", newChat);
    $("#delete-chat").addEventListener("click", deleteChat);
    $("#abort").addEventListener("click", abort);
    $("#model").addEventListener("click", setModel);
    $("#fork").addEventListener("click", fork);
    $("#clone").addEventListener("click", clone);
    $("#banner-close").addEventListener("click", hideBanner);
    $("#send").addEventListener("click", () => send("prompt"));
    $("#steer").addEventListener("click", () => send("steer"));
    $("#followup").addEventListener("click", () => send("follow-up"));
    $("#composer-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send("prompt");
      }
    });

    renderHeader();
    renderTranscript();
    if (!(await loadAccounts())) return;
    await loadSessions();
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
