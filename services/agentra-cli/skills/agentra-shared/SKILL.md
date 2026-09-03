---
name: agentra-shared
description: >-
  Agentra CLI 共享基础：config、auth login/status/logout、URL 与 workspace 的区别、
  token 的权限边界、--json 输出约定、连不上或看不到数据时的排障。用户首次配置、登录、
  连不上、查询返回空、或执行任何 Agentra 写操作前必须先读本 skill。
metadata:
  cliVersion: ">=0.1.0"
---

# agentra-shared

本 skill 是 Agentra CLI 的**唯一详细鉴权与配置文档**。领域 skill（issues、testcases）
开头会要求先读本文件；不要在各领域 skill 里重复展开鉴权流程。

## 凭证与配置真源

| 项 | 来源 | 说明 |
|---|---|---|
| 地址 | `~/.config/agentra/config.json` → `url` | **front 的地址**，不是 transactor 的。CLI 会从它的 `/config.json` 发现其余端点 |
| 工作区 | 同上 → `workspace` | **slug**，如 `agentra-main`；不是 http URL，也不是 uuid |
| 凭证 | 同上 → `token` | 在 Agentra 的「设置 → API 令牌」里签发 |

配置文件权限 `600`。三个环境变量 `AGENTRA_URL` / `AGENTRA_WORKSPACE` / `AGENTRA_TOKEN`
**覆盖**配置文件，命令行 `--url` / `--workspace` / `--token` 再覆盖环境变量。

## 快速开始

```bash
npm i -g @agentra-cli/cli

# 令牌走 stdin，不要写进命令行参数 —— 那会进 shell history，也能被 ps 看到
pbpaste | agentra auth login --url https://agentra.example.com --workspace agentra-main

agentra auth status
```

`auth login` 会**先验证再落盘**：连不上或令牌无效时不会写配置文件，所以下一条命令
报的错就是登录本身的错，不会转嫁到别的命令头上。

## 🔴 令牌的权限边界

**令牌没有 scope。** 它等同于签发者在该工作区的完整权限——技术方案里设想的
`test:result:write` 这类分级**在平台代码里并不存在**。

- 给 agent 用的令牌，建议用**专门账号**签发，不要用你自己的。
- 令牌可以在「设置 → API 令牌」里随时撤销。
- `agentra auth status` **不会**打印令牌本身，可以安全地贴进问题报告。

## 输出约定

默认输出是给人看的表格，**会截断**。程序化消费一律加 `--json`：

```bash
agentra issue list --project PLAUD --json | jq '.[].identifier'
```

失败时错误进 **stderr**、退出码非 0；成功但无结果时 stdout 是 `[]`（`--json`）或
`(none)`。两者要区分开——空结果不是失败。

## 没有删除命令，这是设计

CLI 与 MCP 都只提供 **create / update**。需要删除时请人在界面里操作。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Not configured — missing ...` | 三个值有缺 | `agentra auth login`，或设环境变量 |
| 连接超时 / `ECONNREFUSED` | `url` 填成了 transactor 或带了路径 | 填 front 的根地址 |
| `Workspace not found` | `workspace` 填成了 URL 或 uuid | 填 slug，如 `agentra-main` |
| `test-project list` 返回空 | **你不是任何测试项目的成员** | Huly 按 `members` 严格过滤空间。空列表 ≠ 不存在，先确认成员资格 |
| `case list` 有数据但界面看不到 | 界面按 `attachedTo` 精确匹配、不展开后代 | 在界面里点到用例真正挂载的那一层 suite |
| `Suite 'X' not found` | suite 名只在项目内唯一 | 带上 `--project`，否则可能匹配到别的项目 |

## 命令组

- `agentra auth` — 见上
- `agentra project` / `agentra issue` — 见 [`../agentra-issues/SKILL.md`](../agentra-issues/SKILL.md)
- `agentra test-project` / `agentra case` — 见 [`../agentra-testcases/SKILL.md`](../agentra-testcases/SKILL.md)
