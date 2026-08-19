/**
 * dsh-notifier — 浏览器端（自包含，无 import）。
 * 自动订阅 /events SSE；页面隐藏时用 Notification API 弹通知；侧边栏「通知」
 * 入口提供配置面板（事件开关/系统通知/浏览器通知/免打扰时段）。
 * 路由常量与宿主端 ROUTES 一致（smoke 断言）。
 */
// 浏览器半区干净模块：只导出 apply/inject，契约外壳（IIFE/load/Symbol.toStringTag 装配）
// 由 scripts/build-client.ts 统一生成——源码不写任何 loader 痕迹。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";

  var ROUTES = {
    config: "/api/dsh-notifier/config",
    events: "/api/dsh-notifier/events",
    health: "/api/dsh-notifier/health",
    test: "/api/dsh-notifier/test",
    history: "/api/dsh-notifier/history",
  };
  var ENTRY_SELECTOR = "[data-dsh-notifier-entry]";
  var PANEL_ID = "dsh-notifier-panel";
  var STYLE_ID = "dsh-notifier-style";
  var ICON = "🔔";
  // 浏览器通知图标（内联 SVG data URL，零外部资源；铃铛造型）。
  var NOTIFY_ICON =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0f9d6e"/><path fill="#fff" d="M12 4a1 1 0 0 1 1 1v.55A5.5 5.5 0 0 1 17.5 11v2.3l1.45 1.45a1 1 0 0 1-.7 1.7H5.75a1 1 0 0 1-.7-1.7L6.5 13.3V11A5.5 5.5 0 0 1 11 5.55V5a1 1 0 0 1 1-1zm-2.5 13a2.5 2.5 0 0 0 5 0h-5z"/></svg>'
    );

  var EVENT_KEYS = [
    ["notifyAsk", "审批等待"],
    ["notifyQuestion", "向你提问"],
    ["notifyTaskDone", "任务完成"],
    ["notifySubagentDone", "子任务完成"],
    ["notifyTaskError", "任务出错"],
    ["notifyTurnEnd", "轮次完成"],
  ];
  var CHANNEL_KEYS = [
    ["systemNotify", "系统通知"],
    ["browserNotify", "浏览器通知"],
    ["notifyWhenVisible", "页面可见时也弹"],
    ["notifySound", "通知声音"],
  ];
  var KIND_LABELS: Record<string, string> = {
    ask: "审批等待",
    question: "向你提问",
    done: "任务完成",
    "subagent-done": "子任务完成",
    error: "任务出错",
    "turn-end": "轮次完成",
    test: "测试",
  };

  function injectStyle() {
    // 每次 apply 直接重建 <style>（无 cssVersion 字符串比对）：行为等价，
    // 且消除「改 CSS 忘 bump 版本号则热更新不生效」的手动状态漂移。
    var existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function toast(message: any) {
    var el = document.createElement("div");
    el.className = "dn-toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3000);
  }

  /**
   * 403（loopback 围栏拒绝）时的可操作引导文案，供各处 catch 复用。
   * 非 403 错误返回空串，避免给普通失败粘贴无关提示。
   */
  function accessHint(error: any) {
    var text = String((error && error.message) || "");
    if (text.indexOf("403") === -1) return "";
    return "（若为局域网直连访问，通知服务仅允许回环调用而被拒：请用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 ssh -L 3080:127.0.0.1:3080 隧道访问后刷新）";
  }

  /**
   * 请求浏览器通知权限（必须在用户手势内调用，Chrome 才接受）。
   * 完成后回调（无论结果），用于刷新面板权限状态。
   */
  function requestPermission(onDone: any) {
    if (!("Notification" in window)) return;
    try {
      Notification.requestPermission().then(function () {
        if (onDone) onDone();
      }).catch(function () {
        if (onDone) onDone();
      });
    } catch (error) {
      if (onDone) onDone();
    }
  }

  /** 发送测试通知：POST /test 触发宿主端系统通知 + SSE 广播（绕过免打扰）。
   *  防抖：800ms 内重复点击忽略，防止狂点导致通知风暴。 */
  var lastTestAt = 0;
  function sendTestNotification() {
    var now = Date.now();
    if (now - lastTestAt < 800) {
      toast("点击太频繁，稍等片刻");
      return;
    }
    lastTestAt = now;
    fetch(ROUTES.test, { method: "POST" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        toast("测试通知已发送（在线 " + data.sseConnections + " 个连接）");
      })
      .catch(function (error) {
        toast("发送测试通知失败：" + error.message + accessHint(error));
      });
  }

  function el(tag: any, attrs: any, children: any = undefined) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        var value = attrs[key];
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key === "onClick") node.addEventListener("click", value);
        else if (key === "onChange") node.addEventListener("change", value);
        else if (key === "style") node.style.cssText = value;
        else if (key in node && key !== "list") node[key] = value;
        else node.setAttribute(key, value);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i += 1) node.appendChild(children[i]);
    }
    return node;
  }

  /** 面板拖拽：Pointer Events 重写（触屏统一——iOS Safari 兼容鼠标事件不可靠：
   *  触摸拖动不产生持续 mousemove，旧实现触屏完全拖不动）。配 CSS
   *  .dn-header{touch-action:none} 防滚动手势抢占；指针捕获避免移出面板丢事件；
   *  位置 clamp 在视口内（防拖出「失踪」），持久化 localStorage。
   */
  function attachDrag(header: any, panel: any) {
    header.addEventListener("pointerdown", function (e: any) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target && e.target.closest("button")) return; // 按钮点击不触发拖拽
      var rect = panel.getBoundingClientRect();
      var startX = e.clientX;
      var startY = e.clientY;
      var startLeft = rect.left;
      var startTop = rect.top;
      var moved = false;
      function clampPos(left: number, top: number) {
        var pw = panel.offsetWidth || 320;
        var ph = panel.offsetHeight || 300;
        return {
          left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - pw)),
          top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - ph)),
        };
      }
      function onMove(ev: any) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // 位移阈值，区分点击
        moved = true;
        var pos = clampPos(startLeft + dx, startTop + dy);
        panel.style.left = pos.left + "px";
        panel.style.top = pos.top + "px";
        panel.style.right = "auto";
      }
      function onUp() {
        panel.removeEventListener("pointermove", onMove);
        panel.removeEventListener("pointerup", onUp);
        panel.removeEventListener("pointercancel", onUp);
        try {
          panel.releasePointerCapture(e.pointerId);
        } catch (err) {
          // 忽略
        }
        if (moved) {
          try {
            localStorage.setItem(PANEL_ID + ":pos", JSON.stringify({ left: panel.style.left, top: panel.style.top }));
          } catch (err) {
            // localStorage 不可用（隐私模式等）仅不持久化
          }
        }
      }
      try {
        panel.setPointerCapture(e.pointerId);
      } catch (err) {
        // 不支持捕获的浏览器：移出面板时可能丢事件，可接受
      }
      panel.addEventListener("pointermove", onMove);
      panel.addEventListener("pointerup", onUp);
      panel.addEventListener("pointercancel", onUp);
      e.preventDefault();
    });
  }

  /** 恢复上次拖拽位置（无则用 CSS 默认 left:12px）；越界值 clamp 回视口内。 */
  function restorePanelPos(panel: any) {
    try {
      var saved = JSON.parse(localStorage.getItem(PANEL_ID + ":pos") || "null");
      if (saved && saved.left) {
        var pw = panel.offsetWidth || 320;
        var ph = panel.offsetHeight || 300;
        var mw = window.innerWidth;
        var mh = window.innerHeight;
        var left = Math.min(Math.max(0, parseFloat(saved.left) || 12), Math.max(0, mw - pw));
        var top = Math.min(Math.max(0, parseFloat(saved.top) || 0), Math.max(0, mh - ph));
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        panel.style.right = "auto";
      }
    } catch (err) {
      // 忽略损坏的存储
    }
  }

  function switchEl(key: any, label: any, config: any, onToggle: any) {
    var row = el("div", { class: "dn-row" });
    // 整行作为触控目标（≥44px 见 CSS）：文本 label 用 htmlFor 关联 input，
    // 点文字也能切换（WCAG 2.5.5 目标尺寸）
    var inputId = "dn-sw-" + key + "-" + Math.random().toString(36).slice(2);
    var text = el("label", { for: inputId, class: "dn-row-text" });
    text.appendChild(el("span", { text: label }));
    row.appendChild(text);
    var wrap = el("label", { class: "dn-switch" });
    var input = el("input", { type: "checkbox", id: inputId, checked: config[key] === true, onChange: function () {
      config[key] = input.checked;
      onToggle(config);
    } });
    var track = el("span", { class: "dn-track" });
    track.appendChild(el("span", { class: "dn-thumb" }));
    wrap.appendChild(input);
    wrap.appendChild(track);
    row.appendChild(wrap);
    return row;
  }

  var configCache: any = null;

  /** 启动时预取配置（不依赖打开面板）：可见性判断要用 notifyWhenVisible。 */
  function refreshConfig() {
    fetch(ROUTES.config, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (config) {
        configCache = config;
      })
      .catch(function (error) {
        // 失败静默（打开面板时会再次拉取）；403（局域网直连被回环围栏拒绝）时给引导
        console.warn("[dsh-notifier] 配置预取失败：", error);
        if (accessHint(error) !== "") toast("通知通道不可用" + accessHint(error));
      });
  }

  function saveConfig(config: any) {
    fetch(ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        configCache = data;
      })
      .catch(function (error) {
        toast("保存配置失败：" + error.message + accessHint(error));
      });
  }

  function fmtTime(ts: any) {
    var d = new Date(ts);
    function pad(n: any) {
      return n < 10 ? "0" + n : String(n);
    }
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  /** 通知记录列表（最近 10 条，倒序）：日志验证的入口。 */
  function renderHistory(holder: any) {
    holder.textContent = "";
    fetch(ROUTES.history, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        holder.textContent = "";
        var records = data.records || [];
        if (records.length === 0) {
          holder.appendChild(el("div", { class: "dn-note", text: "暂无通知记录（点「发送测试通知」可生成一条）" }));
          return;
        }
        var shown = records.slice(-10).reverse();
        for (var i = 0; i < shown.length; i += 1) {
          var r = shown[i];
          var row = el("div", { class: "dn-row", style: "flex-direction:column;align-items:flex-start;gap:2px" });
          var head = el("div", { style: "display:flex;gap:6px;align-items:center" });
          head.appendChild(el("span", { text: fmtTime(r.ts), style: "color:var(--dsw-alias-label-tertiary,#8a919c)" }));
          head.appendChild(el("span", { text: KIND_LABELS[r.kind] || r.kind, style: "font-weight:600" }));
          if (r.suppressed === "quiet") {
            // 免打扰拦截未发出：标记，让用户区分「已发」与「被免打扰拦下」
            head.appendChild(el("span", { text: "免打扰拦截未发出", style: "color:var(--dsw-alias-label-tertiary,#8a919c);font-size:10px;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);border-radius:8px;padding:0 4px" }));
          }
          row.appendChild(head);
          row.appendChild(el("div", { text: r.title + "：" + r.message, style: "color:var(--dsw-alias-label-secondary,#5f6672)" }));
          holder.appendChild(row);
        }
      })
      .catch(function (error) {
        holder.appendChild(el("div", { class: "dn-note", text: "加载记录失败：" + error.message + accessHint(error) }));
      });
  }

  function renderPanel(panel: any) {
    var body = panel.querySelector(".dn-body");
    body.textContent = "";
    fetch(ROUTES.config, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (config) {
        configCache = config;
        body.textContent = "";

        var events = el("div", { class: "dn-section" });
        events.appendChild(el("div", { class: "dn-section-title", text: "通知事件" }));
        for (var i = 0; i < EVENT_KEYS.length; i += 1) {
          events.appendChild(switchEl(EVENT_KEYS[i][0], EVENT_KEYS[i][1], config, saveConfig));
        }
        body.appendChild(events);

        var channels = el("div", { class: "dn-section" });
        channels.appendChild(el("div", { class: "dn-section-title", text: "通知通道" }));
        for (var j = 0; j < CHANNEL_KEYS.length; j += 1) {
          channels.appendChild(switchEl(CHANNEL_KEYS[j][0], CHANNEL_KEYS[j][1], config, saveConfig));
        }
        if ("Notification" in window) {
          if (!isSecureContext()) {
            // 非安全上下文（局域网 HTTP）：系统弹窗被浏览器禁止，降级提醒已启用
            channels.appendChild(el("div", { class: "dn-note", text: "当前为局域网 HTTP 访问（非安全上下文），浏览器禁止系统级弹窗，已启用「页面内横幅 + 提示音 + 标题提醒」降级通道。如需系统弹窗，请改用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 localhost 隧道访问（如 ssh -L 3080:127.0.0.1:3080）后刷新页面。" }));
          } else {
            var permText = "";
            if (Notification.permission === "granted") permText = "浏览器通知权限：已授权 ✓";
            else if (Notification.permission === "denied") permText = "浏览器通知权限：已拒绝（请在浏览器站点设置中允许本页通知）";
            else permText = "浏览器通知权限：未授权（点击下方按钮在浏览器弹窗中允许）";
            channels.appendChild(el("div", { class: "dn-note", text: permText }));
            if (Notification.permission === "default") {
              // 请求授权必须在用户手势内（点击按钮），浏览器才会接受
              channels.appendChild(el("button", {
                type: "button",
                text: "请求通知权限",
                style: "margin:6px 0 0;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);border-radius:6px;padding:4px 10px;cursor:pointer;color:inherit",
                onClick: function () {
                  requestPermission(function () {
                    renderPanel(panel); // 刷新权限状态显示
                  });
                },
              }));
            }
          }
        } else {
          // 无 Web Notifications API（iOS Safari 普通标签页等）：渲染设备能力说明，
          // 避免「通知通道区整个消失」让用户误以为插件坏了。
          channels.appendChild(el("div", { class: "dn-note", text: "当前设备不支持系统级通知（如 iOS Safari 普通标签页无 Web Notifications）。可用通道：页面可见时的横幅 + 提示音（需保持页面打开），或经 dsh-lan-proxy 的 https://<局域网IP>:3443 访问并「添加到主屏幕」后获得 PWA 级通知能力。" }));
        }
        // 测试按钮：端到端验证通知链路（宿主 → SSE → 浏览器提醒）。
        // 移出 Notification 门：iOS 等无 Notification API 的设备也能自测宿主链路。
        channels.appendChild(el("button", {
          type: "button",
          text: "发送测试通知",
          style: "margin:6px 0 0;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);border-radius:6px;padding:4px 10px;cursor:pointer;color:inherit",
          onClick: sendTestNotification,
        }));
        body.appendChild(channels);

        // 合并/去重：错误合并窗口与完成聚合窗口（ms，0=关闭；沿用配置面板）
        var mergeSection = el("div", { class: "dn-section" });
        mergeSection.appendChild(el("div", { class: "dn-section-title", text: "合并/去重" }));
        function mergeField(objKey: any, label: any, max: number) {
          var field = el("div", { class: "dn-row", style: "min-height:36px" });
          field.appendChild(el("span", { style: "flex:1", text: label + "（ms，0=关）" }));
          var input = el("input", { type: "number", min: "0", step: "1000", value: String(config[objKey] || 0), style: "width:84px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:inherit;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);border-radius:6px;padding:3px 6px;margin:6px 0", onChange: function () {
            var v = parseInt(input.value, 10);
            config[objKey] = Number.isFinite(v) && v >= 0 && v <= max ? v : 0;
            saveConfig(config);
          } });
          field.appendChild(input);
          mergeSection.appendChild(field);
        }
        mergeField("errorMergeWindowMs", "错误合并窗口", 3600000);
        mergeField("doneMergeWindowMs", "完成聚合窗口", 60000);
        body.appendChild(mergeSection);

        var quiet = el("div", { class: "dn-section" });
        quiet.appendChild(el("div", { class: "dn-section-title", text: "免打扰时段" }));
        var quietRow = el("div", { class: "dn-row" });
        quietRow.appendChild(el("span", { text: "启用" }));
        var quietWrap = el("label", { class: "dn-switch" });
        var quietInput = el("input", { type: "checkbox", checked: config.quietHours.enabled === true, onChange: function () {
          config.quietHours.enabled = quietInput.checked;
          saveConfig(config);
        } });
        var quietTrack = el("span", { class: "dn-track" });
        quietTrack.appendChild(el("span", { class: "dn-thumb" }));
        quietWrap.appendChild(quietInput);
        quietWrap.appendChild(quietTrack);
        quietRow.appendChild(quietWrap);
        quiet.appendChild(quietRow);
        var times = el("div", { class: "dn-quiet" });
        var startInput = el("input", { type: "time", value: config.quietHours.start, onChange: function () { config.quietHours.start = startInput.value || "22:00"; saveConfig(config); } });
        var endInput = el("input", { type: "time", value: config.quietHours.end, onChange: function () { config.quietHours.end = endInput.value || "08:00"; saveConfig(config); } });
        times.appendChild(el("span", { text: "从" }));
        times.appendChild(startInput);
        times.appendChild(el("span", { text: "到" }));
        times.appendChild(endInput);
        quiet.appendChild(times);
        // 免打扰紧急例外：时段内仍放行的通知类型（宿主端 allowKinds 白名单）
        var allowWrap = el("div", { class: "dn-quiet-allow" });
        allowWrap.appendChild(el("span", { class: "dn-note", text: "免打扰期间仍提醒：" }));
        var ALLOW_CHOICES = [["ask", "审批"], ["question", "提问"], ["error", "出错"]];
        var allows = config.quietHours.allowKinds || (config.quietHours.allowKinds = []);
        for (var k = 0; k < ALLOW_CHOICES.length; k += 1) {
          (function (kindText, kindLabel) {
            var item = el("label", { class: "dn-allow-item" });
            var input = el("input", { type: "checkbox", checked: allows.indexOf(kindText) !== -1, onChange: function () {
              var idx = allows.indexOf(kindText);
              if (input.checked && idx === -1) allows.push(kindText);
              else if (!input.checked && idx !== -1) allows.splice(idx, 1);
              saveConfig(config);
            } });
            item.appendChild(input);
            item.appendChild(el("span", { text: kindLabel }));
            allowWrap.appendChild(item);
          })(ALLOW_CHOICES[k][0], ALLOW_CHOICES[k][1]);
        }
        quiet.appendChild(allowWrap);
        body.appendChild(quiet);

        var hist = el("div", { class: "dn-section" });
        var histTitle = el("div", { class: "dn-section-title", text: "通知记录" });
        histTitle.appendChild(el("button", {
          type: "button",
          text: "刷新",
          style: "float:right;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);border-radius:6px;padding:1px 8px;cursor:pointer;color:inherit;font-size:11px",
          onClick: function () {
            renderHistory(histHolder);
          },
        }));
        // 清空记录（二次确认：首次点击进入「确认清空？」态，3s 内再点才真正清空）
        var clearArmed = false;
        var clearTimer: any = null;
        histTitle.appendChild(el("button", {
          type: "button",
          text: "清空",
          style: "float:right;margin-right:6px;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);border-radius:6px;padding:1px 8px;cursor:pointer;color:inherit;font-size:11px",
          onClick: function () {
            var btn = this;
            if (!clearArmed) {
              clearArmed = true;
              btn.textContent = "确认清空？";
              if (clearTimer !== null) clearTimeout(clearTimer);
              clearTimer = setTimeout(function () {
                clearArmed = false;
                btn.textContent = "清空";
              }, 3000);
              return;
            }
            clearArmed = false;
            if (clearTimer !== null) clearTimeout(clearTimer);
            fetch(ROUTES.history, { method: "DELETE" })
              .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
              .then(function (data) {
                toast("已清空 " + data.removed + " 条通知记录");
                renderHistory(histHolder);
              })
              .catch(function (error) {
                toast("清空失败：" + error.message + accessHint(error));
              });
          },
        }));
        hist.appendChild(histTitle);
        var histHolder = el("div", {});
        hist.appendChild(histHolder);
        body.appendChild(hist);
        renderHistory(histHolder);

        body.appendChild(el("div", { class: "dn-note", text: "浏览器通知仅在页面隐藏时弹出（可开「页面可见时也弹」）；系统通知由宿主进程发出（Windows toast / notify-send）。点「发送测试通知」可验证链路。提示音需先点击页面任意位置一次（浏览器策略）。通知内容不含工具参数。" }));
      })
      .catch(function (error) {
        body.appendChild(el("div", { class: "dn-note", text: "加载配置失败：" + error.message + accessHint(error) }));
      });
  }

  // ------------------------------------------------------------ 通知显示

  var notified: any = [];

  // 多标签主从租约（仅「同 URL 的同浏览器多标签」有效；跨 host/IP、跨浏览器
  // 的 storage 域互不相交，去重自然失效——已按此口径写入 README）：
  // 收到通知帧的标签先 checkMaster：有效租约且属于自己 → 续租并展示；
  // 属于他人 → 静默；无主/已过期 → 抢占（写自己租约）并展示。
  // 租约 15s：主标签关闭/后台休眠后，下一个帧事件在 ≤15s 窗口内由其他标签接管。
  // 事件驱动、不依赖后台定时器（浏览器会对后台 setInterval 节流）。
  var TAB_ID = Math.random().toString(36).slice(2);
  var MASTER_KEY = "dsh-notifier:master";
  var MASTER_LEASE_MS = 15000;
  function claimMaster() {
    try {
      var raw = localStorage.getItem(MASTER_KEY);
      var lease = raw ? JSON.parse(raw) : null;
      var now = Date.now();
      if (lease && typeof lease.id === "string" && typeof lease.ts === "number" && now - lease.ts < MASTER_LEASE_MS) {
        if (lease.id === TAB_ID) {
          lease.ts = now; // 续租
          localStorage.setItem(MASTER_KEY, JSON.stringify(lease));
          return true;
        }
        return false; // 他标签持有有效租约
      }
      // 无主/租约已过期：抢占为当前主标签
      localStorage.setItem(MASTER_KEY, JSON.stringify({ id: TAB_ID, ts: now }));
      return true;
    } catch (error) {
      // localStorage 不可用（隐私模式等）：退化为每标签单独展示（同旧行为）
      return true;
    }
  }

  /** 页面是否处于安全上下文（HTTPS 或 localhost）——系统级 Notification 的前提。 */
  function isSecureContext() {
    return window.isSecureContext === true;
  }

  /** 系统级浏览器通知是否可用（安全上下文 + 已授权）。 */
  function systemNotificationUsable() {
    if (!("Notification" in window)) return false;
    if (!isSecureContext()) return false;
    return Notification.permission === "granted";
  }

  // ---- 降级提醒（非安全上下文：系统弹窗被浏览器禁止时使用）----

  var audioCtx: any = null;

  /** 解锁音频（必须在用户手势内调用）：后台播放提示音需要已解锁的 AudioContext。 */
  function unlockAudio() {
    try {
      if (audioCtx === null) {
        var AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      // 播放一段静音以完成解锁
      var buffer = audioCtx.createBuffer(1, 1, 22050);
      var source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);
    } catch (error) {
      // 音频不可用不阻塞通知
    }
  }

  /** 播放双音提示音（880Hz→660Hz，短促）。
   *  节流：1.5 秒内通知连发只响一次，防止频繁通知（如连点测试按钮）
   *  创建大量振荡器导致音频线程过载、页面卡顿。 */
  var lastChimeAt = 0;
  function playChime() {
    if (audioCtx === null || audioCtx.state !== "running") return;
    var now = Date.now();
    if (now - lastChimeAt < 1500) return;
    lastChimeAt = now;
    try {
      var t = audioCtx.currentTime;
      for (var i = 0; i < 2; i += 1) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = i === 0 ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, t + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t + i * 0.18);
        osc.stop(t + i * 0.18 + 0.17);
      }
    } catch (error) {
      // 播放失败忽略
    }
  }

  var savedTitle: any = null;

  /** 隐藏时改 document.title 提醒（"🔔 任务完成 …"），可见时还原。 */
  function flashTitle(title: any) {
    if (savedTitle === null) savedTitle = document.title;
    document.title = "🔔 " + String(title).slice(0, 40);
  }

  function restoreTitle() {
    if (savedTitle !== null) {
      document.title = savedTitle;
      savedTitle = null;
    }
  }

  /** 页面内横幅（非安全上下文降级通道；点击聚焦，8 秒自动消失，最多叠 3 条）。
   *  同类型（如 test 连发）先替换旧横幅，避免抖动堆叠。 */
  function showBanner(kind: any, title: any, message: any) {
    var existing = document.querySelector('.dn-banner[data-kind="' + kind + '"]');
    if (existing) existing.remove();
    var banners = document.querySelectorAll(".dn-banner");
    while (banners.length >= 3) banners[0].remove();
    var banner = el("div", {
      class: "dn-banner",
      dataset: { kind: kind },
      onClick: function () {
        window.focus();
        banner.remove();
      },
    });
    var head = el("div", { style: "display:flex;align-items:center;gap:6px" });
    head.appendChild(el("span", { text: "🔔" }));
    head.appendChild(el("span", { text: title, style: "font-weight:600" }));
    banner.appendChild(head);
    banner.appendChild(el("div", { text: message, style: "margin-top:4px;font-size:12px;line-height:1.5;white-space:pre-line" }));
    document.body.appendChild(banner);
    setTimeout(function () {
      banner.remove();
    }, 8000);
  }

  /**
   * 通知展示总入口：系统级 Notification 可用 → 弹系统通知；
   * 否则降级（页面内横幅 + 提示音 + 标题提醒）。
   */
  function showNotification(kind: any, title: any, message: any) {
    // 多标签去重：仅主标签执行展示（通知/横幅/提示音/标题），副标签静默
    if (!claimMaster()) return;
    if (systemNotificationUsable()) {
      try {
        // tag 加时间戳+随机后缀：每条通知独立显示，同类连发也互不替换
        // （固定 tag 时 Chrome 会用新通知替换旧通知，表现为"通知漏掉"）。
        // 堆积控制靠 notified 数组上限（超过 5 条关闭最早的）。
        var notification = new Notification(title, { body: message, tag: "dsh-notifier-" + kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), icon: NOTIFY_ICON, silent: !!(configCache && configCache.notifySound === false) });
        notification.onclick = function () {
          window.focus();
          notification.close();
        };
        notified.push(notification);
        if (notified.length > 5) notified.shift().close();
        return;
      } catch (error) {
        console.warn("[dsh-notifier] 浏览器通知失败，降级为页面内提醒：", error);
      }
    }
    // 降级通道
    if (document.visibilityState !== "hidden") {
      showBanner(kind, title, message);
    } else {
      flashTitle(title);
    }
    playChime();
  }

  function handleNotifyFrame(payload: any) {
    // 测试通知：无条件提醒（验证链路是它的目的，与可见性/权限之外的开关无关）。
    if (payload.kind === "test") {
      showNotification(payload.kind, payload.title, payload.message);
      return;
    }
    // 未读角标：收到非测试通知帧即 +1（打开面板清零）
    bumpUnread();
    // 页面聚焦时不提醒（用户在界面中）；除非配置了「页面可见时也弹」。
    if (document.visibilityState !== "hidden" && !(configCache && configCache.notifyWhenVisible === true)) return;
    showNotification(payload.kind, payload.title, payload.message);
  }

  // 当前 SSE 句柄（visibilitychange 回前台重建时引用；卸载时置 null）
  var eventsHandle: any = null;

  // 页面重新可见时：还原标题 + 强制重建 SSE（iOS 后台挂起后连接可能已失效，
  // 重建自动带 since 补拉，避免断线窗口漏通知）
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      restoreTitle();
      if (eventsHandle && eventsHandle.reconnect) eventsHandle.reconnect();
    }
  });

  /** SSE 半开连接看门狗：60s 无任何帧（notify 或心跳 ping）→ 主动重建。 */
  var WATCHDOG_MS = 60000;
  function startEvents() {
    var source: any = null;
    var lastActivity = 0;
    var lastSeq = 0;
    var watchdog: any = null;
    var lastReconnectAt = 0;

    function armWatchdog() {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (Date.now() - lastActivity > WATCHDOG_MS) {
          // 判定半开连接：心跳 ping 也应定期触达，超时说明链路静默断掉
          forceReconnect();
        } else {
          armWatchdog();
        }
      }, WATCHDOG_MS + 5000);
    }

    function forceReconnect() {
      // 重连节流：网络抖动时避免快速循环
      var now = Date.now();
      if (now - lastReconnectAt < 5000) return;
      lastReconnectAt = now;
      if (source !== null) {
        try {
          source.close();
        } catch (error) {
          // 忽略
        }
        source = null;
      }
      connect();
    }

    function connect() {
      try {
        // 重连带 since：服务端先回放缓冲中 seq 更大的帧（断线补拉，不丢事件）
        var url = ROUTES.events + (lastSeq > 0 ? "?since=" + lastSeq : "");
        source = new EventSource(url);
        lastActivity = Date.now();
        source.onmessage = function (event: any) {
          try {
            var data = JSON.parse(event.data);
            lastActivity = Date.now();
            if (data.type === "ping") return; // 心跳帧：仅更新活动时间戳
            if (data.type === "notify") {
              // seq 去重：已处理过的帧（重连回放竞态）跳过
              if (typeof data.seq === "number") {
                if (lastSeq > 0 && data.seq <= lastSeq) return;
                lastSeq = data.seq;
              }
              handleNotifyFrame(data);
            }
          } catch (error) {
            console.warn("[dsh-notifier] 帧解析失败：", error);
          }
        };
        source.onerror = function () {
          // 主动重建（带 since 补拉）：EventSource 自动重连不带 query，无法回放
          forceReconnect();
        };
        armWatchdog();
      } catch (error) {
        console.warn("[dsh-notifier] EventSource 不可用：", error);
      }
    }

    connect();
    var handle = {
      close: function () {
        if (watchdog !== null) clearTimeout(watchdog);
        if (source !== null) source.close();
      },
      reconnect: connect,
    };
    eventsHandle = handle;
    return handle;
  }

  // ------------------------------------------------------------ 入口与挂载

  function createEntry() {
    var entry = document.createElement("button");
    entry.type = "button";
    entry.dataset.dshNotifierEntry = "";
    entry.setAttribute("aria-label", "通知");
    entry.setAttribute("title", "通知：审批/完成/错误提醒设置");
    entry.innerHTML = '<span style="display:inline-flex;vertical-align:middle">' + ICON + "</span><span style='margin-left:2px'>通知</span><span class='dn-badge' data-dsh-notifier-badge hidden></span>";
    entry.style.cssText =
      "display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:none;background:transparent;color:inherit;font-size:12px;cursor:pointer;border-radius:6px";
    return entry;
  }

  // ---- 未读角标：收到通知帧 +1，打开面板清零（localStorage lastRead 记录），
  // 刷新页面按 history 差量恢复（跨刷新/跨标签维持）
  var unreadCount = 0;
  var UNREAD_KEY = "dsh-notifier:lastRead";
  function updateBadge() {
    var b: any = document.querySelector("[data-dsh-notifier-badge]");
    if (!b) return;
    if (unreadCount > 0) {
      b.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }
  function resetUnread() {
    unreadCount = 0;
    try {
      localStorage.setItem(UNREAD_KEY, String(Date.now()));
    } catch (e) {
      // localStorage 不可用仅不持久化
    }
    updateBadge();
  }
  function bumpUnread() {
    unreadCount += 1;
    updateBadge();
  }
  function initUnread() {
    try {
      var lastRead = Number(localStorage.getItem(UNREAD_KEY) || 0) || 0;
      fetch(ROUTES.history, { headers: { accept: "application/json" } })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          var records = (data && data.records) || [];
          var count = 0;
          for (var i = 0; i < records.length; i += 1) {
            // 被免打扰拦截（suppressed）的记录不计入未读角标（无需提醒查看）
            if (records[i].ts > lastRead && !records[i].suppressed) count += 1;
          }
          unreadCount = count;
          updateBadge();
        })
        .catch(function () {
          // 失败静默：角标保持 0
        });
    } catch (e) {
      // 静默
    }
  }

  /** 找到侧边栏 shell 根元素（logoRow 的父容器，与 dsh-ssh / dsh-skill-explorer 同款策略）。 */
  function sidebarRoot() {
    var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
    if (!column) return null;
    var logoOwner = column.querySelector('[class*="logoRow"]');
    return logoOwner ? logoOwner.parentElement : column.firstElementChild;
  }

  /** 家族锚点：把入口排到既有插件入口之后（参考 dsh-ssh 的 placeEntry）。 */
  function placeEntry(root: any, entry: any) {
    if (!root || !(root instanceof HTMLElement)) return false;
    if (entry.parentElement === root) return true;
    var nested = root.querySelector('button[class*="newSession"]');
    var button = nested;
    if (!button) {
      for (var i = 0; i < root.children.length; i += 1) {
        if (root.children[i].tagName === "BUTTON") {
          button = root.children[i];
          break;
        }
      }
    }
    if (!button) return false;
    var row = button.closest('[class*="logoRow"]');
    var base = row && row.parentElement === root ? row : button;
    var family = Array.prototype.filter.call(root.children, function (el) {
      return el instanceof HTMLElement && el.matches(
        "[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-skill-explorer-entry], [data-dsh-commands-files-entry], [data-dsh-memory-entry], [data-dsh-hooks-entry], [data-dsh-notifier-entry]"
      );
    });
    var anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
    root.insertBefore(entry, anchor);
    return true;
  }

export function apply(ctx: any) {
    var panel: any = null;
    var entry: any = null;
    var disposeEvents: any = null;

    function mount() {
      if (entry === null) {
        entry = createEntry();
        entry.addEventListener("click", function () {
          // 用户手势内：解锁音频（后台提示音的前提）+ 请求通知权限（Chrome 只接受手势内的授权请求）。
          unlockAudio();
          if ("Notification" in window && Notification.permission === "default") {
            requestPermission(function () {
              if (panel !== null && !panel.hidden) renderPanel(panel);
            });
          }
          if (panel === null) {
            panel = el("div", { id: PANEL_ID, hidden: true });
            var header = el("div", { class: "dn-header" });
            header.appendChild(el("span", { text: "通知" }));
            var closeBtn = el("button", { type: "button", text: "关闭", style: "border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);border-radius:6px;padding:2px 10px;cursor:pointer;color:inherit", onClick: function () { panel.hidden = true; } });
            header.appendChild(closeBtn);
            panel.appendChild(header);
            panel.appendChild(el("div", { class: "dn-body" }));
            document.body.appendChild(panel);
            restorePanelPos(panel);
            attachDrag(header, panel);
          }
          if (panel.hidden) {
            renderPanel(panel);
            panel.hidden = false;
            resetUnread(); // 打开面板 = 已读，清角标
          } else {
            panel.hidden = true;
          }
        });
      }
      var root = sidebarRoot();
      if (root && entry.parentElement !== root) {
        placeEntry(root, entry);
      } else if (!root && !document.body.contains(entry)) {
        document.body.appendChild(entry);
      }
      if (disposeEvents === null) {
        disposeEvents = startEvents();
      }
    }

    function boot() {
      try {
        injectStyle();
        mount();
        refreshConfig(); // 预取配置：可见性判断不依赖打开面板
        initUnread(); // 恢复未读角标（history 差量）
        // 首次任意点击解锁音频（浏览器自动播放策略要求手势；YouTube 同款做法），
        // 之后后台通知才有提示音。侧边栏「通知」入口点击也会解锁。
        document.addEventListener("click", function onFirstClick() {
          unlockAudio();
          document.removeEventListener("click", onFirstClick);
        }, { capture: true });
        // 注意：通知权限只在用户点击侧边栏「通知」入口时（手势内）请求，
        // Chrome 拒绝非手势的授权请求。
        var observer = new MutationObserver(function () {
          mount();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        ctx.effect(
          function () {
            // ctx.effect 的 fn 立即执行：清理必须写在返回的 disposer 里，
            // 否则挂载后立刻被移除（侧边栏入口消失的实测根因）。
            return function () {
              observer.disconnect();
              if (disposeEvents !== null) {
                disposeEvents.close();
                disposeEvents = null;
                eventsHandle = null;
              }
              if (entry !== null) entry.remove();
              if (panel !== null) panel.remove();
              for (var i = 0; i < notified.length; i += 1) {
                try {
                  notified[i].close();
                } catch (error) {
                  // 忽略
                }
              }
            };
          },
          "dsh-notifier"
        );
      } catch (error) {
        console.warn("[dsh-notifier] 挂载失败：", error);
      }
    }

    if (document.body) boot();
    else document.addEventListener("DOMContentLoaded", boot);
  }

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
export const inject: string[] = [];
