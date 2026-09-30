/**
 * dsh-auto-continue-429 — 客户端
 *
 * 对话框底部的「开/关」滑动开关：直接控制 429 自动 continue 的快捷开关
 * （quickOn），与设置页的主开关（enabled）不联动；
 * 在设置页停用插件（enabled=false）后，对话框底部不再显示该开关。
 *
 * 使用纯 DOM API（不依赖 React），通过 HTTP 轮询与宿主端通信。
 */

window.__ModuleLoader__.load({
  id: "dsh-auto-continue-429",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── 状态 ──────────────────────────────────────────────
    var state = {
      enabled: true,     // 设置页主开关（停用后对话框开关隐藏）
      quickOn: true,     // 对话框底部快捷开关
      buttonHidden: false,
      retryCount: 0,
      maxRetries: 20,
      errorCodes: ["invalid_request_error"],
    };
    var barEl = null;          // 对话框底部开关条
    var knobEl = null;         // 滑动开关的圆钮
    var switchTrackEl = null;  // 滑动开关的轨道
    var switchTextEl = null;   // 开/关 文字
    var pollTimer = null;
    var settingsObserver = null;
    var reattachTimer = null;
    var MIN_RETRIES = 1;
    var MAX_RETRIES = 100;

    // ── 工具函数 ──────────────────────────────────────────
    function el(tag, style, children) {
      var e = document.createElement(tag);
      if (style) Object.assign(e.style, style);
      if (children) {
        if (!Array.isArray(children)) children = [children];
        children.forEach(function (c) {
          if (c == null) return;
          if (typeof c === "string") e.appendChild(document.createTextNode(c));
          else e.appendChild(c);
        });
      }
      return e;
    }

    // ── 定位对话框输入区（在 textarea 的卡片容器底部插入开关条）──
    function findComposerCard() {
      var tas = document.querySelectorAll("textarea");
      var ta = null;
      for (var i = 0; i < tas.length; i++) {
        if (tas[i].closest(".VOzbGW_panel")) continue;
        var rect = tas[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) ta = tas[i];
      }
      if (!ta) return null;
      // 向上找输入卡片/编辑器容器（CSS module 类名以 card/composer/editor 结尾）
      var n = ta;
      for (var d = 0; d < 6 && n; d++) {
        var cls = (n.className || "").toString();
        if (/card|composer|editor/i.test(cls)) return n;
        n = n.parentElement;
      }
      return ta.parentElement;
    }

    // ── 创建对话框底部开关条 ──────────────────────────────
    function createBar() {
      if (barEl) return;

      barEl = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "0 8px",
        margin: "0 2px",
        borderRadius: "6px",
        background: "transparent",
        border: "none",
        userSelect: "none",
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "opacity 0.2s ease",
        flexShrink: "0",
      });
      barEl.title = "Toggle automatic continue for configured errors";

      // Auto-Continue status badge
      var logo = el("span", {
        fontSize: "11px",
        fontWeight: "700",
        color: "#fff",
        background: state.quickOn ? "#4CAF50" : "#9E9E9E",
        padding: "1px 7px",
        borderRadius: "999px",
        lineHeight: "16px",
      });
      logo.textContent = "\u21bb AUTO";
      barEl.appendChild(logo);

      // 滑动开关
      var switchWrap = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
      });
      switchTrackEl = el("div", {
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        background: state.quickOn ? "#4CAF50" : "#9E9E9E",
        position: "relative",
        flexShrink: "0",
        transition: "background 0.2s ease",
      });
      knobEl = el("div", {
        position: "absolute",
        top: "2px",
        left: state.quickOn ? "18px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
        transition: "left 0.2s ease",
      });
      switchTrackEl.appendChild(knobEl);
      switchTextEl = el("span", {
        fontSize: "12px",
        fontWeight: "600",
        color: state.quickOn ? "#4CAF50" : "#9E9E9E",
        transition: "color 0.2s ease",
      });
      switchTextEl.textContent = state.quickOn ? "On" : "Off";
      switchWrap.appendChild(switchTrackEl);
      switchWrap.appendChild(switchTextEl);
      barEl.appendChild(switchWrap);

      barEl.addEventListener("click", function () {
        toggleQuick();
      });

      attachBar();
    }

    function attachBar() {
      // 优先挂载到工具栏：模型选择按钮左边、访问模式右边
      var allBtns = document.querySelectorAll("button");
      var modelBtn = null;
      for (var i = 0; i < allBtns.length; i++) {
        // 跳过设置面板内的按钮
        if (allBtns[i].closest(".VOzbGW_panel")) continue;
        var al = (allBtns[i].getAttribute("aria-label") || "") +
          allBtns[i].textContent;
        if (al.indexOf("\u6a21\u578b") >= 0 || al.toLowerCase().indexOf("model") >= 0) {
          modelBtn = allBtns[i];
          break;
        }
      }
      if (modelBtn) {
        // modelBtn → DIV._7KE1Ra_root → DIV.(wrapper) → DIV.uV2eYG_modes(toolbar)
        var wrapper = modelBtn.parentElement;
        if (wrapper) wrapper = wrapper.parentElement;
        var toolbar = wrapper ? wrapper.parentElement : null;
        if (toolbar && wrapper) {
          if (barEl.parentElement === toolbar) return true;
          if (barEl.parentElement) barEl.remove();
          toolbar.insertBefore(barEl, wrapper);
          return true;
        }
      }
      // 降级：挂到输入区卡片底部
      var card = findComposerCard();
      if (!card) return false;
      if (barEl.parentElement === card) return true;
      if (barEl.parentElement) barEl.remove();
      card.appendChild(barEl);
      return true;
    }

    // ── 更新开关条 UI ─────────────────────────────────────
    function updateBarUI() {
      if (!barEl) return;
      var visible = state.enabled === true; // 设置页停用后隐藏
      barEl.style.display = visible ? "flex" : "none";
      if (!visible) return;
      if (knobEl) knobEl.style.left = state.quickOn ? "18px" : "2px";
      if (switchTrackEl) switchTrackEl.style.background = state.quickOn ? "#4CAF50" : "#9E9E9E";
      if (switchTextEl) {
        switchTextEl.textContent = state.quickOn ? "On" : "Off";
        switchTextEl.style.color = state.quickOn ? "#4CAF50" : "#9E9E9E";
      }
      if (barEl.firstChild) {
        barEl.firstChild.style.background = state.quickOn ? "#4CAF50" : "#9E9E9E";
      }
    }

    // ── 切换快捷开关（对话框底部，与设置页不联动）────────────
    function toggleQuick() {
      fetch("/api/auto-continue-429/toggle-quick", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && typeof data.quickOn === "boolean") {
            state.quickOn = data.quickOn;
            updateBarUI();
          }
        })
        .catch(function () { /* 网络错误，忽略 */ });
    }

    // ── 轮询状态 ──────────────────────────────────────────
    function pollStatus() {
      fetch("/api/auto-continue-429/state")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          state.enabled = data.enabled;
          state.quickOn = data.quickOn;
          state.buttonHidden = data.buttonHidden;
          state.retryCount = data.retryCount;
          state.maxRetries = data.maxRetries;
          if (Array.isArray(data.errorCodes)) state.errorCodes = data.errorCodes;
          updateBarUI();
          // 若输入区重渲染导致开关条丢失，重新挂载
          if (state.enabled && barEl && barEl.parentElement === null) {
            attachBar();
          }
        })
        .catch(function () { /* 网络错误，忽略 */ });
    }

    // ── 设置页注入 ────────────────────────────────────────
    // 在 DSH 设置面板左侧导航添加独立 tab，点击后右侧显示 429 配置
    function setupSettingsTab() {
      var tabInjected = false;

      function tryInjectTab() {
        var panel = document.querySelector(".VOzbGW_panel");
        if (!panel) return;

        var navList = panel.querySelector(".VOzbGW_navList");
        var content = panel.querySelector(".VOzbGW_content");
        if (!navList || !content) return;

        // 已注入且 DOM 中仍存在时跳过（React 重建后需重新注入）
        if (tabInjected && navList.querySelector("[data-ac429-tab]")) return;
        tabInjected = true;

        // ── 创建导航 tab ──
        var navCell = document.createElement("div");
        navCell.className = "VOzbGW_navCell";
        navCell.setAttribute("data-ac429-tab", "1");

        var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "16");
        icon.setAttribute("height", "16");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("class", "VOzbGW_navIcon");
        icon.setAttribute("fill", "none");
        var t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", "3");
        t.setAttribute("y", "12");
        t.setAttribute("font-size", "8");
        t.setAttribute("font-weight", "bold");
        t.setAttribute("fill", "currentColor");
        t.textContent = "429";
        icon.appendChild(t);
        navCell.appendChild(icon);

        var label = document.createElement("span");
        label.className = "VOzbGW_navLabel";
        label.textContent = "Auto-Continue";
        navCell.appendChild(label);

        // ── 创建配置卡片 ──
        var card = createSettingsCard();
        card.id = "ac429-settings-card";
        card.style.display = "none";

        var header = content.querySelector(".VOzbGW_header");
        content.insertBefore(card, header ? header.nextSibling : null);

        // ── 统一处理 tab 切换 ──
        navList.addEventListener("click", function (e) {
          var target = e.target.closest(".VOzbGW_navCell");
          if (!target) return;

          var allCells = navList.querySelectorAll(".VOzbGW_navCell");
          for (var i = 0; i < allCells.length; i++) {
            allCells[i].classList.remove("VOzbGW_active");
          }
          target.classList.add("VOzbGW_active");

          var isOurTab = target.getAttribute("data-ac429-tab") === "1";
          var options = content.querySelector(".VOzbGW_options");

          if (isOurTab) {
            if (options) options.style.display = "none";
            card.style.display = "block";
          } else {
            card.style.display = "none";
            if (options) options.style.display = "";
          }
        }, true);

        navList.appendChild(navCell);
        tabInjected = true;
      }

      settingsObserver = new MutationObserver(function () {
        tryInjectTab();
        if (state.enabled && barEl && !document.body.contains(barEl)) {
          attachBar();
        } else if (state.enabled && barEl && barEl.parentElement) {
          if (reattachTimer) clearTimeout(reattachTimer);
          reattachTimer = setTimeout(function () { attachBar(); }, 300);
        }
      });
      settingsObserver.observe(document.body, { childList: true, subtree: true });

      window.addEventListener("hashchange", function () {
        setTimeout(tryInjectTab, 300);
      });

      setTimeout(tryInjectTab, 1000);
    }

    function createSettingsCard() {
      var card = el("div", {
        border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        borderRadius: "12px",
        padding: "16px",
        margin: "12px 0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      });

      var header = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "12px",
      });
      var dot = el("div", {
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        background: state.enabled ? "#4CAF50" : "#9E9E9E",
        flexShrink: "0",
      });
      var title = el("span", {
        fontSize: "15px",
        fontWeight: "600",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
      });
      title.textContent = "Auto-Continue";
      header.appendChild(dot);
      header.appendChild(title);
      card.appendChild(header);

      var desc = el("p", {
        fontSize: "13px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
        margin: "0 0 12px",
        lineHeight: "1.5",
      });
      desc.textContent = "Automatically sends continue after rate-limit, quota, or configured errors. Stops at the consecutive-failure limit.";
      card.appendChild(desc);

      var masterRow = el("div", {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "var(--dsw-alias-bg-layer-1, #f7f7f7)",
        borderRadius: "8px",
        gap: "12px",
      });
      var masterLabel = el("div", {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      });
      var masterTitle = el("div", {
        fontSize: "13px",
        fontWeight: "500",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
      });
      masterTitle.textContent = "Enable plugin";
      var masterHint = el("div", {
        fontSize: "11px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
      });
      masterHint.textContent = "Disabling the plugin hides the quick switch and stops automatic continue.";
      masterLabel.appendChild(masterTitle);
      masterLabel.appendChild(masterHint);

      var masterSwitch = makeSwitch(state.enabled, function (on) {
        fetch("/api/auto-continue-429/toggle", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && typeof data.enabled === "boolean") {
              state.enabled = data.enabled;
              setSwitchOn(masterSwitch, state.enabled);
              dot.style.background = state.enabled ? "#4CAF50" : "#9E9E9E";
              updateBarUI();
            }
          })
          .catch(function () {
            setSwitchOn(masterSwitch, !on);
          });
      });
      masterRow.appendChild(masterLabel);
      masterRow.appendChild(masterSwitch);
      card.appendChild(masterRow);

      var retriesRow = el("div", {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "var(--dsw-alias-bg-layer-1, #f7f7f7)",
        borderRadius: "8px",
        gap: "12px",
      });
      var retriesLabel = el("div", {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      });
      var retriesTitle = el("div", {
        fontSize: "13px",
        fontWeight: "500",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
      });
      retriesTitle.textContent = "Consecutive failure limit";
      var retriesHint = el("div", {
        fontSize: "11px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
      });
      retriesHint.textContent = "Stop after this many failures (" + MIN_RETRIES + "-" + MAX_RETRIES + "); any successful turn resets the count.";
      retriesLabel.appendChild(retriesTitle);
      retriesLabel.appendChild(retriesHint);

      var retriesInputWrap = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexShrink: "0",
      });
      var retriesInput = el("input", {
        width: "72px",
        padding: "5px 8px",
        fontSize: "13px",
        border: "1px solid var(--dsw-alias-border-l2, #ccc)",
        borderRadius: "6px",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
        textAlign: "center",
      });
      retriesInput.type = "number";
      retriesInput.min = String(MIN_RETRIES);
      retriesInput.max = String(MAX_RETRIES);
      retriesInput.step = "1";
      retriesInput.value = String(state.maxRetries);
      var retriesSaveBtn = el("button", {
        appearance: "none",
        border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)",
        borderRadius: "6px",
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        color: "var(--dsw-alias-label-secondary, #555)",
      });
      retriesSaveBtn.textContent = "Save";
      var retriesMsg = el("div", {
        fontSize: "11px",
        minHeight: "14px",
        marginTop: "4px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
      });
      retriesInputWrap.appendChild(retriesInput);
      retriesInputWrap.appendChild(retriesSaveBtn);
      retriesRow.appendChild(retriesLabel);
      retriesRow.appendChild(retriesInputWrap);
      card.appendChild(retriesRow);
      card.appendChild(retriesMsg);

      function clampRetries(n) {
        n = parseInt(n, 10);
        if (!isFinite(n)) n = 20;
        if (n < MIN_RETRIES) n = MIN_RETRIES;
        if (n > MAX_RETRIES) n = MAX_RETRIES;
        return n;
      }
      retriesInput.addEventListener("change", function () {
        retriesInput.value = String(clampRetries(retriesInput.value));
      });
      retriesInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          retriesInput.value = String(clampRetries(retriesInput.value));
          saveMaxRetries();
        }
      });
      function saveMaxRetries() {
        var val = clampRetries(retriesInput.value);
        retriesInput.value = String(val);
        retriesMsg.textContent = "Saving…";
        retriesMsg.style.color = "var(--dsw-alias-label-tertiary, #757575)";
        fetch("/api/auto-continue-429/set-max-retries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxRetries: val }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok) {
            state.maxRetries = data.maxRetries;
            retriesMsg.textContent = "\u2713 Saved";
            retriesMsg.style.color = "#4CAF50";
          } else {
            retriesMsg.textContent = "\u2717 " + (data.error || "Save failed");
            retriesMsg.style.color = "#f44336";
          }
          if (data && data.maxRetries) {
            state.maxRetries = data.maxRetries;
            retriesInput.value = String(data.maxRetries);
          }
          updateBarUI();
          setTimeout(function () { retriesMsg.textContent = ""; }, 2500);
        }).catch(function () {
          retriesMsg.textContent = "\u2717 Network error";
          retriesMsg.style.color = "#f44336";
          setTimeout(function () { retriesMsg.textContent = ""; }, 2500);
        });
      }
      retriesSaveBtn.addEventListener("click", saveMaxRetries);

      var codesRow = el("div", {
        display: "flex",
        flexDirection: "column",
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "var(--dsw-alias-bg-layer-1, #f7f7f7)",
        borderRadius: "8px",
        gap: "8px",
      });
      var codesTitle = el("div", {
        fontSize: "13px",
        fontWeight: "500",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
      });
      codesTitle.textContent = "Additional auto-continue error codes";
      var codesHint = el("div", {
        fontSize: "11px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
        lineHeight: "1.4",
      });
      codesHint.textContent = "Comma or new-line separated. RATE_LIMIT and QUOTA are always enabled.";
      var codesInput = el("textarea", {
        width: "100%",
        minHeight: "58px",
        boxSizing: "border-box",
        resize: "vertical",
        padding: "7px 8px",
        fontSize: "12px",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        border: "1px solid var(--dsw-alias-border-l2, #ccc)",
        borderRadius: "6px",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        color: "var(--dsw-alias-label-primary, #1a1a1a)",
      });
      codesInput.value = (state.errorCodes || []).join("\n");
      var codesActions = el("div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
      });
      var codesSaveBtn = el("button", {
        appearance: "none",
        border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)",
        borderRadius: "6px",
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        color: "var(--dsw-alias-label-secondary, #555)",
      });
      codesSaveBtn.textContent = "Save error codes";
      var codesMsg = el("span", {
        fontSize: "11px",
        color: "var(--dsw-alias-label-tertiary, #757575)",
      });
      codesActions.appendChild(codesSaveBtn);
      codesActions.appendChild(codesMsg);
      codesRow.appendChild(codesTitle);
      codesRow.appendChild(codesHint);
      codesRow.appendChild(codesInput);
      codesRow.appendChild(codesActions);
      card.appendChild(codesRow);

      codesSaveBtn.addEventListener("click", function () {
        var codes = codesInput.value.split(/[\n,]+/).map(function (v) {
          return v.trim();
        }).filter(Boolean);
        codesMsg.textContent = "Saving…";
        fetch("/api/auto-continue-429/set-error-codes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ errorCodes: codes }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok) {
            state.errorCodes = data.errorCodes;
            codesInput.value = state.errorCodes.join("\n");
            codesMsg.textContent = "✓ Saved";
            codesMsg.style.color = "#4CAF50";
          } else {
            codesMsg.textContent = "✗ " + ((data && data.error) || "Save failed");
            codesMsg.style.color = "#f44336";
          }
          setTimeout(function () { codesMsg.textContent = ""; }, 2500);
        }).catch(function () {
          codesMsg.textContent = "✗ Network error";
          codesMsg.style.color = "#f44336";
          setTimeout(function () { codesMsg.textContent = ""; }, 2500);
        });
      });

      return card;
    }

    // ── 滑动开关组件（通用）────────────────────────────────
    // 状态记录在 data-on 上，避免闭包捕获旧值导致连续点击计算错误
    function makeSwitch(on, onChange) {
      var track = el("div", {
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        background: on ? "#4CAF50" : "#9E9E9E",
        position: "relative",
        flexShrink: "0",
        cursor: "pointer",
        transition: "background 0.2s ease",
      });
      track.setAttribute("data-on", on ? "1" : "0");
      var knob = el("div", {
        position: "absolute",
        top: "2px",
        left: on ? "18px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
        transition: "left 0.2s ease",
      });
      track.appendChild(knob);
      track.addEventListener("click", function (e) {
        e.stopPropagation();
        var next = track.getAttribute("data-on") !== "1";
        setSwitchOn(track, next);
        if (onChange) onChange(next);
      });
      return track;
    }
    function setSwitchOn(track, on) {
      track.setAttribute("data-on", on ? "1" : "0");
      track.style.background = on ? "#4CAF50" : "#9E9E9E";
      var knob = track.firstChild;
      if (knob) knob.style.left = on ? "18px" : "2px";
    }

    // ── 初始化 ────────────────────────────────────────────
    function init() {
      createBar();
      pollStatus();
      pollTimer = setInterval(pollStatus, 2000);
      setupSettingsTab();
    }

    // ── 导出 ──────────────────────────────────────────────
    var inject = [];

    function apply(ctx) {
      var start = function () {
        init();
        if (ctx && typeof ctx.effect === "function") {
          ctx.effect(function () {
            return function () {
              if (pollTimer) clearInterval(pollTimer);
              if (settingsObserver) settingsObserver.disconnect();
              if (barEl) barEl.remove();
            };
          });
        }
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
