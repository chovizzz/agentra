# 飞书登录：部署与验证

对应 PRD 的 AUTH-001 / AUTH-004 / AUTH-006。代码已完成，**但要真正登进去必须由你提供一套飞书应用凭据** ——
没有凭据时 `registerFeishu` 直接 `return`，account 服务不上报 `feishu` provider，登录页**连按钮都不会出现**。
「按钮没出现」正是缺凭据的症状，不会报错，别误判成前端坏了。

---

## 1. 在飞书开放平台建应用

<https://open.feishu.cn> → 创建企业自建应用，然后取三样东西：

| 要取的 | 在哪 | 对应环境变量 |
|---|---|---|
| App ID（`cli_` 开头） | 凭证与基础信息 | `FEISHU_CLIENT_ID` |
| App Secret | 凭证与基础信息 | `FEISHU_CLIENT_SECRET` |
| 租户 key（`tenant_key`） | 见下 | `FEISHU_ALLOWED_TENANT_KEYS` |

**重定向 URL 必须在飞书那边登记，且与我们发出去的完全一致**（字符级）。默认我们发的是
`<ACCOUNTS_URL>/auth/feishu/callback`，本地栈即 `http://huly.local:3000/auth/feishu/callback`。
要用别的就设 `FEISHU_REDIRECT_URL`，两边同时改。

> **`tenant_key` 怎么拿**：它不在应用配置页上，是**登录后才知道**的租户标识。最省事的办法是先用一个
> 故意填错的白名单（比如 `FEISHU_ALLOWED_TENANT_KEYS=unknown`）走一次登录，被拒之后从 account 服务日志里
> 读出来 —— 拒绝日志**刻意打印了 `tenantKey`**（`reason: 'tenant not allowed'`），就是为了让这一步能自助完成。
> 然后把真实值填回去。

---

## 2. 配置环境变量

`dev/docker-compose.yaml` 的 account 服务已经把这些变量**裸传**（不是 `- FOO=${FOO}`）——
宿主没设就根本不注入容器。这是有意的：`=${...}` 形式在宿主未设时会注入**空字符串**，
而空串不是「未设置」，会让 provider 带着空 client_id 注册。

在 `dev/.env` 或 shell 里设：

```sh
export FEISHU_CLIENT_ID=cli_xxxxxxxxxxxx
export FEISHU_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
export FEISHU_ALLOWED_TENANT_KEYS=<你的 tenant_key>      # 逗号分隔可多个

# 可选
export FEISHU_DISPLAY_NAME=飞书                          # 不设则按钮显示 "Feishu"
export FEISHU_TENANT_WORKSPACE_MAP=<tenant_key>:agentra-main:USER
export FEISHU_AUTO_PROVISION=true                        # 🔴 默认 false，不设就不会自动开户
export FEISHU_SYNC_PROFILE=true                          # 🔴 默认 false
export FEISHU_STATE_HMAC_SECRET=<独立密钥>                # 不设则回退 SERVER_SECRET
```

### `FEISHU_TENANT_WORKSPACE_MAP` 的语法

`tenantKey:workspaceSlug[:ROLE]`，逗号分隔，`ROLE` 省略为 `USER`：

```
tenantalpha:agentra-main:USER,tenantbeta:agentra-partner:GUEST
```

- `workspaceSlug` 是工作区的 **`url` 字段（slug）**，不是 http 地址。
- **`ADMIN` 会被拒绝** —— 平台级特权角色不允许由环境变量批量授予，一个 typo 不该能把整个租户提权。
- **格式错误会拒绝注册 provider**（不是静默降级）。故意的：静默降级会把一个 typo 变成
  「所有人认证成功、谁也进不去工作区」，且只在生产登录时才暴露。
- **不设 = 整个工作区分配功能关闭**，登录仍然成功，只是账号落地时没有工作区。

### 三个默认值容易踩

`FEISHU_AUTO_PROVISION` 和 `FEISHU_SYNC_PROFILE` **默认都是 `false`**（授予工作区成员资格、
改写他人资料都是特权操作，设计成 opt-in）。只接受 `true` / `false`（大小写不敏感），
**其它值会拒绝注册 provider**。

`FEISHU_AUTO_PROVISION=false` 时，合法租户但尚未获授权的用户会被拒绝登录，并在
`account_events` 表写一行 `feishu_workspace_approval_required`。捞待审批的人：

```sql
SELECT * FROM account_events WHERE event_type = 'feishu_workspace_approval_required';
```

批准的动作走**现有的邀请流程**（本仓没有独立的审批队列，见 `agentra-accepted-risks.md`）。

---

## 3. 起栈

```sh
export PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH"   # 必须 v22，见 CLAUDE.md
node common/scripts/install-run-rush.js docker:build         # 或 docker:min（精简档，省盘）
node common/scripts/install-run-rush.js docker:up            # 或 docker:up:min
```

`huly.local` 要在 `/etc/hosts` 里指向 `127.0.0.1`，前端在 <http://huly.local:8087>。

---

## 4. 验证清单

**不需要真实凭据也能验的**（用假 client id + 任意租户 key 即可）：

| 验什么 | 怎么验 | 期望 |
|---|---|---|
| provider 被上报 | `curl -s http://huly.local:3000/providers` | 返回里含 `{"name":"feishu",...}` |
| 按钮渲染 | 打开 <http://huly.local:8087> | 出现「继续使用 飞书」按钮**且有图标**（图标见下方警告） |
| 授权跳转 | 点按钮 | 302 到 `open.feishu.cn/open-apis/authen/v1/authorize`，query 带 `client_id`、`redirect_uri`、`state` |
| state 绑定浏览器 | 同上 | 响应设了 `feishu-auth-state` 这个 httpOnly cookie |
| 篡改 state 被拒 | `curl -i 'http://huly.local:3000/auth/feishu/callback?state=bogus&code=x'` | 302 回 `/login`，**不发 token** |
| 缺 code 被拒 | 走完授权但去掉 `code` | 302 回 `/login` |

**必须有真实凭据才能验的**：换 token、拉用户资料、租户白名单真正生效、首登开户进工作区、资料同步。

**两条要专门手工走的路**（自动化测试覆盖不到，子代理也点名了）：
1. **邀请路径** —— 带 `?inviteId=<id>` 走飞书登录。租户**没有**配映射时，邀请也**必须**能进去
   （这条曾经被映射检查提前拦掉，已修，但值得真机复验）。
2. **`FEISHU_AUTO_PROVISION=false`** —— 新用户应被拒绝并落一行审批事件；已是成员的用户应正常登入。

---

## 5. 上线前必须处理的两件事

🔴 **① 登录按钮的图标是占位图，不是飞书 logo。**
`plugins/login-resources/src/components/icons/Feishu.svelte` 放的是品牌色渐变方块 + 中性图形。
这是刻意的：一个「很像但不对」的注册商标比一个明显的占位更糟，而且飞书 logo 有商标使用规范
（最小留白、不得改色、不得重绘）。**从飞书官方品牌资源包取正确 SVG 替换整个文件**，
viewBox 和尺寸照现在的写（512×512 / 1.5rem），换掉不影响布局。

🔴 **② 多副本部署下不能声称防重放完整成立。**
`ConsumedNonceStore` 是**进程内 Map**。account 服务跑多副本且没有 sticky session 时，
同一个 state 可以在不同副本上各消费一次。单副本部署不受影响。要修得引共享存储（Redis/DB），
是一笔独立的依赖决策。

---

## 6. 已知不实现的部分

见 `agentra-accepted-risks.md`。与飞书直接相关的：

- **头像不落库** —— account DB 的 `Person` 只有 `{uuid, firstName, lastName}`，没有头像字段
  （头像在各 workspace 的 `contact:class:Person` 上，要 transactor client 才能写）。
  URL 已经解析出来并记进审计事件，供后续 workspace 侧任务消费。
- **部门 / 在职状态不同步** —— 飞书 `/authen/v1/user_info` **不返回**这两项，需要
  `/open-apis/contact/v3/users/:id` + `tenant_access_token`（第二套凭证流程）。
  PRD `prd.md:276` 说 AUTH-006「已实现」**是不准确的**，实际只同步姓名。
- **不签发带工作区的 token** —— 只做 assign。`generateToken` 在 `@hcengineering/server-token`，
  不是 `pods/authProviders` 的依赖。安全上无损（账号级 token 本来就只能进已加入的工作区），
  但与技术规格字面不符。
