/**
 * dsh-mem0 — 客户端双语字典（zh / en）。
 *
 * 遵循仓库 i18n 规范：zh 为 key 源，en 必须覆盖全部 key。
 */

export const zh = {
  tabLabel: "记忆中心",
  title: "长期记忆中心",
  subtitle: "查看并管理跨会话的持久记忆、技术约定与用户偏好",
  mode: "运行模式",
  statusReady: "服务就绪 (stdio)",
  statusOffline: "服务未就绪",
  currentNs: "当前项目空间",
  searchPlaceholder: "检索记忆（语义搜索）…",
  searchBtn: "搜索",
  scopeAll: "全部空间",
  scopeProject: "当前项目",
  scopeGlobal: "全局空间",
  deleteConfirm: "确定要永久删除此条记忆吗？",
  deleteBtn: "删除",
  addBtn: "手工记录记忆",
  addPlaceholder: "输入要沉淀的技术决策、约定或偏好…",
  saveBtn: "保存",
  emptyList: "当前空间暂无记录的记忆条目",
  refreshBtn: "刷新",
  loading: "加载中…",
  opSuccess: "操作成功",
  opFailed: "操作失败",
};

export type Mem0LocaleKey = keyof typeof zh;

export const en: Record<Mem0LocaleKey, string> = {
  tabLabel: "Memory Center",
  title: "Persistent Memory Center",
  subtitle: "Browse and manage long-term associative memories, decisions, and preferences",
  mode: "Mode",
  statusReady: "Service Ready (stdio)",
  statusOffline: "Service Offline",
  currentNs: "Current Project Namespace",
  searchPlaceholder: "Search memories (semantic)...",
  searchBtn: "Search",
  scopeAll: "All Scopes",
  scopeProject: "Current Project",
  scopeGlobal: "Global Scope",
  deleteConfirm: "Are you sure you want to permanently delete this memory?",
  deleteBtn: "Delete",
  addBtn: "Add Memory Manually",
  addPlaceholder: "Enter architectural decision, convention, or preference...",
  saveBtn: "Save",
  emptyList: "No memories stored in this namespace",
  refreshBtn: "Refresh",
  loading: "Loading...",
  opSuccess: "Operation succeeded",
  opFailed: "Operation failed",
};
