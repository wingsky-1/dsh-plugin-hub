/**
 * my-relay 客户端渲染器示例（ClientProviderRenderer 契约，version 1）。
 *
 * 运行环境：浏览器（与其它 web 插件同信任级）。插件主动拉取本文件并执行，
 * 模块体自注册到 window.__DSH_USAGE__ 桥接（契约版本化，不符只 warn 跳过）。
 *
 * 接线（cordis.patch.yml / 用户 patch 层）：
 *   plugins:
 *     ui-dsh-provider-usage:
 *       adapters:
 *         client:
 *           - file: ~/.dsh/my-relay-client.js
 */
window.__DSH_USAGE__?.registerRenderer({
  /** 契约版本，必须 === 1。 */
  version: 1,
  /** 认领的 provider 名（与宿主适配器一致）。 */
  providers: ["my-relay"],
  /** 可选：绑定适配器 id（与宿主适配器 id 一致）；缺省为该 provider 默认渲染器。 */
  adapterId: "my-relay",

  /**
   * 可选：自定义胶囊按钮文案。summary 为宿主 /stats 内嵌子树。
   * 返回 null 走通用展示。
   */
  pill(summary) {
    if (!summary || !summary.hasAdapter) return null;
    return { text: `中转 ${summary.text}`, level: summary.level, hint: summary.hint };
  },

  /**
   * 必选：渲染展开面板内容到 ctx.mount。
   * @param ctx - { provider, adapterId?, data?: ProviderUsage, history?, mount }
   * @returns 可选清理函数（provider 切换/插件卸载时调用：解绑 listener/observer 等）。
   */
  render(ctx) {
    const mount = ctx.mount;
    const box = document.createElement("div");
    box.style.cssText = "padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e8eaf0);border-radius:8px;font-size:12px;line-height:1.7;";

    const data = ctx.data;
    if (!data || data.ok === false) {
      box.textContent = data && data.error ? `取数失败：${data.error}` : "暂无数据";
      mount.appendChild(box);
      return;
    }

    // 优先读通用 windows 约定；自由格式读 ctx.data.data
    const win = Array.isArray(data.windows) ? data.windows[0] : undefined;
    const pct = win && typeof win.percent === "number" ? `${win.percent}%` : "--";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:4px;";
    title.textContent = `${data.label ?? "我的中转站"} · 额度 ${pct}`;
    box.appendChild(title);

    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--dsw-alias-label-tertiary,#9aa0ab);";
    detail.textContent = win?.raw ? `原文：${win.raw}` : "数据来自自定义适配器";
    box.appendChild(detail);

    // 历史采样（可选）：ctx.history = { samples: [[ts, ...cols]], columns: [{key,name}] }
    const samples = ctx.history?.samples;
    if (Array.isArray(samples) && samples.length >= 2) {
      const info = document.createElement("div");
      info.textContent = `历史采样 ${samples.length} 点`;
      box.appendChild(info);
    }

    mount.appendChild(box);

    // 返回清理函数（本例无 listener，空实现示意）
    return () => {};
  },
});
