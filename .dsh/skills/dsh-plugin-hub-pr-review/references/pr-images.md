# PR / issue 正文嵌图规范（#565 / #566 / #695 实证）

隔离实测截图归档在 `packages/<pkg>/docs/archive/`，随 PR 分支提交（版本控制）；各包
`files` 白名单不含 `docs/`，归档**不进发布物**。归档存储与正文引用是两个载体。

## 为什么不能写相对路径

GitHub 对 PR / issue 正文里的**相对路径图片按默认分支（main）解析**：文件只存在于 PR
分支时必 404 破图（#566 初稿即踩坑）。跨包相对前缀（`../../other-pkg/...`）还会额外错乱。

## 可用写法（按优先级）

### 首选（agent / CLI 场景）：`gh --attach`

gh **≥ 2.99.0** 起，`issue|pr` 的 `create` / `edit` / `comment` 支持可重复的 `--attach`：
上传后得到 `https://github.com/user-attachments/assets/...` 永久链接，与网页拖拽同源，
不受分支删除 / 文件移动影响（#695 实证：gh 2.97.0 报 `unknown flag: --attach`，2.100.0
上传成功并在页面正常渲染）。

```sh
gh --version                        # 需 ≥ 2.99.0，旧版走下方备选
# 评论 / 正文附图（可重复 --attach，单命令最多 50 个）
gh issue comment 695 --attach './phone.png#phone 档 375x667'
gh pr create --body-file /tmp/body.md --attach ./before.png --attach ./after.png
gh issue comment 695 --edit-last --body-file /tmp/body.md --attach ./after.png
```

- alt 文本：`--attach '<file>#<alt>'`，省略则用文件名；视频不支持 alt
- 正文里已用 Markdown 引用本地路径（如 `![x](./shot.png)`）时，gh 把该引用**重写**为
  上传 URL；未被引用的附件追加到正文末尾
- 仅 GitHub.com / GHE.com 可用，需 repo `WRITE` / `MAINTAIN` / `ADMIN` 权限；
  GHES 与 GitHub App token 不支持

### 备选：commit-pin raw URL

gh 版本不足，或正文需要指向**仓库内归档文件**（`packages/<pkg>/docs/archive/*.png`）时使用：

```sh
SHA=$(git rev-parse HEAD)          # 40 位 commit sha
# 拼 URL：https://raw.githubusercontent.com/<org>/<repo>/$SHA/<repo内路径>
curl -s -o /dev/null -w "%{http_code}\n" "<该 URL>"   # 逐张验 200 再发 PR
```

pin **commit**（而非分支名）的理由：squash merge 后分支被删，分支名 raw URL 失效；commit
对象仍可达，URL 长期有效。

### 人工场景：网页拖拽

网页编辑器里把 PNG 拖进正文，得到与 `--attach` 同款的 `user-attachments` 永久链接。

## 禁止的写法

- PR 正文嵌 `docs/../../...` 之类相对路径链（main 无此文件 + 跨包前缀错乱，双重破图）。
- 正文只列文件名不嵌图——#565 先例是**回避**问题，不是解决。

## 无门禁兜底（必须人工核）

`pnpm docs:check` 只校验各包 README 的相对链接（见 `scripts/gate/verify-docs.ts`：
`relLinks()` 跳过含 `#` 的锚点），**PR / issue 正文不在任何门禁覆盖内**。因此：

1. `--attach` / 网页拖拽：提交后读回正文确认附件 URL 已就位（`gh issue view <n> --json
   comments`、`gh pr view <n> --json body`），再打开页面确认渲染无破图；
2. commit-pin raw URL：发 PR 前逐张 `curl -w "%{http_code}"` 确认 200，同样打开页面复核。
