# Agentra MCP Server

把 Agentra 的 issue 与测试用例暴露成 MCP 工具，让 agent 能读写。

## 为什么是这个形状

平台侧的三样东西本来就有，这个服务只是把它们包成 MCP：

- transactor 自带 REST/websocket 接口（`pods/server/src/rpc.ts`）
- 账户设置里可以签发**可撤销**的 API 令牌（commit `5a3d673e8`）
- `@hcengineering/api-client` 给一个裸 token 就能拿到已认证的平台客户端

用 websocket 的 `connect()` 而不是 `connectRest()`：工具需要
`createDoc` / `addCollection` / `updateDoc`，REST 客户端只提供裸 `tx`。

## 🔴 令牌没有 scope

Agentra 的 API 令牌是**该账号在该工作区的完整权限 JWT** —— 技术方案里设想的
`test:result:write` / `test:case:read` 分级在代码里并不存在。所以这个服务
持有的令牌能做令牌主人能做的一切。

工具集里**故意不提供任何删除操作**：模型幻觉或提示注入的最坏结果应该是
多出脏数据，而不是丢数据。要删就去界面里删。

## 配置

| 变量 | 说明 |
|---|---|
| `AGENTRA_URL` | **前端**地址（不是 transactor）。`connect()` 要从它拉 `/config.json` |
| `AGENTRA_TOKEN` | 账户设置里签发的 API 令牌 |
| `AGENTRA_WORKSPACE` | 工作区 slug（如 `agentra-main`），不是 http 地址 |
| `MCP_TRANSPORT` | `http`（默认）或 `stdio` |
| `MCP_PORT` | http 模式端口，默认 3100 |

## 两种用法

**远程（部署形态）**：`MCP_TRANSPORT=http`，`POST /mcp`，`GET /health`。

**本地 stdio**：`MCP_TRANSPORT=stdio`，供 Claude Code / Desktop 直接拉起。
⚠️ stdio 模式下 stdout **就是**协议通道，任何 `console.log` 都会污染
JSON-RPC 流；诊断信息一律走 stderr。

## 工具

只读：`agentra_list_projects`、`agentra_search_issues`、`agentra_get_issue`、
`agentra_list_test_projects`、`agentra_search_test_cases`、`agentra_get_test_case`

写入：`agentra_create_issue`、`agentra_update_issue`、
`agentra_create_test_case`、`agentra_update_test_case`

### 两个刻意的"报错而不是猜"

- **创建 issue 时项目类型有多个任务类型（如 任务 / 缺陷）会直接报错**，要求
  显式传 `taskType`。随便挑一个会让 issue 落进不含其状态的流程里，而且不报错。
- **状态名解析限定在 issue 自己的任务类型内**。两条流程常有同名状态
  （都以 `已完成` 结尾），跨流程解析会把 issue 移进它自己流程里不存在的状态。
