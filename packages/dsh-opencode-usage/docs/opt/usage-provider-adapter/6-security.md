# 6. 安全模型与信任域（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化用户注入 js 的安全边界、信任域、密钥处理与护栏（R1 扩展）。

---

## 6.1 信任域模型

| 域 | 权限面 | 信任级别 | 说明 |
| --- | --- | --- | --- |
| 插件本体（内置适配器/渲染器） | 宿主 Node + 浏览器 | 插件作者自控 | 遵循既有安全模型 |
| **用户宿主适配器（用户注入 .mjs）** | **完整 Node 权限**（网络/文件/环境变量/密钥） | 用户自担 | **等同用户自己写的插件进程** |
| 用户客户端渲染器（用户注入 .js） | 浏览器页面 DOM/JS | 用户自担 | 与其它 web 插件同信任（浏览器沙箱内） |
| DSH 官方 channel / profile | 配置层 | 框架层 | — |

**核心原则**：用户注入的代码运行在**用户自己进程/页面**里，其权限 = 用户自身权限。
插件不替用户代码兜底，但必须**明确文档化**该边界，避免误以为「插件注入了会替我
隔离」。

---

## 6.2 密钥处理（token 不进浏览器端）

默认边界（纳入文档「安全模型」节）：
- 插件自控的取数路径：API Key 只存宿主进程内存，路由只回传 `percent/raw` 展示字段。
- **用户自定义宿主适配器**：可接触密钥（它在宿主进程），但**不应**把密钥放进
  `ProviderUsage` / `ProviderSummary` 返回给浏览器。默认边界不强制约束用户适配器。

**护栏（宿主端，默认开，可关 `security.stripSecrets: false`）——R1 扩展**：

两层脱敏，覆盖 **ProviderUsage 与 ProviderSummary 的全部字符串字段**（不只 windows/meta/data）：

1. **键名扫描**：`windows/meta/data/summary` 任一对象键名含
   `secret/token/key/apikey` 且值为字符串（长度 ≥ 8）→ 剔除/替换为 `<redacted>`。
2. **值模式匹配**（R1 新增）：递归扫描所有字符串值，命中疑似密钥模式 →
   替换为 `<redacted>`：
   - `Bearer\s+\S+`（Authorization 头回显）
   - `\bsk-[A-Za-z0-9_-]{8,}\b`（OpenAI 风格 key）
   - `\bapi[_-]?key\s*[:=]\s*\S+`（键值对）
   - 长度 ≥ 32 的疑似 Base64/hex 串（按熵/原文判断留给实现定细则）

目的：降低用户误把密钥回传浏览器的风险，特别是胶囊文案每 60s 轮询常驻页面，
`text/hint` 若回显 `Bearer sk-xxx` 将持续暴露；不承诺绝对隔离（显式说明）。

---

## 6.3 加载与供应链

- 宿主加载用户 `import(pathToFileURL(p))`：仅加载**绝对/解析后存在的本地文件**，绝不
  从网络拉取执行（除非用户适配器自身这么做——那是用户自己的网络行为）。
- 鉴权/令牌均可留在用户宿主适配器内（如它直接签发、签名调用中转站），插件不透传。
- README 明示：「自定义宿主 js 拥有完整 Node 权限，仅加载你信任的文件。」

---

## 6.4 路由围栏与请求面

- 全部路由（`/stats`、`/history`、`/adapters.json`、`/user/<n>.js`、新增
  `POST /adapters/select`）loopback 围栏 + 方法校验（非回环 403 / 方法错 405），
  继承现有规范。`?provider=`/`?adapterId=` 参数建议长度限制（≤128 字符）。
- 用户 js 静态文件仅回环可访问；content-type 固定 `text/javascript`，
  `Cache-Control` 适中（开发期可禁用缓存以便调试）。
- 无新增远程出站面（取数仍由用户宿主适配器经插件注入的 fetch 完成，插件不代发）。