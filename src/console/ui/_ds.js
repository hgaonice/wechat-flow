/** Demo interactions for /_ds (only reachable when WFC_DS_PREVIEW=1). */
(function () {
  "use strict";

  function on(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  on("toast-ok", function () {
    window.DS.toast("已保存覆盖项", "ok");
  });
  on("toast-danger", function () {
    window.DS.toast("推送失败：上游 503（网关超时）", "danger", 6000);
  });
  on("confirm-demo", function () {
    window.DS.confirm({
      title: "删除账号",
      body: "将删除 demo 的本地数据目录引用，公众号内容不受影响。",
      okText: "删除",
      danger: true,
    }).then(function (ok) {
      window.DS.toast(ok ? "已确认（演示）" : "已取消（演示）", ok ? "ok" : "warn");
    });
  });
  on("decision-ok", function () {
    window.DS.toast("已继续推送（演示）", "ok");
  });
  on("decision-no", function () {
    window.DS.toast("已拒绝（演示）", "warn");
  });
  on("toggle-loading", function () {
    var b = document.getElementById("loading-btn");
    if (b) b.classList.toggle("is-loading");
  });

  var bar = document.getElementById("demo-progress");
  if (bar) {
    var v = 0.2;
    setInterval(function () {
      v = v >= 1 ? 0.15 : v + 0.15;
      // CSSOM (el.style.setProperty) is allowed; inline style="" attributes are not.
      bar.style.setProperty("--v", String(v));
    }, 1200);
  }
})();
