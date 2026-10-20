/**
 * wechat-flow console · design-system runtime (C3)
 *
 * Zero dependencies. Must be loaded with `defer` BEFORE any page script:
 * everything here runs synchronously at first execution, so by the time
 * app.js / workbench.js / chat.js bind their handlers the shell already
 * exists and `#who` / `#logout` / `#nav-admin` / `#account-name` are in place.
 *
 * What it does (design.md S-1 — move, never rebuild):
 *   header > a[href]   → sidebar nav items      (ids preserved, so page JS works)
 *   header > .brand    → sidebar brand/subtitle
 *   header             → .ds-main > header.ds-topbar   (only a class is added)
 *   main               → .ds-main > main.ds-content    (class appended, page classes kept)
 *
 * Failure policy: any exception leaves the DOM untouched and logs loudly.
 * A broken shell must never cost the operator access to the console (H5).
 *
 * Public API: DS.mount / DS.toast / DS.confirm / DS.setTheme / DS.theme / DS.icon
 */
(function () {
  "use strict";

  var DS = (window.DS = window.DS || {});

  var THEME_KEY = "wfc.theme";

  var PAGES = {
    login: { title: "登录", href: "" },
    index: { title: "公众号账号", href: "/app" },
    account: { title: "账号详情", href: "/app" },
    settings: { title: "全局设置", href: "/settings" },
    workbench: { title: "内容工作台", href: "/workbench" },
    chat: { title: "Agent 会话", href: "/chat" },
    admin: { title: "运维", href: "/admin" },
  };

  /** href → { group, label, icon } — order inside a group is the array order below. */
  var NAV = [
    { href: "/workbench", group: "内容", label: "工作台", icon: "grid" },
    { href: "/chat", group: "内容", label: "Agent 会话", icon: "chat" },
    { href: "/app", group: "系统", label: "公众号账号", icon: "users" },
    { href: "/admin", group: "系统", label: "运维", icon: "shield" },
    { href: "/settings", group: "系统", label: "全局设置", icon: "gear" },
  ];

  var ICONS = {
    grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3z"/>',
    users:
      '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    gear:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  };

  function icon(name, cls) {
    var body = ICONS[name] || "";
    return (
      '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      "</svg>"
    );
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pageName() {
    return (document.body && document.body.dataset.page) || "";
  }

  // ── theme ────────────────────────────────────────────────────────────────
  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || "auto";
    } catch (e) {
      return "auto";
    }
  }

  function effective(mode) {
    if (mode === "dark" || mode === "light") return mode;
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function applyTheme(mode) {
    var eff = effective(mode);
    document.documentElement.setAttribute("data-theme", eff);
    return eff;
  }

  function setTheme(mode) {
    try {
      if (mode === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch (e) {
      /* private mode — the theme still applies for this page load */
    }
    var eff = applyTheme(mode);
    document.querySelectorAll(".ds-theme-toggle").forEach(function (btn) {
      btn.setAttribute("aria-pressed", eff === "light" ? "true" : "false");
      btn.setAttribute("aria-label", eff === "light" ? "切换到暗色主题" : "切换到亮色主题");
      btn.innerHTML = icon(eff === "light" ? "moon" : "sun");
    });
    return eff;
  }

  DS.theme = function () {
    return document.documentElement.getAttribute("data-theme") || effective(storedTheme());
  };
  DS.setTheme = setTheme;
  DS.icon = icon;

  // ── shell ────────────────────────────────────────────────────────────────
  function navItem(spec) {
    var a = el("a", "ds-nav__item");
    a.href = spec.href;
    a.innerHTML = icon(spec.icon) + '<span class="ds-nav__text"></span>';
    a.querySelector(".ds-nav__text").textContent = spec.label;
    return a;
  }

  /** Build the sidebar; MOVE (not clone) header links so their ids survive. */
  function buildSidebar(header) {
    var sidebar = el("aside", "ds-sidebar");
    sidebar.setAttribute("aria-label", "主导航");

    var brand = el("div", "ds-sidebar__brand");
    var mark = el("span", "ds-sidebar__brand-mark");
    brand.appendChild(mark);
    var brandText = el("span", null, "wechat-flow");
    brand.appendChild(brandText);

    var legacyBrand = header.querySelector(":scope > .brand");
    if (legacyBrand) {
      var t = (legacyBrand.textContent || "").trim();
      if (/wechat-flow/i.test(t)) {
        brandText.textContent = t || "wechat-flow console";
        legacyBrand.remove();
      } else if (t) {
        var sub = el("div", "ds-sidebar__sub");
        legacyBrand.classList.remove("brand");
        sub.appendChild(legacyBrand); // moves the node, keeps its id/behaviour
        sidebar.appendChild(brand);
        sidebar.appendChild(sub);
      }
    }
    if (!sidebar.contains(brand)) sidebar.appendChild(brand);

    var nav = el("nav", "ds-nav");
    var groups = {};
    function groupBox(name) {
      if (groups[name]) return groups[name];
      var g = el("div", "ds-nav__group");
      var label = el("div", "ds-nav__label", name);
      g.appendChild(label);
      nav.appendChild(g);
      groups[name] = g;
      return g;
    }

    // known entries first (stable order), then anything unexpected the page adds
    NAV.forEach(function (spec) {
      var existing = header.querySelector(':scope > a[href="' + spec.href + '"]');
      var item = existing || navItem(spec);
      if (existing) {
        existing.classList.add("ds-nav__item");
        if (!existing.querySelector(".ds-nav__text") && !existing.querySelector("svg")) {
          existing.innerHTML = icon(spec.icon) + '<span class="ds-nav__text"></span>';
          existing.querySelector(".ds-nav__text").textContent = spec.label;
        }
      }
      groupBox(spec.group).appendChild(item);
      if (PAGES[pageName()] && PAGES[pageName()].href === spec.href) {
        item.classList.add("is-active");
        item.setAttribute("aria-current", "page");
      }
    });

    header.querySelectorAll(":scope > a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var known = NAV.some(function (s) {
        return s.href === href;
      });
      if (known) return;
      a.classList.add("ds-nav__item");
      if (!a.querySelector("svg")) {
        var text = (a.textContent || "").trim();
        a.innerHTML = icon("info") + '<span class="ds-nav__text"></span>';
        a.querySelector(".ds-nav__text").textContent = text || href;
      }
      groupBox("其他").appendChild(a);
    });

    sidebar.appendChild(nav);
    var foot = el("div", "ds-sidebar__foot", "自托管 · 无外部依赖");
    sidebar.appendChild(foot);
    return sidebar;
  }

  function decorateTopbar(header) {
    var left = el("div", "ds-topbar__left");
    var menu = el("button", "ds-menu-btn");
    menu.type = "button";
    menu.setAttribute("aria-label", "打开导航");
    menu.setAttribute("aria-expanded", "false");
    menu.innerHTML = icon("menu");
    menu.addEventListener("click", function () {
      var open = document.body.classList.toggle("ds-nav-open");
      menu.setAttribute("aria-expanded", open ? "true" : "false");
    });
    left.appendChild(menu);

    var info = PAGES[pageName()];
    if (info && info.title) {
      var group = "";
      NAV.forEach(function (s) {
        if (s.href === info.href) group = s.group;
      });
      if (group) {
        left.appendChild(el("span", "ds-topbar__crumb", group));
        left.appendChild(el("span", "ds-topbar__crumb", "›"));
      }
      left.appendChild(el("span", "ds-topbar__title", info.title));
    }

    var right = el("div", "ds-topbar__right");
    while (header.firstChild) right.appendChild(header.firstChild);

    var toggle = el("button", "ds-theme-toggle");
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      setTheme(DS.theme() === "light" ? "dark" : "light");
    });
    right.appendChild(toggle);

    header.appendChild(left);
    header.appendChild(right);
    setTheme(storedTheme()); // paints the toggle icon + html[data-theme] (in-DOM now)

    var scrim = el("div", "ds-scrim");
    scrim.addEventListener("click", function () {
      document.body.classList.remove("ds-nav-open");
    });
    document.body.appendChild(scrim);
  }

  function mount() {
    var body = document.body;
    if (!body) return;
    if (body.dataset.dsMounted === "1") return;

    try {
      var header = body.querySelector(":scope > header");
      var main = body.querySelector(":scope > main");

      var shell = el("div", "ds-shell");
      var mainCol = el("div", "ds-main");

      if (header) {
        shell.appendChild(buildSidebar(header));
        header.classList.add("ds-topbar");
        decorateTopbar(header);
        mainCol.appendChild(header);
      }

      if (main) {
        main.classList.add("ds-content");
      } else {
        // anonymous pages (login) have no <main>: wrap whatever the page has
        main = el("main", "ds-content");
        main.id = "ds-content";
        while (body.firstChild) main.appendChild(body.firstChild);
        body.classList.add("ds-anon");
      }
      mainCol.appendChild(main);
      shell.appendChild(mainCol);

      applyTheme(storedTheme());
      body.appendChild(shell);
      body.classList.add("ds-mounted");
      body.dataset.dsMounted = "1";

      // skip link (a11y) — first focusable element on the page
      var skip = el("a", "ds-skip-link", "跳到主要内容");
      skip.href = "#ds-content";
      if (main.id !== "ds-content") main.id = "ds-content";
      body.insertBefore(skip, body.firstChild);

      // mobile drawer: Esc closes
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") body.classList.remove("ds-nav-open");
      });
      // keep the drawer closed after in-app navigation
      document.querySelectorAll(".ds-nav__item").forEach(function (a) {
        a.addEventListener("click", function () {
          body.classList.remove("ds-nav-open");
        });
      });
    } catch (err) {
      // Loud, but never fatal: the un-shelled page is still usable.
      console.error("DS.mount failed — console continues without the shell:", err);
    }
  }

  // ── feedback primitives (used from Step 2 onwards) ───────────────────────
  DS.toast = function (msg, kind, ms) {
    var wrap = document.querySelector(".ds-toast-wrap");
    if (!wrap) {
      wrap = el("div", "ds-toast-wrap");
      wrap.setAttribute("aria-live", "polite");
      document.body.appendChild(wrap);
    }
    var t = el("div", "ds-toast ds-toast--" + (kind || "ok"));
    t.appendChild(el("span", "ds-toast__msg", String(msg)));
    wrap.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, ms || 4000);
    return t;
  };

  DS.confirm = function (opts) {
    var o = typeof opts === "string" ? { body: opts } : opts || {};
    return new Promise(function (resolve) {
      var dlg = el("dialog", "ds-dialog");
      var title = el("h3", "ds-dialog__title", o.title || "确认操作");
      var box = el("div", "ds-dialog__body", o.body || "");
      var row = el("div", "ds-dialog__actions");
      var cancel = el("button", "ds-btn ds-btn--ghost", o.cancelText || "取消");
      var okBtn = el("button", "ds-btn " + (o.danger ? "ds-btn--danger" : "ds-btn--primary"), o.okText || "确定");
      cancel.type = okBtn.type = "button";
      cancel.addEventListener("click", function () {
        dlg.close();
        resolve(false);
      });
      okBtn.addEventListener("click", function () {
        dlg.close();
        resolve(true);
      });
      row.appendChild(cancel);
      row.appendChild(okBtn);
      dlg.appendChild(title);
      dlg.appendChild(box);
      dlg.appendChild(row);
      dlg.addEventListener("close", function () {
        dlg.remove();
      });
      document.body.appendChild(dlg);
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
  };

  DS.mount = mount;
  mount();
})();
