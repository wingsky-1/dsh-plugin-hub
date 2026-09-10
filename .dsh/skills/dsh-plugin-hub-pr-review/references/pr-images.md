# PR / issue 正文嵌图规范（#565 / #566 实证）

隔离实测截图归档在 `packages/<pkg>/docs/archive/`，随 PR 分支提交（版本控制）；各包
`files` 白名单不含 `docs/`，归档**不进发布物**。归档存储与正文引用是两个载体。

## 为什么不能写相对路径

GitHub 对 PR / issue 正文里的**相对路径图片按默认分支（main）解析**：文件只存在于 PR
分支时必 404 破图（#566 初稿即踩坑）。跨包相对前缀（`../../other-pkg/...`）还会额外错乱。

## 可用写法（二选一）

### 首选：网页拖拽上传（人工场景）

网页编辑器里把 PNG 拖进正文，GitHub 转存为 `https://github.com/user-attachments/assets/...`
永久链接——不受分支 / 删除影响，最稳。agent 自动化场景拖不了，走下一节。

### CLI 场景：commit-pin raw URL

```sh
SHA=$(git rev-parse HEAD)          # 40 位 commit sha
# 拼 URL：https://raw.githubusercontent.com/<org>/<repo>/$SHA/<repo内路径>
curl -s -o /dev/null -w "%{http_code}\n" "<该 URL>"   # 逐张验 200 再发 PR
```

pin **commit**（而非分支名）的理由：squash merge 后分支被删，分支名 raw URL 失效；commit
对象仍可达，URL 长期有效。

## 禁止的写法

- PR 正文嵌 `docs/../../...` 之类相对路径链（main 无此文件 + 跨包前缀错乱，双重破图）。
- 正文只列文件名不嵌图——#565 先例是**回避**问题，不是解决。

## 无门禁兜底（必须人工核）

`pnpm docs:check` 只校验各包 README 的相对链接（见 `scripts/gate/verify-docs.ts`：
`relLinks()` 跳过含 `#` 的锚点），**PR / issue 正文不在任何门禁覆盖内**。因此：

1. 发 PR 前逐张 `curl -w "%{http_code}"` 确认 200；
2. 提交后在 GitHub 页面上实际打开一次正文，确认渲染无破图。
