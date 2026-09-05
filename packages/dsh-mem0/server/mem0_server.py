#!/usr/bin/env python3
"""mem0 stdio MCP server for DeepSeek Harness (DSH).

Provides local, persistent long-term associative memory for DSH agents
via standard I/O (stdio) MCP transport.
"""

import json
import os
import sys
import threading
from typing import Any, Dict, List, Optional

# Disable telemetry before importing mem0
os.environ["MEM0_TELEMETRY"] = "False"
if "HF_ENDPOINT" not in os.environ:
    os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from mcp.server.fastmcp import FastMCP

# ---------- Configuration & Defaults ----------
DEFAULT_DATA_DIR = os.path.expanduser(os.environ.get("MEM0_DATA_DIR", "~/.dsh/mem0/data"))
os.makedirs(DEFAULT_DATA_DIR, exist_ok=True)

QDRANT_PATH = os.environ.get("QDRANT_PATH", os.path.join(DEFAULT_DATA_DIR, "qdrant"))
QDRANT_HOST = os.environ.get("QDRANT_HOST")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))

LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "openai")

EMBEDDER_MODEL = os.environ.get("EMBEDDER_MODEL", "BAAI/bge-small-zh-v1.5")
EMBEDDER_PROVIDER = os.environ.get("EMBEDDER_PROVIDER", "fastembed")

CUSTOM_INSTRUCTIONS = os.environ.get(
    "MEM0_CUSTOM_INSTRUCTIONS",
    (
        "记忆必须使用简体中文撰写（命令、路径、专有名词、库名保留原文）。\n"
        "只提取：用户的工作偏好与约定、明确的决策与方向变更、项目背景与目标、"
        "踩坑与解决方案、环境事实（路径/端口/工具链/网络拓扑）。\n"
        "忽略：代码实现细节、一次性任务执行指令、寒暄、过程性内容。\n"
        "每条记忆为一句完整的中文陈述句，直述事实，不加 User/用户说 之类前缀。"
    ),
)

# Vector store config (local embedded Qdrant or remote Qdrant)
vector_store_cfg: Dict[str, Any] = {
    "provider": "qdrant",
    "config": {
        "collection_name": "mem0",
        "embedding_model_dims": 512,
    },
}
if QDRANT_HOST:
    vector_store_cfg["config"]["host"] = QDRANT_HOST
    vector_store_cfg["config"]["port"] = QDRANT_PORT
else:
    vector_store_cfg["config"]["path"] = QDRANT_PATH

# Lazy-loaded Memory instance
_memory_instance = None
_lock = threading.Lock()


def get_memory():
    global _memory_instance
    if _memory_instance is None:
        with _lock:
            if _memory_instance is None:
                from mem0 import Memory

                config = {
                    "version": "v1.1",
                    "custom_instructions": CUSTOM_INSTRUCTIONS,
                    "llm": {
                        "provider": LLM_PROVIDER,
                        "config": {
                            "model": LLM_MODEL,
                            "api_key": LLM_API_KEY or "dummy-key-for-offline",
                            "openai_base_url": LLM_BASE_URL,
                            "temperature": 0.1,
                            "max_tokens": 2000,
                        },
                    },
                    "embedder": {
                        "provider": EMBEDDER_PROVIDER,
                        "config": {"model": EMBEDDER_MODEL},
                    },
                    "vector_store": vector_store_cfg,
                    "history_db_path": os.path.join(DEFAULT_DATA_DIR, "history.db"),
                }
                _memory_instance = Memory.from_config(config)
    return _memory_instance


# ---------- FastMCP Server Initialization ----------
mcp = FastMCP(
    "mem0",
    instructions=(
        "Persistent long-term memory server for DeepSeek Harness.\n"
        "Allows agents to recall user preferences, architectural decisions, and past bug workarounds.\n"
        "Context is automatically scoped to projects or global workspace."
    ),
)


@mcp.tool(
    name="memory_search",
    description="Search persistent memory store for relevant past decisions, preferences, or conventions.",
)
def memory_search(query: str, user_id: Optional[str] = None, limit: int = 5) -> str:
    """Search stored memories. If user_id is provided, search is scoped; otherwise cross-domain."""
    try:
        mem = get_memory()
        filters = {"user_id": user_id} if user_id else None
        results = mem.search(query, filters=filters, limit=limit)
        items = results.get("results", []) if isinstance(results, dict) else results
        formatted = []
        for r in items:
            text = r.get("memory", "")
            score = r.get("score")
            mid = r.get("id", "")
            score_str = f" [score: {score:.2f}]" if score is not None else ""
            formatted.append(f"- {text} (id: {mid}){score_str}")
        return "\n".join(formatted) if formatted else "No matching memories found."
    except Exception as e:
        return f"[memory_search failed: {str(e)}]"


@mcp.tool(
    name="memory_add",
    description="Record a durable fact, user preference, architectural decision, or convention.",
)
def memory_add(text: str, user_id: str = "global") -> str:
    """Add a new memory string. Context is bound to user_id (project namespace or global)."""
    try:
        mem = get_memory()
        res = mem.add(text, user_id=user_id)
        return json.dumps(res, ensure_ascii=False)
    except Exception as e:
        return f"[memory_add failed: {str(e)}]"


@mcp.tool(
    name="memory_list",
    description="List all stored memories in the specified namespace.",
)
def memory_list(user_id: str = "global") -> str:
    """List memories belonging to user_id."""
    try:
        mem = get_memory()
        items = mem.get_all(filters={"user_id": user_id})
        memories = items.get("results", []) if isinstance(items, dict) else items
        formatted = []
        for r in memories:
            mid = r.get("id", "")
            text = r.get("memory", "")
            formatted.append(f"- [{mid}] {text}")
        return "\n".join(formatted) if formatted else "No memories found in this namespace."
    except Exception as e:
        return f"[memory_list failed: {str(e)}]"


@mcp.tool(
    name="memory_delete",
    description="Delete a specific memory by its unique ID.",
)
def memory_delete(memory_id: str) -> str:
    """Delete a single memory by ID."""
    try:
        mem = get_memory()
        mem.delete(memory_id)
        return f"Memory {memory_id} deleted successfully."
    except Exception as e:
        return f"[memory_delete failed: {str(e)}]"


if __name__ == "__main__":
    mcp.run(transport="stdio")
