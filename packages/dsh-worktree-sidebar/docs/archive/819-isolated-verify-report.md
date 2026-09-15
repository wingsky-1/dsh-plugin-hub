# @wingsky-1/dsh-worktree-sidebar 隔离环境真机实测报告

> 归档说明（事后补记）：本文件是第十一轮隔离真机实测的**原始报告**，写于施工分支 HEAD 为 `dc6b5998` 时。
> 其中的临时目录、profile 与端口均已清理，绝对路径只作历史记录；结论与判据的定位见
> `docs/proposals/worktree-sidebar.md` §25 与 `docs/architecture/dsh-worktree-sidebar.md` §4.4 / §4.7。

被测: /mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar (分支 task/worktree-sidebar, HEAD dc6b5998)
dsh: 0.1.5-rc.1 (/home/tangyi/.local/node/bin/dsh)
隔离路径: 官方一键脚本 verify-isolated.mjs (dsh-verify-isolated 已装在 web profile, 未代装)

## 结论表

| # | 判据 | 结论 | 关键证据 |
|---|------|------|----------|
| 1 | 隔离实例装上并加载插件, 宿主端无报错 | 通过 | build exit 0; profile link 就位; curl health 200 {ok:true,revision:0,scopeTakeover:live}; dsh.log 仅一行 URL 无报错 |
| 2 | 侧边栏出现插件入口, 且 Files 排在官方之前 | 通过(表述需修正) | HEAD 不注册 4 条 UI 语义, 只注册 1 条同 key 遮蔽条目; 运行时证据见正文 |
| 3 | 预置绑定 -> 侧边栏展示 worktree 文件 | 通过 | 截图 04-files-tab-bound.png; 根=/tmp/wt-sidebar-wt-gwVukV 列出 .git/alpha.txt/beta.txt/gamma.txt |
| 4 | worktree 落仓库外同样展示 | 通过 | worktree 在 /tmp (主仓库 /tmp/wt-sidebar-repo-mySxkk 之外), 正常展示 |
| 5 | sessionCreatedAt 不一致 -> 绑定摘除 | 通过 | revision 1->2, bindings.json 变空表, 端点 worktreePath null, UI 回落 cwd |

## 关键事实
- 一键脚本能搭好隔离环境; 但 patchReload=live 不会重装本插件 (实测改 cordis.patch.yml 后 revision 仍 0), 因此绑定必须在 dsh web 启动前落盘。
- 会话身份跨重启稳定 (同 id 同 createdAt), 故 先起实例取会话 id/createdAt -> 写 bindings.json -> 重启 这条预置路径可行。
- 客户端机制: 并非注册 4 条 UI 语义, 而是以官方 files 的 id 为 key 再登记一条正文, priority = 官方 - 1 (takeover.ts:41-43 shadowPriorityOf; 注册 takeover.ts:137-147), 由官方 slot 注册表 同 cell 取优先级最低的存活项 渲染。

## 临时目录与端口清单
- 隔离 DSH_HOME: /tmp/dsh-verify-onZlhZ (profile verify_3422e4f8, 端口 40033) — 已删除
- 隔离浏览器: state /tmp/dsh-wt-sidebar-O0e1kd/browser.state; CDP 33303(启动即退出) / 41941; user-data-dir /tmp/dsh-verify-b6lina, /tmp/dsh-verify-Cwg6eQ — 已清理
- 夹具: /tmp/wt-sidebar-base-ebooIm, /tmp/wt-sidebar-repo-mySxkk, /tmp/wt-sidebar-wt-gwVukV — 已删除
- 证据目录(保留): /tmp/dsh-wt-sidebar-O0e1kd/00..05*.png

## 未覆盖
- Tools 域 (worktree_create/bind/remove 三个工具) 完全未覆盖: 隔离环境无 provider, 无法驱动 agent 调用工具, agent 建 worktree 时自动绑定 的主链路只走了读侧(预置记录)。
- 运行时 priority 数值: 页面无暴露 cordis ctx / slot registry 的全局, 只有源码依据。
- 子会话继承父会话绑定、worktree 目录被删除后的摘除、repoRoot 不匹配(belongsTo=different)摘除、双主题与窄屏几何。
