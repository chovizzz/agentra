# Agentra MCP Server

把 Agentra 的 issue 与测试用例暴露成 MCP 工具，让 agent 能读写。

## 为什么是这个形状

平台侧的三样东西本来就有，这个服务只是把它们包成 MCP：

- transactor 自带 REST/websocket 接口（`pods/server/src/rpc.ts`）
- 账户设置里可以签发**可撤销**的 API 令牌（commit `5a3d673e8`）
- `@hcengineering/api-client` 给一个裸 token 就能拿到已认证的平台客户端

用 websocket 的 `connect()` 而不是 `connectRest()`：工具需要
`createDoc` / `addCollection` / `updateDoc`，REST 客户端只提供裸 `tx`。

## 认证：走飞书 OAuth，不用静态令牌

agent 连接时浏览器弹飞书登录，之后它以**授权者本人**的身份操作 —— 权限就是
那个人的权限，行为可归因，令牌有过期时间（`MCP_TOKEN_TTL_SEC`，默认 8 小时）。

平台自身没有 OAuth 服务器（`server/account` 里 oauth 相关代码 0 命中），
所以这个服务同时充当 MCP 规范里的授权服务器与资源服务器：`/authorize` 跳飞书，
回调里把 `feishu:<tenant>.<openId>` 解析成 Agentra 账号，再为那个人签一个短期令牌。

🔴 **代价：本服务持有 `SERVER_SECRET`**，也就是说它能为任何人签令牌。收窄它的
是上游而不是签发处 —— 调用方已经过了飞书租户白名单，社交身份来自飞书验证过的
`open_id` 而非用户输入。相比"全员共用一个静态全权限令牌"，这是更小的暴露面。

⚠️ 几个刻意的取舍：

- **不支持 refresh token**。背后的 Agentra 令牌过期时间是固定的，静默续签会
  抵消掉"有界生命周期"这个唯一的刹车。过期就重新授权。
- **回调里不自动开户**。建账号是登录流程的职责（工作区映射与角色规则都在那儿），
  从面向 agent 的端点开第二道更弱的门是不对的。没有账号就提示先登录一次 Agentra。
- **授权码一次性**，取出即删，先于任何校验，所以重放必然失败。
- **令牌存在内存里**，重启即失效、需重新授权。单实例够用；要多实例就得换成共享存储。

## 令牌没有 scope（平台限制）

Agentra 的令牌是**该账号在该工作区的完整权限 JWT** —— 技术方案里设想的
`test:result:write` / `test:case:read` 分级在代码里并不存在
（`PermissionsGrant` 的 `spaces` 是**加法**，见 `getGrantSpaces`，不是减法）。

所以工具集里**故意不提供任何删除操作**：模型幻觉或提示注入的最坏结果应该是
多出脏数据，而不是丢数据。要删就去界面里删。

## 两种用法

**远程（部署形态）**：`MCP_TRANSPORT=http`，`POST /mcp`，`GET /health`。

**本地 stdio**：`MCP_TRANSPORT=stdio`，供 Claude Code / Desktop 直接拉起。
stdio 没有浏览器可跳转，所以这条路仍用 `AGENTRA_TOKEN` —— 它跑在操作者自己的
机器上、以操作者自己的身份，信任边界与 OAuth 登录建立的是同一个。
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
