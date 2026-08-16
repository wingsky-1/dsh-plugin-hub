# @wingsky-1/dsh-skill-explorer

DSH Web GUI 的**技能中心**：侧边栏「技能中心」入口，两个 tab：

| Tab | 功能 |
|---|---|
| **技能** | 展示已加载的全部 skill，按来源分级（系统内置 / 项目 / 用户 / 自定义 / 运行时），支持启用/禁用（改写 `disable-model-invocation`）、删除（移入 `.trash`） |
| **创建** | 表单创建新 skill（用户级 `~/.dsh/skills` 或项目级 `.dsh/skills`），生成标准 SKILL.md |

零运行时依赖、无 React：host 端与浏览器端均为 TypeScript，客户端经 esbuild 打包为 IIFE 产物。

## 安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-skill-explorer
```

安装后**重启一次** `dsh web`，侧边栏出现「技能中心」入口。

## 数据来源与分级

| 级别（展示顺序） | 来源 |
|---|---|
| 系统内置 | 注册表 `bundled`（DSH 随附与插件提供的技能） |
| 项目技能（.dsh/skills、.agents/skills） | 文件系统（仅当前项目） |
| 自定义目录 | 文件系统（`customSkillDirs` 配置的额外根） |
| 用户技能（~/.dsh/skills、~/.agents/skills） | 文件系统（本机所有项目） |
| 运行时注册 | 注册表 `runtime`（插件代码内嵌注册） |

## 路由（全部 loopback 围栏）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-skill-explorer/health` | GET | 健康检查 |
| `/api/dsh-skill-explorer/list?cwd=` | GET | 分级技能列表 |
| `/api/dsh-skill-explorer/set-enabled` | POST | 启用/禁用（改写 frontmatter） |
| `/api/dsh-skill-explorer/create` | POST | 创建技能（user/project 根） |
| `/api/dsh-skill-explorer/delete` | POST | 删除（移入 .trash） |

## 配置（插件 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 插件总开关 |
| `customSkillDirs` | [] | 额外自定义技能根目录 |
| `dshHome` | `~/.dsh` | 用户技能根覆盖（默认 `~/.dsh/skills`） |
| `agentsHome` | `~/.agents` | agents 技能根覆盖（默认 `~/.agents/skills`） |

## 安全与边界

- 删除只移入 `.trash`（可手动恢复），不物理删除
- 所有 `/api/dsh-skill-explorer/*` 路由仅限 loopback 访问（非回环 403 / 方法错 405）
- 技能内容展示经转义（`textContent`），无 XSS 面
- 写面（create/set-enabled/delete）有 loopback 围栏与路径白名单（kebab-case 技能名防路径穿越）

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-skill-explorer/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-skill-explorer build
node test/smoke.mjs
```

## License

MIT
