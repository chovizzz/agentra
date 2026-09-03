# Agentra V1 Implementation Plan

> **执行方式：** 本计划按 Task 顺序逐项实施。每个 Task 是一个可独立验收的垂直切片，必须走完「写失败测试 → 确认失败 → 实现 → 跑聚焦测试 → 提交」的完整循环，不得跨 Task 合并提交，也不得提前实现后续 Task 的内容。

**Goal:** 在 Huly fork 中交付 Agentra：支持飞书登录、轻量 CRM、版本化需求、项目周期、专业测试、GitHub 交付和产品发布的自托管闭环。

**Architecture:** 复用 Huly Contact、Card、Tracker、Products、Test Management 和 GitHub 模块；新增 CRM、Requirements、Traceability 与 Cycle 插件，并通过服务端幂等 Command 完成跨对象转换。认证在现有 `pods/authProviders` 中增加飞书 Provider，部署配置进入独立 `huly-selfhost` fork。

**Tech Stack:** TypeScript、Svelte 4、Huly Model/Plugin Framework、Rush、Jest、Playwright、Koa/Passport、CockroachDB、Redpanda、MinIO、Elasticsearch、Docker Compose。

---

## 执行规则

- 开始前阅读仓库根目录 `AGENTS.md`；不要自动运行全量 build。
- 每个任务使用 @test-driven-development；后端 Command 使用 @backend-patterns，Svelte 使用 @frontend-patterns，认证和权限任务使用 @security-review。
- 每个任务只提交列出的垂直切片；不要提前实现后续任务。
- 新包必须加入 `rush.json`；模型必须加入 `models/all` 的依赖、builder 和 migration 顺序。
- 🔴 **每个新领域模块必须走完 Technical Spec「新领域模块的固定落地清单」**（见 Technical Spec §3.0，共 11 项）。这类遗漏的统一症状是**「编译通过、测试全绿，但功能在运行时加载不出来」**，包级 `rushx test` 一律测不到。三个最容易漏的：
  - **客户端有两个注册站点**：`dev/prod/src/platform.ts`（Web）**和** `desktop/src/ui/platform.ts`（桌面端），各要做裸 `import '@hcengineering/<name>-assets'`（图标，副作用注册，别被 lint 当无用 import 删掉）+ `addStringsLoader`（文案）+ `addLocation`（`-resources` 的 UI 实现）三处，并各自加 package.json 依赖。只改 Web 那份，桌面端静默少功能。
  - **server plugin 的 `addLocation` 在 `server/server-pipeline/src/serverPlugins.ts` 的 `registerServerPlugins()` 里**，不在 `models/server-*`。漏了它，trigger/server function **一次都不会执行**，而模型构建和类型检查全都能过。
  - `models/server-<name>` 负责的是把 `server<Name>.function.*` / `.trigger.*` 这些**资源 id** 用 `builder.mixin(...)` 挂到具体类上——它和上一条是两件事，两件都要做。
- 每个新 UI 文案必须同时提供 `plugins/*-assets/lang/en.json`、`zh.json` 和 **`ru.json`**，并通过语言 key 测试。🔴 `ru.json` 不是可选项：`foundations/core/packages/platform/src/testUtils.ts` 的 `makeLocalesTest` 硬编码 `const langs = ['en', 'ru']`，缺 `ru.json` 会让该包的 lang 测试直接失败。
- 完成任务后运行该包的 `rushx test`；全量 `rush build`、`rush validate`、Docker 和 UI 套件由用户授权后手动运行。
- 每次提交前执行 `git diff --check`，确认没有 Secret、生成文件或无关上游变更。

### 🔴 两条全项目硬约束（2026-08-26 拍板，任何 Task 不得违反）

**约束 1：任何自建 Kafka 消费者的 handler 必须自行 try/catch。**

上游消费者是**无限原地重试**（handler 抛错既不 commit offset 也不跳过），**一条毒消息会永久卡死整个 partition**，且症状是「消息不再前进」而不是报错退出，极难定位。因此 handler 必须自行 try/catch，catch 里做出明确处置（记录 + 落失败表 / 置 `DeadLetter` 状态 / 显式跳过），**不得直接 rethrow**；单测必须包含「handler 抛错后消费继续前进」这一条（QA NFR-T013）。

**约束 2：枚举只允许末尾追加。**

修改或删除既有枚举值**必须配套扫描迁移**。不止是已持久化的数值会错位：**已保存的筛选视图存的是 JSON 字符串**，其中固化了枚举值，改动会让这些视图**静默失效且不报任何错**（筛出 0 条，用户以为没数据）。适用于 `TestRunStatus`、`ProductVersionState`、`TestCaseStatus`、Lead / Requirement 状态、`TraceLinkKind` 等全部枚举与字面量联合类型（QA NFR-T014）。

### 决策落地说明（2026-08-26）

全部 27 项开放决策已拍板，一律采纳推荐方案（台账见 Technical Spec §13.1）。对本计划的影响：

| 变更 | 影响的 Task |
| --- | --- |
| D2 关闭：TraceLink 只承载**六种跨模块** kind（`blocks` 删除），存储放 `DOMAIN_RELATION` | Task 2、Task 3 |
| **D1 已关闭**：Lead / Requirement 均定为 `card.Card` 扩展类型（MasterTag），看板走路 A 复用 `task.viewlet.Kanban`，不做完成栏 | **Task 0**（载体原型验证，**已完成**，保留为决策记录）；**Task 6 / Task 7 / Task 8 冻结解除**，按 Card 方案正常实施 |
| D3 关闭：不改 `server/account/src/operations.ts` | Task 5（Files 已删该行） |
| D5 / D7 关闭：`ProductVersionState` 末尾追加 + products `enabled: true` + 修 `CreateProductVersion.svelte` | Task 18 |
| D6 关闭：独立不可变 `TestCaseSnapshot`，步骤用内联富文本，TestRun 上下文扁平字段 | Task 13、Task 14 |
| PM-003 + PM-005 Gantt 降级 V1.1 | 不在 V1 计划内 |
| QA-012 整体留 V1（含 JUnit） | Task 16 |
| 幂等 Command 改为 Server Middleware + 确定性 `_id` claim | **新增 Task 3a**、Task 9、Task 11、Task 18 |
| 追溯边四条零创建路径 | **新增 Task 12a、Task 17a、Task 18a**，扩充 Task 15、Task 18 |

## Phase 0：仓库和安全基线

### Task 0：载体最小原型验证（D1）—— ✅ **已完成（2026-08-26），无需再执行**

> 🆕 新增于 2026-08-26：D1（Lead / Requirement 的载体）此前状态为「原型验证中」却**没有对应 Task**，无法排期，且 Task 6 / 7 / 8 全被它阻塞。本 Task 即那次原型验证。
>
> ✅ **原型已完成、用户已拍板、D1 已关闭。本 Task 保留为决策记录，不产出代码、不占用排期。**

**验收问题（原）与结论：**

| # | 验收问题 | 结论 |
| --- | --- | --- |
| 1 | 能否在**不改上游 `card` 包**的前提下，给 Card 扩展类型注册可用的 Kanban viewlet？ | ✅ **能。** 看板硬前提只有三条 —— ① 宿主类有 `rank`；② 有可分组属性；③ 挂 `task.mixin.KanbanCard`，**与是否 Task 子类无关**。Card 自带 `rank`（`plugins/card/src/index.ts:67`、`models/card/src/index.ts:140-142`）；`packages/kanban` 对 `@hcengineering/task` 依赖数为 **0**；`Viewlet.attachTo` 是 `Ref<Class<Doc>>`（`plugins/view/src/types.ts:455-457`）无子类约束；`groupByCategory`（`plugins/view-resources/src/utils.ts:1086-1116`）无 task 分支 |
| 2 | Requirement 走 `plugins/controlled-documents` 是否优于走 Card？ | ❌ **否，走 Card。** 决定性理由：`DocumentState` / `ControlledDocumentState` 都是**字符串 enum**（`plugins/controlled-documents/src/types.ts:193-199`、`:236-243`），装不下 PRD §5.2 的 `InDelivery` / `Validating`（交付生命周期语义，不在文档审批语义内），塞进去必须改上游 enum 及其全部使用处，**每次 upstream sync 都会冲突**。次要理由：创建 CD 强制需要 template，且最少落 4 个 Doc |

🔴 **此前拟用的两条否决理由已被证伪，不得再引用**：CD 用的是标准 `TagReference`（`plugins/controlled-documents/src/types.ts:129`），且已注册 `FullTextSearchContext`（`models/controlled-documents/src/index.ts:698-701`）—— 「标签体系割裂」「全文体系割裂」两条**均不成立**。

**裁决：**

- **Lead 与 Requirement 均定为 `card.Card` 扩展类型（MasterTag）**；
- **看板走「路 A」：复用上游 `task.viewlet.Kanban`**，落地细节见 Technical Spec §3.1.1 与本计划 Task 6 / Task 7；
- **不做完成栏**（赢单 / 丢单作为普通状态列），因此 `KanbanDragDone` 的空条退化不构成问题；
- Requirement 侧仍需自建四项（审批/评审工作流、变更历史 UI、旧版本可检索性、服务端只读强制），其中**旧版本可检索性 V1 明确不做**，**变更历史 V1 只做字段级 Activity 流**（Technical Spec §3.3.2）。

**已解冻：** Task 6 / Task 7 / Task 8 的「不得写死载体断言」限制**已全部解除**，按 Card 方案正常实施。Technical Spec §13.1 的 D1 行已改为「✅ 已关闭」。

### Task 1：建立 fork、上游和功能开关

**Files:**
- Modify: `.git/config`（通过 Git 命令，不提交）
- Create: `docs/deployment/crm-alm-environment.md`
- Modify: `docs/disableFeatures.md`

**Step 1: 核对 remote 和基线**

Run:

```bash
git remote -v
git branch --show-current
git rev-parse HEAD
```

Expected: `origin` 指向 fork，`upstream` 指向 `https://github.com/hcengineering/platform.git`，开发从批准的 `upstream/develop` commit 开始。

**Step 2: 校正 remote（幂等，仅在不符时修复）**

⚠️ 本仓库的 remote **已经是正确配置**（`origin` = fork，`upstream` = 官方上游），因此**不要**执行 `git remote rename origin upstream`——那条命令会与已存在的 `upstream` 冲突并破坏当前配置。按下面的「检查 + 仅在不符时修复」执行：

```bash
# 1. 检查（预期：origin 指向 fork，upstream 指向 hcengineering/platform）
git remote get-url origin   || echo "MISSING origin"
git remote get-url upstream || echo "MISSING upstream"

# 2. 仅在 origin 缺失或指错时执行
git remote add origin <fork-url> 2>/dev/null || git remote set-url origin <fork-url>

# 3. 仅在 upstream 缺失或指错时执行
git remote add upstream https://github.com/hcengineering/platform.git 2>/dev/null \
  || git remote set-url upstream https://github.com/hcengineering/platform.git

# 4. 拉取上游基线
git fetch upstream develop
```

Expected: `git remote -v` 显示 `origin` = fork、`upstream` = `https://github.com/hcengineering/platform.git`；fetch/push 目标分离；不得把提交推到官方上游。若 Step 1 的检查已全部符合，本步骤**零改动**。

**Step 3: 写环境变量文档**

文档列出但不填写真实值：

```text
CRM_ALM_ENABLED
FEISHU_CLIENT_ID
FEISHU_CLIENT_SECRET
FEISHU_ALLOWED_TENANT_KEYS
FEISHU_AUTO_PROVISION
FEISHU_SYNC_PROFILE
```

并说明生产 Secret 只能通过部署 Secret 注入。

**Step 4: 文档检查**

Run: `git diff --check`

Expected: 无空白错误、无 Secret 样例值。

**Step 5: Commit**

```bash
git add docs/deployment/crm-alm-environment.md docs/disableFeatures.md
git commit -m "docs(deploy): define CRM ALM feature flags"
```

## Phase 1：统一关系和身份

### Task 2：创建 Traceability plugin 和模型

**Files:**
- Create: `plugins/traceability/package.json`
- Create: `plugins/traceability/src/index.ts`
- Create: `plugins/traceability/src/plugin.ts`
- Create: `plugins/traceability/src/types.ts`
- Create: `plugins/traceability-assets/package.json`
- Create: `plugins/traceability-assets/src/index.ts`
- Create: `plugins/traceability-assets/src/__tests__/lang.test.ts`
- Create: `plugins/traceability-assets/lang/en.json`
- Create: `plugins/traceability-assets/lang/zh.json`
- Create: `plugins/traceability-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Create: `models/traceability/package.json`
- Create: `models/traceability/src/index.ts`
- Create: `models/traceability/src/types.ts`
- Create: `models/traceability/src/migration.ts`
- Create: `models/traceability/src/__tests__/model.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `models/all/src/migration.ts`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/traceability`、`-assets` 依赖）
- Modify: `dev/prod/src/platform.ts`（裸 `import '@hcengineering/traceability-assets'` 注册图标 + `addStringsLoader(traceabilityId, …)` 注册文案）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的注册，别只改 Web）
- Modify: `rush.json`

**Step 1: 写失败的模型测试**

测试应断言 `TraceLink` 具有 source/sourceClass/target/targetClass/kind/state/sourceBaseId/targetBaseId，且 kind 仅允许 Spec 中的**六种**值。

```ts
expect(traceability.class.TraceLink).toBeDefined()
expect(allowedTraceLink('TestCase', 'verifies', 'Requirement')).toBe(true)
expect(allowedTraceLink('Lead', 'fixed-by', 'Requirement')).toBe(false)
// 🔴 D2 已定：blocks 不再是 TraceLink 的 kind
expect(allowedTraceLink('WorkItem', 'blocks', 'WorkItem')).toBe(false)
```

🔴 **三处 spec 修正必须落进模型**（2026-08-26）：

1. **不声明 `createdBy` / `createdOn`** —— `Doc` 基类已有且平台自动填充，重复声明是错误；
2. **自带 `state: 'active' | 'orphaned' | 'revoked'`** —— `Doc` **没有** `archived` 字段，「删除任一端默认保留归档关系」不是平台现成语义，必须由本字段承载；
3. **逻辑唯一键按版本化口径**（Technical Spec §3.2.1）：`(source, sourceClass, target, targetClass, kind)` 中的 source/target 是**具体版本的 `_id`**，一条边 = 一条具体版本间的审计事实；不是「一对对象只能有一条边」。

**Step 2: 运行测试确认失败**

Run: `cd models/traceability && rushx test`

Expected: FAIL，因为 package/model 尚未注册。

**Step 3: 实现最小模型**

实现 `TraceLinkKind`（**六种**）、`TraceLink`、模型类和 class/kind 组合校验。方向严格遵循 Technical Spec；不创建反向副本。

🔴 **存储域用上游既有的 `DOMAIN_RELATION`，不新建 `DOMAIN_TRACEABILITY`。** `source → docA`、`target → docB`，白拿该域已有的两个 btree 索引，**零上游 schema 补丁**。

⚠️ 别指望 `@Index` 装饰器补索引 —— PG 适配器的 `createIndex` 是空实现（见 QA §6.1 的 R-PG-INDEX 风险项）。走 `DOMAIN_RELATION` 正是为了绕开这一点。

**Step 4: 注册模型和 migration**

将新包加入 Rush 和 `models/all`；migration 只创建 schema/索引和 marker，重复执行不产生额外默认对象。

**Step 5: 运行聚焦测试**

Run: `cd models/traceability && rushx test`

Expected: PASS；第二次执行 migration 测试仍 PASS。

**Step 6: Commit**

```bash
git add plugins/traceability plugins/traceability-assets models/traceability models/all dev/prod rush.json
git commit -m "feat(traceability): add typed cross-module links"
```

### Task 3：实现 Trace Link Command、权限和查询

**Files:**
- Create: `server-plugins/traceability/package.json`
- Create: `server-plugins/traceability/src/index.ts`
- Create: `server-plugins/traceability/src/commands.ts`
- Create: `server-plugins/traceability/src/permissions.ts`
- Create: `server-plugins/traceability/src/__tests__/commands.test.ts`
- Create: `server-plugins/traceability/src/__tests__/permissions.test.ts`
- Create: `server-plugins/traceability-resources/package.json`
- Create: `server-plugins/traceability-resources/src/index.ts`
- Modify: `server/server-pipeline/src/serverPlugins.ts`（`registerServerPlugins()` 里加 `addLocation(serverTraceabilityId, () => import('@hcengineering/server-traceability-resources'))`）
- Modify: `server/server-pipeline/package.json`
- Create: `models/server-traceability/package.json`
- Create: `models/server-traceability/src/index.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `rush.json`

> 📌 与上游 `lead` 一致，server plugin 必须拆成**契约包 + resources 包**两个包：`server-plugins/traceability`（`@hcengineering/server-traceability`，只放契约与类型）和 `server-plugins/traceability-resources`（`@hcengineering/server-traceability-resources`，放实际实现）；`models/server-traceability` 负责把 resources 的 bundle 注册进模型。没有 `-resources` 包就没有地方放服务端实现。

**Step 1: 写失败测试**

覆盖：相同五元组只创建一次、非法 class/kind 被拒绝、无 target 权限不返回 target 元数据、并发重复调用返回同一 Link。

**Step 2: 运行确认失败**

Run: `cd server-plugins/traceability && rushx test`

Expected: FAIL，Command 未实现。

**Step 3: 实现 Command**

实现 `createTraceLink`、`removeTraceLink`、`findOutgoingLinks`、`findIncomingLinks`；确定性 key 或事务内去重，查询逐端权限过滤。

**Step 4: 实现缓存对账**

增加可重建计数更新函数；缓存失败不得回滚已提交 Link，但必须发送 reconciliation event。

**Step 5: 运行测试**

Run: `cd server-plugins/traceability && rushx test`

Expected: PASS，包含并发和越权用例。

**Step 6: Commit**

```bash
git add server-plugins/traceability server-plugins/traceability-resources models/server-traceability models/all rush.json
git commit -m "feat(traceability): enforce idempotent authorized links"
```

### Task 3a：实现幂等 Command 的 Server Middleware（确定性 `_id` claim）

> 🆕 **新增 Task（2026-08-26 拍板，条目 3–4、10）。** Task 9 / 11 / 18 的所有 command 都依赖它，必须先于它们完成。
>
> 📌 **落地包收敛到已有的 `agentra-core` 包族（2026-08-26 定），不另起 `agentra-command`。** 幂等 command middleware 属于跨模块公共基础设施，正是 `agentra-core` 的职责范围；另起一个包意味着 rush.json、`models/all`、`server-pipeline` 的注册面**再走一遍**（Technical Spec §3.0 的固定落地清单），收益为零。`server-plugins/agentra-core`（契约）、`server-plugins/agentra-core-resources`（实现）、`models/server-agentra-core`（模型接线）**均已存在且已完成注册**，本 Task 只在其中**追加文件**，不新建包、不改 `rush.json`。

**Files:**
- Modify: `server-plugins/agentra-core/src/index.ts`（契约追加：claim 类型、确定性 `_id` 生成函数的声明；`serverAgentraCoreId` 已存在，不重复定义）
- Create: `server-plugins/agentra-core/src/claim.ts`
- Create: `server-plugins/agentra-core/src/__tests__/claim.test.ts`
- Modify: `server-plugins/agentra-core-resources/src/index.ts`（导出 middleware bundle）
- Create: `server-plugins/agentra-core-resources/src/middleware.ts`
- Create: `server-plugins/agentra-core-resources/src/__tests__/middleware.test.ts`
- Modify: `models/server-agentra-core/src/index.ts`（把 middleware 的资源 id 接线进模型）
- Modify: `server/server-pipeline/src/pipeline.ts`（注册 middleware，**插在事务展平之后、落库之前**）
- Modify: `server/server-pipeline/package.json`（如缺少 `@hcengineering/server-agentra-core` 依赖则补齐）

> 🔴 **不要重复做已完成的注册。** `server/server-pipeline/src/serverPlugins.ts` 的 `addLocation(serverAgentraCoreId, () => import('@hcengineering/server-agentra-core-resources'))`、`models/all/src/index.ts` 的 `serverAgentraCoreModel` 注册、以及 `rush.json` 的包登记**均已落地**（共 7 处）。本 Task 开工前先核对这三处仍然存在，存在就跳过，不要再加一遍。

**Step 1: 写失败测试**

覆盖：

- **确定性 `_id`**：同一 `(commandName, idempotencyKey, objectRole)` 两次调用生成同一个 `_id`；🔴 **断言 `_id` 是 24 位小写十六进制字符串**——这是 `isId()` 的**运行时校验**形态（`Ref<T>` 类型本身只是 branded string，不带长度约束），hash 结果必须截断/编码到该形态；
- **claim 抢占**：并发两个请求只有一个拿到 claim，另一个读到既有结果；
- **过期 claim 抢占**：claim 带 `startedOn`，超过阈值后可被行锁抢占重做；
- **可重入**：命令执行到第 2 步崩溃后，重放同一 key 从断点续做，不产生重复对象。

**Step 2: 运行确认失败**

Run: `cd server-plugins/agentra-core && rushx test`

Expected: FAIL。

**Step 3: 实现 middleware**

🔴 **前提事实：平台不保证多对象原子性。** `PostgresAdapter.tx()` 按 domain 分组后分别处理 add / update / mixin / remove，`BEGIN/COMMIT` 只包裹 `ConnectionMgr.write()` 的单次回调 —— 一次 `tx()` 会落成**多个互不相干的数据库事务**。因此不能靠数据库事务来保证「Requirement + Trace Link + Lead 状态 + Activity」一起成功，必须靠**可重入**。

实现要点：

- 每一步**先查再写**（`findOne` 命中就跳过），任意步骤失败后重放同一 key 都收敛到同一结果；
- 领域事件**复用平台既有 Tx 事件流**，不自建投递通道；
- 注册点参照 `server-plugins/rating` 的 `RatingMiddleware` 先例（同一条 middleware 链上的自定义 middleware）。

🔴 **V1 不实现 outbox / 死信队列 / 对账 job**（推 V1.1）。V1 只做三件事：过期 claim 抢占、命令可重入、复用平台 Tx 事件流。

**Step 4: 运行测试**

Run: `cd server-plugins/agentra-core && rushx test`

Expected: PASS，含并发与断点续做用例。

**Step 5: Commit**

```bash
git add server-plugins/agentra-core server-plugins/agentra-core-resources models/server-agentra-core server/server-pipeline
git commit -m "feat(command): idempotent server commands via deterministic id claim"
```

### Task 4：实现飞书 OAuth Provider

**Files:**
- Create: `pods/authProviders/src/feishu.ts`
- Create: `pods/authProviders/src/__tests__/feishu.test.ts`
- Modify: `pods/authProviders/src/index.ts`
- Modify: `pods/authProviders/package.json`
- Modify: `foundations/core/packages/core/src/classes.ts`
- Modify: `plugins/login-resources/src/components/Providers.svelte`
- Modify: `plugins/login-assets/lang/en.json`
- Modify: `plugins/login-assets/lang/zh.json`
- Modify: `plugins/login-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Modify: `plugins/login-assets/src/__tests__/lang.test.ts`

**Step 1: 写 OAuth 合同测试**

使用本地 mock server 覆盖授权 URL、state、code 换 token、用户资料、允许租户、非法租户、重放 code、上游 5xx 和日志脱敏。

**Step 2: 运行确认失败**

Run: `cd pods/authProviders && rushx test`

Expected: FAIL，`registerFeishu` 不存在。

**Step 3: 实现 Provider transport**

参考 `github.ts` 和 `openid.ts`，新增 `/auth/feishu` 与 `/auth/feishu/callback`。请求 scope 保持最小；使用现有 `encodeState`、`safeParseAuthState` 和 `handleProviderAuth`。

**Step 4: 增加正式身份类型**

在 `SocialIdType` 增加 FEISHU，identity value 使用可逆转义的 **`<tenant_key>.<open_id>`** 组合；不得复用 OIDC/GITHUB 类型。

🔴 **分隔符绝不能用冒号。** `parseSocialIdString` 的实现是 `split(':')`——社交身份字符串本身已用冒号分隔 type 与 value，value 内部再出现冒号会让 `open_id` 被**静默丢弃**（拿到截断后的前半段，不报错）。用 `.` 分隔并对两段各自做可逆转义；测试必须包含「open_id 内含 `.` / `:` 时仍可无损还原」这一条。

**Step 4a: OAuth state 硬化（只硬化飞书路径）**

在 `feishu.ts` 内自己做 HMAC 签名（`FEISHU_STATE_HMAC_SECRET`）+ nonce 绑定（单次有效、绑 session、带过期）。🔴 **不改 `encodeState` / `safeParseAuthState` 这两个共享 helper** —— 它们被 GitHub / OIDC 共用，改它们会把两条已上线的登录路径拖进回归范围。

**Step 4b: 日志泄漏治理（只治理飞书路径）**

飞书路径的日志只记 request/correlation id 和脱敏错误。🔴 既有的 Google / OIDC / `server/account` 路径同样存在日志泄漏，**另立问题单记录，不在本 Task 顺手改**。

**Step 5: 注册和 UI**

仅当 client id/secret/allowed tenant 配置完整时返回 Provider；登录页使用 Provider 列表渲染飞书按钮。

**Step 6: 运行测试**

Run:

```bash
cd pods/authProviders && rushx test
cd ../../plugins/login-assets && rushx test
```

Expected: OAuth 和语言 key 测试 PASS。

**Step 7: Commit**

```bash
git add pods/authProviders foundations/core/packages/core/src/classes.ts plugins/login-resources plugins/login-assets
git commit -m "feat(auth): add tenant-restricted Feishu login"
```

### Task 5：实现飞书开户、绑定和资料同步

**Files:**
- Create: `pods/authProviders/src/feishuIdentity.ts`
- Create: `pods/authProviders/src/__tests__/feishuIdentity.test.ts`
- Create: `pods/authProviders/src/feishuWorkspace.ts`（租户 → 工作区 → 角色映射 + `AccountDB.assignWorkspace` 调用 + 带工作区的 token 签发）
- Create: `pods/authProviders/src/__tests__/feishuWorkspace.test.ts`
- Modify: `pods/authProviders/src/feishu.ts`
- Create: `pods/authProviders/src/feishuUnionId.ts`（fork 自有表读写）

> 🔴 **不改 `server/account/src/operations.ts`**（2026-08-26 拍板，D3）。该文件是上游热点（近一年 27 次提交），改它必然在每次上游同步时冲突。原计划里的 `Modify: server/account/src/operations.ts` 与 `Create: server/account/src/__tests__/feishuBinding.test.ts` **已删除**；改为在 `pods/authProviders` 内**直接调用 `AccountDB.assignWorkspace`** 并自行签发带工作区的 token。
>
> 🔴 **AUTH-004 是全新能力，不是复用。** 上游 `loginOrSignUpWithProvider` **完全没有 `assignWorkspace` 调用** —— 它只负责「认证成功 + 建/找账号 + 发 token」，**不负责把人放进任何工作区**。租户→工作区解析、assign、带工作区的 token、审批兜底，全部要新写，按新功能估算。
>
> **租户 → 工作区 → 角色映射走部署配置**（`FEISHU_TENANT_WORKSPACE_MAP`），不做工作区内的可视化配置界面。关闭自动开户（`FEISHU_AUTO_PROVISION=false`）时走**管理员审批兜底**：登录成功但未获授权的用户进入待审批队列。
>
> **`union_id` 存 fork 自有表**：不做成第二个 SocialId（会让同一个人出现两条社交身份，破坏绑定主键语义），也不塞进展示字段。绑定主键始终是 `tenant_key + open_id`。

**Step 1: 写失败测试**

覆盖首次开户、已有绑定、同邮箱未绑定不静默合并、自动开户关闭、union_id 迁移、离职禁用和本地管理员兜底。

**Step 2: 运行确认失败**

Run: `cd server/account && rushx test`

Expected: FAIL，缺少飞书绑定策略。

**Step 3: 实现绑定服务**

分离“认证成功”和“允许加入工作区”两个判断。绑定现有账号要求已登录确认或管理员审批；同步失败不撤销有效 session。

**Step 4: 实现可选资料同步**

仅在 `FEISHU_SYNC_PROFILE=true` 时更新姓名、头像、部门和在职状态；写审计事件，禁止覆盖 Huly 权限角色。

> 🔴 **实现后更正（2026-08-28）：本步实际只交付了「姓名」。** 头像**未落库**（account DB 的
> `Person` 只有 `{uuid, firstName, lastName}`，头像挂在各 workspace 的 `contact:class:Person` 上，
> 需要 transactor client）；部门与在职状态**拿不到**（飞书 `/authen/v1/user_info` 不返回，需改用
> `/open-apis/contact/v3/users/:id` + `tenant_access_token`）。`FEISHU_SYNC_PROFILE` 开关、审计事件、
> 「不覆盖权限角色」、「同步失败不阻断登录」四项均已按本步要求实现。
> PRD 的 AUTH-006 行与 V1 退出标准已同步收窄，见 prd.md V1 承诺 P1 表下的说明。

**Step 5: 运行测试与安全检查**

Run:

```bash
cd pods/authProviders && rushx test
```

Expected: PASS；测试日志断言不包含 code/token/secret。

**Step 6: Commit**

```bash
git add pods/authProviders
git commit -m "feat(auth): provision and bind Feishu identities"
```

## Phase 2：CRM 和需求入口

### Task 6：创建 CRM Lite 模型和默认 Pipeline

**Files:**
- Create: `plugins/crm-lite/package.json`
- Create: `plugins/crm-lite/src/index.ts`
- Create: `plugins/crm-lite/src/plugin.ts`
- Create: `plugins/crm-lite/src/types.ts`
- Create: `plugins/crm-lite-assets/package.json`
- Create: `plugins/crm-lite-assets/src/index.ts`
- Create: `plugins/crm-lite-assets/src/__tests__/lang.test.ts`
- Create: `plugins/crm-lite-assets/lang/en.json`
- Create: `plugins/crm-lite-assets/lang/zh.json`
- Create: `plugins/crm-lite-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Create: `models/crm-lite/package.json`
- Create: `models/crm-lite/src/index.ts`
- Create: `models/crm-lite/src/types.ts`
- Create: `models/crm-lite/src/plugin.ts`
- Create: `models/crm-lite/src/migration.ts`
- Create: `models/crm-lite/src/__tests__/migration.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`（`createModel` 注册 + `enabled` 策略）
- Modify: `models/all/src/migration.ts`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/crm-lite`、`-assets` 依赖）
- Modify: `dev/prod/src/platform.ts`（裸 `import '@hcengineering/crm-lite-assets'` 注册图标 + `addStringsLoader(crmLiteId, …)` 注册文案）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的注册，别只改 Web）
- Modify: `rush.json`

**Step 1: 写模型和 migration 失败测试**

断言 Lead 的业务字段包含 account/contact/source/owner/status/priority/nextActionAt；默认状态和来源只创建一次。

> ✅ **D1 已关闭（2026-08-26），本 Task 冻结解除。Lead 定为 `card.Card` 扩展类型（MasterTag）**，可以写死载体断言、正常建模型类（依据见 Task 0 与 Technical Spec §3.1）。
>
> 🔴 **看板走「路 A」：复用上游 `task.viewlet.Kanban`。** 本 Task 需额外落地（模型侧）：
>
> - 在 `models/agentra-core/src/index.ts` 注册一个 `view.class.Viewlet`，`descriptor: task.viewlet.Kanban`，`attachTo` 指向 Lead 的 MasterTag；
> - `builder.mixin(<Lead MasterTag>, core.class.Class, task.mixin.KanbanCard, { card: ... })`；
> - Lead 的 MasterTag 上声明**状态属性作为分组依据**，并给该属性类注册 `view.mixin.SortFuncs` 与 `view.mixin.AllValuesFunc`（先例：`models/controlled-documents/src/index.ts:690-696` 给 `TypeDocumentState` 挂了同一对 mixin，且它**不是 Task 域**）；
> - `plugins/agentra-core` / `models/agentra-core` 的 `package.json` 加 `@hcengineering/task`、`@hcengineering/task-resources` 依赖。
>
> 🔴 **两处已知退化如实接受，不得"顺手修"**（Technical Spec §3.1.1）：① `KanbanView.svelte:89-100` 硬编码的 `lookup` 对 Card 无效，代价是 3 次无用 JOIN，`$lookup.*` 为 `undefined`，**不报错**；② `KanbanDragDone.svelte:33` 查 `task.class.Project`，完成栏会渲染成空条 —— ✅ **用户已决定不做完成栏**，赢单/丢单作为普通状态列，故该退化不构成问题。
>
> 📌 日后若要消除这两处退化，切到自写 viewlet 即可：**模型侧注册代码完全一样，只换一个 `descriptor` 常量，不返工。**

**Step 2: 运行确认失败**

Run: `cd models/crm-lite && rushx test`

Expected: FAIL，CRM 模型不存在。

**Step 3: 实现类型和模型**

复用 `Organization`、`Person`、`Card`；定义 Lead status、source、priority 和 CRM role。不得复制 Organization/Person 数据。

**Step 4: 实现可重复 migration**

创建默认 Pipeline：New、Contacted、Qualifying、Converted、Disqualified；旧 `lead` 数据不自动导入。

**Step 5: 运行测试**

Run:

```bash
cd models/crm-lite && rushx test
cd ../../plugins/crm-lite-assets && rushx test
```

Expected: model/migration/i18n 全部 PASS。

**Step 6: Commit**

```bash
git add plugins/crm-lite plugins/crm-lite-assets models/crm-lite models/all dev/prod rush.json
git commit -m "feat(crm): add card-based lead model"
```

### Task 7：实现 CRM List、Kanban 和详情页

**Files:**
- Create: `plugins/crm-lite-resources/package.json`
- Create: `plugins/crm-lite-resources/src/index.ts`
- Create: `plugins/crm-lite-resources/src/plugin.ts`
- Create: `plugins/crm-lite-resources/src/components/LeadList.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadKanban.svelte`
- Create: `plugins/agentra-core-resources/src/components/KanbanCard.svelte`（路 A 的看板卡片，参照 `plugins/lead-resources/src/components/KanbanCard.svelte`）
- Create: `plugins/crm-lite-resources/src/components/EditLead.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadDetails.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadActivity.svelte`
- Create: `plugins/crm-lite-resources/src/__tests__/leadValidation.test.ts`
- Modify: `plugins/crm-lite/package.json`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/crm-lite-resources` 依赖）
- Modify: `dev/prod/src/platform.ts`（`addLocation(crmLiteId, async () => await import('@hcengineering/crm-lite-resources'))`）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的 `addLocation`）
- Modify: `rush.json`

> 📌 `-resources` 包只有在 `dev/prod/src/platform.ts` 里被 `addLocation` 注册后才会被平台加载。没有这一步，CRM 导航能出现但点开是空白——**包级 `rushx test` 测不出这类故障**，必须在 Task 完成时人工核对该文件的 diff。
>
> ✅ **D1 已关闭（2026-08-26），本 Task 冻结解除。** 按 Card 方案 + 路 A 正常实施：模型侧的 viewlet / `KanbanCard` mixin 注册在 Task 6 完成；本 Task 负责 UI 侧 —— **在 `plugins/agentra-core-resources` 写 `KanbanCard.svelte`**（参照 `plugins/lead-resources/src/components/KanbanCard.svelte`），`LeadKanban.svelte` 直接消费上游 `task.viewlet.Kanban` 渲染出的看板。**不做完成栏**（赢单/丢单是普通状态列），因此不要实现任何「拖到完成区」交互。

**Step 1: 写表单校验测试**

覆盖必填 Account/Contact、owner、nextActionAt、Disqualified 原因和 Converted 只读限制。

**Step 2: 运行确认失败**

Run: `cd plugins/crm-lite-resources && rushx test`

Expected: FAIL，validation 未实现。

**Step 3: 实现最小 CRM UI**

List/Kanban 使用同一查询；拖动只改变 status；详情页组合字段、Card content、Activity、附件和 Trace Link 摘要。

**Step 4: 验证资源包**

Run: `cd plugins/crm-lite-resources && rushx test`

Expected: PASS。Svelte 检查命令 `rushx svelte-check` 由用户授权后运行。

**Step 5: Commit**

```bash
git add plugins/crm-lite-resources plugins/crm-lite dev/prod rush.json
git commit -m "feat(crm): add lead list kanban and details"
```

### Task 8：创建独立 Requirements 模块

**Files:**
- Create: `plugins/requirements/package.json`
- Create: `plugins/requirements/src/index.ts`
- Create: `plugins/requirements/src/plugin.ts`
- Create: `plugins/requirements/src/types.ts`
- Create: `plugins/requirements-assets/package.json`
- Create: `plugins/requirements-assets/src/index.ts`
- Create: `plugins/requirements-assets/src/__tests__/lang.test.ts`
- Create: `plugins/requirements-assets/lang/en.json`
- Create: `plugins/requirements-assets/lang/zh.json`
- Create: `plugins/requirements-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Create: `plugins/requirements-resources/package.json`
- Create: `plugins/requirements-resources/src/index.ts`
- Create: `plugins/requirements-resources/src/plugin.ts`
- Create: `plugins/requirements-resources/src/components/EditRequirement.svelte`
- Create: `plugins/requirements-resources/src/components/RequirementDetails.svelte`
- Create: `models/requirements/package.json`
- Create: `models/requirements/src/index.ts`
- Create: `models/requirements/src/types.ts`
- Create: `models/requirements/src/migration.ts`
- Create: `models/requirements/src/__tests__/requirement.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`（`createModel` 注册 + `enabled` 策略）
- Modify: `models/all/src/migration.ts`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/requirements`、`-assets`、`-resources` 依赖）
- Modify: `dev/prod/src/platform.ts`（裸 `import '@hcengineering/requirements-assets'` 注册图标 + `addStringsLoader` 注册文案 + `addLocation(requirementsId, …)` 注册 UI）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的三处注册）
- Modify: `rush.json`

**Step 1: 写失败测试**

断言 Requirement 包含状态、priority、owner、product、targetVersion、acceptanceCriteria；状态机拒绝未批准直接进入 `InDelivery`（显示文案 In Delivery，映射见 Technical Spec §3.9）。

> ✅ **D2 已关闭（2026-08-26）**：「来源 Lead / Work Item / Test Case 经由 TraceLink 查询」**已是定论**，可以写成验收断言。
>
> ✅ **D1 已关闭（2026-08-26），本 Task 冻结解除。Requirement 定为 `card.Card` 扩展类型**，可以写死载体断言（依据见 Task 0 与 Technical Spec §3.3.1：否决 ControlledDocument 的决定性理由是其状态为字符串 enum、装不下 `InDelivery` / `Validating`，改上游必然每次 sync 冲突）。
>
> 🔴 **变更历史的 V1 口径已软化**：本 Task 只做**字段级 Activity 流**（谁在何时改了哪个字段）—— Card 现成能力，零成本。**不做跨版本正文 diff**，**不做旧版本全文检索**（后者需改上游 `server/indexer` 索引逻辑，属长期补丁，V1 明确不做）。Requirement 侧仍需自建的四项见 Technical Spec §3.3.2。

**Step 2: 运行确认失败**

Run: `cd models/requirements && rushx test`

Expected: FAIL。

**Step 3: 实现模型和状态机**

建立 Draft、Reviewing、Approved、InDelivery、Validating、Released、Rejected、Cancelled；摘要计数明确为可重建缓存。

**Step 4: 实现 Requirement 页面**

显示版本化正文、验收标准、来源 Lead、Work Item、Test Coverage、Bug、PR 和 Product Version。**变更历史只渲染字段级 Activity 流**，不做正文 diff 视图。

**Step 5: 运行聚焦测试**

Run:

```bash
cd models/requirements && rushx test
cd ../../plugins/requirements-assets && rushx test
```

Expected: PASS。

**Step 6: Commit**

```bash
git add plugins/requirements plugins/requirements-assets plugins/requirements-resources models/requirements models/all dev/prod rush.json
git commit -m "feat(requirements): add versioned product requirements"
```

### Task 9：实现 Lead → Requirement 幂等转换

**Files:**
- Create: `server-plugins/crm-lite/package.json`
- Create: `server-plugins/crm-lite/src/index.ts`
- Create: `server-plugins/crm-lite-resources/package.json`
- Create: `server-plugins/crm-lite-resources/src/index.ts`
- Modify: `server/server-pipeline/src/serverPlugins.ts`（加 `addLocation(serverCrmLiteId, () => import('@hcengineering/server-crm-lite-resources'))`）
- Modify: `server/server-pipeline/package.json`
- Create: `server-plugins/crm-lite/src/commands/convertLead.ts`
- Create: `server-plugins/crm-lite/src/__tests__/convertLead.test.ts`
- Create: `models/server-crm-lite/package.json`
- Create: `models/server-crm-lite/src/index.ts`
- Modify: `plugins/crm-lite-resources/src/components/LeadDetails.svelte`
- Create: `plugins/crm-lite-resources/src/components/ConvertLead.svelte`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `rush.json`

**Step 1: 写失败的并发/幂等测试**

同一 Lead 使用相同或不同客户端并发转换，断言只存在一个 Requirement 和一个 `converted-to` Link；重复请求返回原结果。

**Step 2: 运行确认失败**

Run: `cd server-plugins/crm-lite && rushx test`

Expected: FAIL。

**Step 3: 实现服务端 Command**

输入 lead/product/project/owner/idempotencyKey。

🔴 **不是「在单个业务事务中」** —— 该措辞已更正（2026-08-26）。一次 `PostgresAdapter.tx()` 会落成多个互不相干的数据库事务（按 domain 分组分别处理 add/update/mixin/remove，`BEGIN/COMMIT` 只包裹单次 `ConnectionMgr.write()` 回调），**平台不保证多对象原子性**。正确做法：走 **Task 3a 的确定性 `_id` claim + 可重入命令**，依次创建 Requirement、Trace Link、Lead 状态、Activity，**每一步先查再写**；中途失败后重放同一 idempotencyKey 从断点续做，不产生重复对象。

**事件走平台既有 Tx 事件流，不用 outbox**（outbox 推 V1.1）。

**Step 4: 实现转换 UI**

Converted Lead 按钮变为“打开需求”；网络超时重试复用同一 idempotency key。

**Step 5: 运行测试**

Run: `cd server-plugins/crm-lite && rushx test`

Expected: PASS，包含并发、权限、字段缺失和已归档 Lead。

**Step 6: Commit**

```bash
git add server-plugins/crm-lite models/server-crm-lite plugins/crm-lite-resources models/all rush.json
git commit -m "feat(crm): convert leads to requirements idempotently"
```

## Phase 3：项目执行

### Task 10：新增 Cycle 模型和 Issue mixin

**Files:**
- Create: `plugins/cycle/package.json`
- Create: `plugins/cycle/src/index.ts`
- Create: `plugins/cycle/src/plugin.ts`
- Create: `plugins/cycle/src/types.ts`
- Create: `plugins/cycle-assets/package.json`
- Create: `plugins/cycle-assets/src/index.ts`
- Create: `plugins/cycle-assets/src/__tests__/lang.test.ts`
- Create: `plugins/cycle-assets/lang/en.json`
- Create: `plugins/cycle-assets/lang/zh.json`
- Create: `plugins/cycle-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Create: `models/cycle/package.json`
- Create: `models/cycle/src/index.ts`
- Create: `models/cycle/src/types.ts`
- Create: `models/cycle/src/migration.ts`
- Create: `models/cycle/src/__tests__/cycle.test.ts`
- Create: `models/cycle/src/__tests__/migration.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`（`createModel` 注册 + `enabled` 策略）
- Modify: `models/all/src/migration.ts`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/cycle`、`-assets` 依赖）
- Modify: `dev/prod/src/platform.ts`（裸 `import '@hcengineering/cycle-assets'` 注册图标 + `addStringsLoader(cycleId, …)` 注册文案）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的注册，别只改 Web）
- Modify: `rush.json`

**Step 1: 写失败测试**

覆盖日期合法性、同项目 sequence、Issue cycle mixin、状态机和重复 migration。

**Step 2: 运行确认失败**

Run: `cd models/cycle && rushx test`

Expected: FAIL。

**Step 3: 实现模型**

Cycle 字段完全按 Technical Spec；Issue 只增加一个可空 Ref，不创建平行 Issue。

**Step 4: 运行测试**

Run: `cd models/cycle && rushx test`

Expected: PASS。

**Step 5: Commit**

```bash
git add plugins/cycle plugins/cycle-assets models/cycle models/all dev/prod rush.json
git commit -m "feat(planning): add project cycles"
```

### Task 11：实现 Cycle UI、完成和 rollover

**Files:**
- Create: `plugins/cycle-resources/package.json`
- Create: `plugins/cycle-resources/src/index.ts`
- Create: `plugins/cycle-resources/src/plugin.ts`
- Create: `server-plugins/cycle/package.json`
- Create: `server-plugins/cycle/src/index.ts`
- Create: `server-plugins/cycle/src/completeCycle.ts`
- Create: `models/server-cycle/package.json`
- Create: `models/server-cycle/src/index.ts`
- Create: `server-plugins/cycle/src/__tests__/completeCycle.test.ts`
- Create: `plugins/cycle-resources/src/components/CycleBoard.svelte`
- Create: `plugins/cycle-resources/src/components/CycleStats.svelte`
- Create: `server-plugins/cycle-resources/package.json`
- Create: `server-plugins/cycle-resources/src/index.ts`
- Modify: `server/server-pipeline/src/serverPlugins.ts`（加 `addLocation(serverCycleId, () => import('@hcengineering/server-cycle-resources'))`）
- Modify: `server/server-pipeline/package.json`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/cycle-resources` 依赖）
- Modify: `dev/prod/src/platform.ts`（`addLocation(cycleId, async () => await import('@hcengineering/cycle-resources'))`）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的 `addLocation`）
- Modify: `rush.json`

**Step 1: 写 rollover 失败测试**

覆盖完成项保留、未完成项滚入下周期/Backlog、重复完成 Command、取消周期和 Activity 快照。

**Step 2: 运行确认失败**

Run: `cd server-plugins/cycle && rushx test`

Expected: FAIL。

**Step 3: 实现 `CompleteCycle`**

Command 计算快照并批量更新 Issue；事件重复投递不重复 rollover。

**Step 4: 实现 Board/Stats**

展示目标、容量、承诺/完成、燃尽和未完成项；统计由 Activity/快照计算。

**Step 5: 运行测试并提交**

Run: `cd server-plugins/cycle && rushx test`

```bash
git add plugins/cycle-resources server-plugins/cycle server-plugins/cycle-resources models/server-cycle models/all dev/prod rush.json
git commit -m "feat(planning): complete and report project cycles"
```

### Task 12：连接 Requirement、Work Item 和项目视图

**Files:**
- Create: `server-plugins/requirements/package.json`
- Create: `server-plugins/requirements/src/index.ts`
- Create: `server-plugins/requirements-resources/package.json`
- Create: `server-plugins/requirements-resources/src/index.ts`
- Modify: `server/server-pipeline/src/serverPlugins.ts`（加 `addLocation(serverRequirementsId, () => import('@hcengineering/server-requirements-resources'))`）
- Modify: `server/server-pipeline/package.json`
- Create: `server-plugins/requirements-resources/src/commands/createWorkItems.ts`
- Create: `server-plugins/requirements-resources/src/__tests__/createWorkItems.test.ts`
- Create: `models/server-requirements/package.json`
- Create: `models/server-requirements/src/index.ts`
- Modify: `plugins/requirements-resources/src/components/RequirementDetails.svelte`
- Modify: `plugins/tracker-resources/src/components/issues/edit/EditIssue.svelte`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `rush.json`

**Step 1: 写失败测试**

从 Requirement 创建 Story/Task/Bug，断言 `WorkItem --implements--> Requirement` 唯一、权限正确、取消请求不留半成品。

**Step 2: 实现 Command 和 UI**

批量创建采用一个 command；Issue 页面只通过 Traceability 展示 Requirement，不复制验收正文。

**Step 3: 运行测试**

Run: `cd server-plugins/requirements-resources && rushx test`

Expected: PASS。

**Step 4: Commit**

```bash
git add server-plugins/requirements server-plugins/requirements-resources models/server-requirements plugins/requirements-resources plugins/tracker-resources models/all rush.json
git commit -m "feat(requirements): trace delivery work items"
```

### Task 12a：`implements` 的手工双向关联 UI 与 command

> 🆕 **新增 Task（2026-08-26）。** 盘点发现 `implements` 只有「从 Requirement 批量拆 Work Item」一条创建路径（Task 12），**已存在的 Issue 无法与 Requirement 建立关系**。这是追溯链的断点。

**Files:**
- Create: `server-plugins/traceability-resources/src/commands/linkImplements.ts`
- Create: `server-plugins/traceability-resources/src/__tests__/linkImplements.test.ts`
- Create: `plugins/traceability-resources/src/components/LinkRequirementDialog.svelte`
- Create: `plugins/traceability-resources/src/components/LinkWorkItemDialog.svelte`
- Modify: `plugins/requirements-resources/src/components/RequirementDetails.svelte`（入口 1：从 Requirement 关联已有 Work Item）
- Modify: `plugins/tracker-resources/src/components/issues/edit/EditIssue.svelte`（入口 2：从 Issue 关联已有 Requirement）
- Modify: `plugins/traceability-assets/lang/en.json`
- Modify: `plugins/traceability-assets/lang/zh.json`
- Modify: `plugins/traceability-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）

**Step 1: 写失败测试**

覆盖：重复关联幂等（同一五元组只有一条边）、两端权限各自校验、解除关联把 `state` 置为 `revoked`（**不物理删边**）、无权用户在选择器里搜不到无权对象。

**Step 2: 实现 command 与两个入口**

`linkImplements` / `unlinkImplements` 走 Task 3a 的幂等 command；**两个入口调同一个 command**，不各写一套。

**Step 3: 运行测试并提交**

Run: `cd server-plugins/traceability-resources && rushx test`

```bash
git add server-plugins/traceability-resources plugins/traceability-resources plugins/traceability-assets plugins/requirements-resources plugins/tracker-resources
git commit -m "feat(traceability): link work items to requirements manually"
```

### Task 12b：Work Item 批量编辑与 Saved View（PM-008a）

> 🆕 **新增 Task（2026-08-26）。** 盘点 PRD §9 反向缺口时发现 `PM-008a` 在 V1 承诺冻结清单里，实施计划中却没有实现其核心交付物的 Task。本 Task 补齐。
>
> 📌 **现状核实（已查证，决定了本 Task 的形状）**：这两项能力**上游基本现成**，本 Task 的主体是**注册 action + 接线与回归**，**不是从零实现**：
>
> - **批量编辑 = `input: 'any'` 的 action。** 上游先例见 `models/tracker/src/actions.ts` 的 `SetStatus` / `SetPriority` / `SetAssignee`（该文件里 `input: 'any'` 有十余处）；执行侧 `plugins/view-resources/src/actionImpl.ts` 的 `ValueSelector`（第 592-617 行）签名就是 `doc: Doc | Doc[]`，**多选与单选走同一条代码路径**，无需另写批量通道。
> - **Saved View = `view.class.FilteredView`。** 接口在 `plugins/view/src/types.ts:110-121`（`filters` / `viewOptions` / `filterClass` / `viewletId` / `sharable` / `users` / `attachedTo`），**真持久化**在 `DOMAIN_VIEW`（`models/view/src/index.ts:124-126` 的 `TFilteredView`）；保存 UI 是 `plugins/view-resources/src/components/filter/FilterSave.svelte`，管理 UI 是 `plugins/workbench-resources/src/components/SavedView.svelte`（个人 / 共享 / 重命名 / 公开切换 / 删除齐全；⚠️ **没有独立的「订阅」操作** —— 共享是往 `FilteredView.users` 里 `$push` 当前账号实现的，`SavedView.svelte:47-53 / 237-264`。写测试时按这个语义断言，别去找一个不存在的 subscribe action），由 `plugins/workbench-resources/src/components/Navigator.svelte:175` 按 **Application 的 `alias`** 分组渲染。
>
> 因此**工作量量级：S（≤1 人日）**。不新建任何包，**不触发** Technical Spec §3.0 的 11 处注册清单。
>
> 🔴 **接线的真正风险点是 `alias`**：Saved View 分组是按 `alias` 挂的，Agentra 新增的 Application（CRM / Requirements / Cycle）若没设 `alias`，Navigator 里根本不出现 Saved View 分组——**编译通过、功能静默消失**，正是本计划反复警告的那类症状。
>
> **依赖**：**Task 10**（Cycle mixin 字段）、**Task 12**（Work Item ↔ Requirement 接线）必须先完成；`FilteredView` 的筛选面依赖 **Task 6 / Task 8** 已建好 Lead / Requirement 的类与视图。
>
> ⚠️ **Files 里的 `models/cycle` / `plugins/cycle*` / `models/crm-lite` / `models/requirements` 在今天的仓库里还不存在** —— 它们分别由 **Task 10 / Task 6 / Task 8** 创建。本 Task 只在那三个 Task 完成后才可开工，届时这些路径全部存在。

**Files:**
- Modify: `models/cycle/src/index.ts`（两件事同一文件：① 新增 `SetCycle` 批量 action，**照抄 `models/tracker/src/actions.ts` 的 `SetPriority` 形状** —— `input: 'any'` + `actionImpl.ValueSelector` + `visibilityTester`；② Cycle 视图挂 `view.mixin.ClassFilters`）
- Create: `plugins/cycle-resources/src/components/SetCyclePopup.svelte`（值选择器弹窗）
- Modify: `plugins/cycle-resources/src/index.ts`（导出上面的组件）
- Modify: `plugins/cycle/src/plugin.ts`（声明 `component.SetCyclePopup` 与 `string.SetCycle` 资源 id）
- Modify: `plugins/cycle-assets/lang/en.json`
- Modify: `plugins/cycle-assets/lang/zh.json`
- Modify: `plugins/cycle-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Modify: `models/crm-lite/src/index.ts`（Lead 的 `view.mixin.ClassFilters`；Application 补 `alias`）
- Modify: `models/requirements/src/index.ts`（Requirement 的 `view.mixin.ClassFilters`；Application 补 `alias`）
- Create: `models/cycle/src/__tests__/bulkActions.test.ts`
- Create: `models/requirements/src/__tests__/savedView.test.ts`

**Step 1: 写失败测试**

批量编辑（`models/cycle/src/__tests__/bulkActions.test.ts`）：

- `SetCycle` 的 `input` 必须是 `'any'`，`target` 是 Issue，且 action 已注册到 model（断言 builder 产出的 tx 里存在该 action）；
- 多选 N 条 Issue 执行一次，产生 **N 条 `TxUpdateDoc`**，不产生任何 `TxCreateDoc`；
- **跨项目多选**：只更新与目标 Cycle 同项目的 Issue，其余**显式报错并整批拒绝**，不静默跳过（静默跳过等于用户以为改了其实没改）；
- **权限**：`visibilityTester` 对调用者无权的 Issue 返回 `false`；无权对象不得出现在批量结果计数里（计数本身是侧信道，同 REL-T014 的口径）。

Saved View（`models/requirements/src/__tests__/savedView.test.ts`）：

- Agentra 每个 Application 都有非空 `alias`（**逐个断言**，这是 Saved View 分组渲染的唯一挂载点）；
- Lead / Requirement / Cycle 三个类都挂了 `view.mixin.ClassFilters`（没有它 `FilterBar` 出不来，也就无从保存）；
- `sharable: false` 的 `FilteredView` 只对 `users` 内的账号可见；
- 🔴 **呼应全项目硬约束 2**：`FilteredView.filters` 是**固化了枚举数值的 JSON 字符串**。用例必须包含「枚举末尾追加新值后，既有 Saved View 仍筛出原有结果」——枚举一旦重排/删除，这些视图会**筛出 0 条且不报任何错**。

**Step 2: 运行确认失败**

Run:

```bash
cd models/cycle && rushx test
cd ../requirements && rushx test
```

Expected: FAIL。

**Step 3: 注册批量 action**

`SetCycle` 复用 `view.actionImpl.ValueSelector`，**不自写批量循环**；Cycle 候选列表按调用者权限过滤后再回传弹窗。

**Step 4: 补 `alias` 与 `ClassFilters` 接线**

只补注册，不改 `FilterSave.svelte` / `SavedView.svelte` 任何一行——上游那套个人/共享/重命名/订阅/删除**直接可用**，改它等于给后续上游合并制造冲突。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add models/cycle models/crm-lite models/requirements plugins/cycle plugins/cycle-resources plugins/cycle-assets
git commit -m "feat(tracker): bulk edit work items and expose saved views"
```

### Task 12c：Work Item 模板（PM-008b）

> 🆕 **新增 Task（2026-08-26）。** 同上，`PM-008b` 在 PRD §9 冻结清单里但无对应 Task。
>
> 📌 **现状核实（已查证）**：`tracker.class.IssueTemplate` **上游已存在且功能完整**：
>
> - 类型：`plugins/tracker/src/index.ts:275-310`（`IssueTemplateData` / `IssueTemplateChild` / `IssueTemplate`，含 `children` 子项数组）；
> - 模型：`models/tracker/src/types.ts:280` 的 `TIssueTemplate`，在 `models/tracker/src/index.ts` 注册（`ClassFilters`、`ActivityDoc`、`ObjectPanel`、Activity viewlet 都已挂）；
> - UI：`plugins/tracker-resources/src/components/templates/` 全套（`CreateIssueTemplate` / `EditIssueTemplate` / `IssueTemplates` / `IssueTemplateChildList` …），导航入口在 `models/tracker/src/index.ts:426-428`；
> - **从模板建 Issue 也现成**：`plugins/tracker-resources/src/components/CreateIssue.svelte:267-360` 的 `updateTemplate()` 把模板字段连同 `children` 一起铺进新建表单。
>
> 缺的只是 **Agentra 新增的字段没有进模板**：`IssueTemplateData` 里既没有 Cycle（Task 10 的 mixin 字段），也没有 `implements`（Task 12 / 12a 的追溯边）。所以本 Task = **扩字段 + 建 Issue 时把这些字段一并套用**。
>
> **工作量量级：S–M（1–2 人日）**。不新建包，**不触发** 11 处注册清单。
>
> 🔴 **只允许在 `IssueTemplateData` 末尾追加可空字段**，不得改既有字段的名称、类型或语义——`IssueTemplate` 是上游类，改既有字段会同时打断上游合并与存量模板数据。
>
> **依赖**：**Task 10**（Cycle mixin）、**Task 12**、**Task 12a**（`implements` 的 command，模板套用时复用它，不另写一份建边逻辑）。

**Files:**
- Modify: `plugins/tracker/src/index.ts`（`IssueTemplateData` **末尾追加**可空 `cycle?: Ref<Cycle> | null` 与 `implementsRequirement?: Ref<Requirement> | null`）
- Modify: `models/tracker/src/types.ts`（`TIssueTemplate` 同步这两个字段的 `@Prop` 声明）
- Modify: `models/tracker/src/index.ts`（模板列表新增两列的 viewlet 配置）
- Modify: `plugins/tracker-resources/src/components/templates/CreateIssueTemplate.svelte`（编辑模板时可选 Cycle / Requirement）
- Modify: `plugins/tracker-resources/src/components/templates/EditIssueTemplate.svelte`（同上）
- Modify: `plugins/tracker-resources/src/components/CreateIssue.svelte`（`updateTemplate()` 把新字段一并铺进表单；Requirement 走 Task 12a 的 `linkImplements` command 建边，**不在 UI 里直接写 TraceLink**）
- Modify: `plugins/tracker-assets/lang/en.json`
- Modify: `plugins/tracker-assets/lang/zh.json`
- Modify: `plugins/tracker-assets/lang/ru.json`（🔴 缺 `ru.json` 该包 lang 测试直接失败）
- Create: `models/tracker/src/__tests__/issueTemplate.test.ts`
- Create: `server-plugins/traceability-resources/src/__tests__/templateImplements.test.ts`

**Step 1: 写失败测试**

- 存量模板（没有新字段的旧文档）读出来不报错，新字段为 `undefined`——**零数据迁移**，因为只追加可空字段；
- 带 Cycle 的模板建 Issue：新 Issue 的 Cycle mixin 字段等于模板值；模板 Cycle 已结束/已归档时**留空并提示**，不得把 Issue 塞进已结束周期；
- 带 Requirement 的模板建 Issue：产生**恰好一条** `WorkItem --implements--> Requirement` 边，且走的是 Task 12a 的 `linkImplements` command（断言幂等：同一模板连建两条 Issue 产生两条边，各自唯一；重放同一 `idempotencyKey` 不重复建边）；
- 模板里的 Requirement 对建 Issue 的人**无权**时：Issue 正常创建，**边不建**并显式提示，不静默失败；
- `children` 子项继承父模板的新字段。

**Step 2: 运行确认失败**

Run:

```bash
cd models/tracker && rushx test
cd ../../server-plugins/traceability-resources && rushx test
```

Expected: FAIL。

**Step 3: 扩模板字段**

只在 `IssueTemplateData` 末尾追加；`TIssueTemplate` 的 `@Prop` 与之一一对应。

**Step 4: 接 `updateTemplate()`**

在既有 `updateTemplate()` 的解构里放行新字段；建边在 Issue **创建成功之后**发起，建边失败不回滚 Issue（提示重试即可）。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add plugins/tracker plugins/tracker-resources plugins/tracker-assets models/tracker server-plugins/traceability-resources
git commit -m "feat(tracker): carry agentra fields through issue templates"
```

## Phase 4：测试管理

### Task 13：扩展 Test Case 结构化步骤和版本

**Files:**
- Modify: `plugins/test-management/src/types.ts`
- Modify: `plugins/test-management/src/plugin.ts`
- Modify: `models/test-management/src/types.ts`
- Modify: `models/test-management/src/index.ts`
- Modify: `models/test-management/src/migration.ts`
- Create: `models/test-management/src/__tests__/caseVersion.test.ts`
- Create: `plugins/test-management-resources/src/components/test-case/TestSteps.svelte`
- Modify: `plugins/test-management-resources/src/components/test-case/EditTestCase.svelte`
- Modify: `plugins/test-management-assets/lang/en.json`
- Modify: `plugins/test-management-assets/lang/zh.json`
- Modify: `plugins/test-management-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）

**Step 1: 写版本快照失败测试**

创建 Case v1/Plan，修改步骤为 v2，断言旧 Plan/Run 仍解析 v1；migration 给旧 Case 默认版本 1 且可重复。

**Step 2: 运行确认失败**

Run: `cd models/test-management && rushx test`

Expected: FAIL。

**Step 3: 实现 TestStep 和版本策略（D6 已定，2026-08-26）**

TestStep 使用 AttachedDoc + Rank；Case 更新结构化内容时递增版本。

✅ **快照方案：独立不可变 `TestCaseSnapshot`**

- 按 **`(testCase, version)`** 去重：同一用例同一版本全库只有一份快照；
- **惰性创建**：只有被 Test Plan Item 或 Test Run **首次引用时**才生成，不给每次编辑都建快照；
- **服务端 middleware 拒绝一切修改**（update / remove 全拒），保证历史 Run 读到的内容永不漂移；
- Test Plan Item 保存的是**快照引用**，不是「版本号 + 按版本重建」。

🔴 **不使用 core 的 `VersionableClass`。** `VersioningMiddleware.findAll()`（`foundations/server/packages/middleware/src/versioning.ts`）**只判断 mixin 是否存在，不判断 `enabled` 标志**，并强制给查询追加 `isLatest = true` —— 一旦在 TestCase 上声明该 mixin，**存量用例会从所有列表查询中消失**。（indexer 侧确实检查了 `enabled === true`，但那救不了查询路径。）这是静默的数据可见性事故，不是「先声明再调」能补救的。

🔴 **步骤字段用内联富文本，不用 blob 引用。** `action` / `testData` / `expectedResult` 若各走一个 `MarkupBlobRef`，按 PRD 容量假设的 1 万用例计算会产生约 **24 万个 blob**，而平台**没有 blob 回收机制**（快照又不可变，永远不会被删）。三者一律**内联**。

**快照与附件**：快照只存附件的**元数据 + blob id**，不复制 blob；并且**禁止删除被任何快照引用的附件**（服务端拒绝，提示"该附件被 N 个测试快照引用"）。对应 QA-T022 / QA-T023。

**Step 4: 实现步骤编辑器**

支持添加、删除、排序、操作/数据/预期；Approved Case 修改必须进入评审状态。

> ✅ **审核状态不需要重新实现（既有能力）。** `plugins/test-management/src/types.ts` 的 `TestCaseStatus` 上游已是 `Draft, ReadyForReview, FixReviewComments, Approved, Rejected`，与 PRD §5.4 的审核状态**完全吻合**。本 Task **只复用**该枚举，不新增、不重命名、不平行定义审核状态；需要新增的只有「Approved Case 被修改时自动回落到评审状态」这条**状态迁移规则**及其 UI 提示。QA-T003 直接针对上游枚举验证。

**Step 5: 运行测试**

Run:

```bash
cd models/test-management && rushx test
cd ../../plugins/test-management-assets && rushx test
```

Expected: PASS。

**Step 6: Commit**

```bash
git add plugins/test-management models/test-management plugins/test-management-resources plugins/test-management-assets
git commit -m "feat(test): version structured test steps"
```

### Task 14：增加 Build、Environment 和 Test Run Context

**Files:**
- Modify: `plugins/test-management/src/types.ts`
- Modify: `plugins/test-management/src/plugin.ts`
- Modify: `models/test-management/src/types.ts`
- Modify: `models/test-management/src/index.ts`
- Modify: `models/test-management/src/migration.ts`
- Create: `models/test-management/src/__tests__/runContext.test.ts`
- Create: `models/test-management/src/__tests__/testRunStatus.test.ts`
- Modify: `plugins/test-management-resources/src/components/test-run/NewTestRunPanel.svelte`
- Modify: `plugins/test-management-resources/src/components/test-run/TestRunHeader.svelte`
- Modify: `plugins/test-management-resources/src/components/test-result/` 下的状态展示组件（新增 Skipped）
- Modify: `plugins/test-management-assets/lang/en.json`
- Modify: `plugins/test-management-assets/lang/zh.json`
- Modify: `plugins/test-management-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）

**Step 1: 写失败测试**

断言 Plan Item 固定 Case **快照引用**，Run 保存上下文，Result 历史不受 Environment 归档影响。

🔴 **TestRun 上下文用扁平字段，不用嵌套对象**（2026-08-26 拍板，条目 23）。Huly 的**筛选、排序、索引只作用于顶层属性**；把上下文塞进一个 `TestRunContext` 嵌套对象，「按 Build 筛 Run」「按 environment 排序」全部失效（QA-T015 直接挂）。以下字段一律**平铺**在 TestRun 上：

```text
testPlan / productVersion / build / environment / cycle
executedBy / startedOn / finishedOn / externalRunId
```

**`Build` 归属测试项目空间**（`space: Ref<TestProject>`），与 TestEnvironment 一致，不做全局对象。

另外必须断言 `TestRunStatus` 含 `Skipped`：`expect(TestRunStatus.Skipped).toBe(4)`，且已有 Result 的 `Untested/Blocked/Passed/Failed` 取值**不变**。

**Step 2: 扩展 `TestRunStatus` 枚举（PRD QA-007 缺口）**

🔴 上游 `plugins/test-management/src/types.ts` 的 `TestRunStatus` 目前**只有四个值**：

```ts
export enum TestRunStatus {
  Untested,
  Blocked,
  Passed,
  Failed
}
```

而 PRD QA-007 要求 **Passed / Failed / Blocked / Skipped / Untested 五种**。落地方式（2026-08-26 拍板，条目 24）：

- **末尾追加 `Skipped = 4`**，**不得**插入或重排既有成员——这是数值枚举，任何插入或重排都会静默改写库中已持久化的 `TestResult.status` 数值，把历史的 Passed 变成别的状态；
- 🔴 **不配 migration。** 末尾追加数值枚举**零数据迁移**（既有取值不变），此前计划要求的「幂等兼容 migration」**已撤销** —— 写一条什么都不做的 migration 只是噪音，还会占掉 `migrateOperations` 里的一个位置（并行开发的冲突热点）。

🔴 **真正的工作量在下面 6 个消费点，必须逐一改完：**

| # | 消费点 | 不改的后果 |
| --- | --- | --- |
| 1 | `TestRunStatus` 枚举声明本身 | — |
| 2 | 展示数组（`testRunStatuses` 之类的全量列表） | UI 状态下拉里没有 Skipped |
| 3 | 状态图标 / 配色映射 | Skipped 显示为默认图标或空白 |
| 4 | `plugins/test-management-assets/lang/{en,zh,ru}.json` | 界面出现 raw key |
| 5 | 🔴 **`getTestRunStats`（四个硬编码查询）** | **见下方警告** |
| 6 | 发布门禁（Task 18）的结果读取分支 | Skipped 落进 `default` 分支被当成通过 |

🔴 **第 5 项是静默数据错误，必须单独写测试。** `getTestRunStats` 是**四个硬编码查询**（分别数 Untested / Blocked / Passed / Failed），`total` 由这四个相加得出。新增的 `Skipped` **既不进 total、也不进任何桶**，后果是：**一个全部标记为 Skipped 的 Test Run 会算出 `total = 0`、进度 0%，且不报任何错**。改这一处时必须同时决定 `total` 是否包含 Skipped（**推荐包含**，否则进度条永远不满）。对应 QA-T021a。

**Step 3: 实现模型和 UI**

Environment 变量只允许非敏感展示值；Build 保存 commit/CI URL，不保存 CI token。

**Step 4: 运行测试**

Run:

```bash
cd models/test-management && rushx test
cd ../../plugins/test-management-assets && rushx test
```

Expected: PASS，包含 `Skipped` 枚举、`getTestRunStats` 全 Skipped 场景（`total ≠ 0`）与扁平上下文字段的筛选/排序用例。

**Step 5: Commit**

```bash
git add plugins/test-management models/test-management plugins/test-management-resources plugins/test-management-assets
git commit -m "feat(test): add skipped run status and capture build/environment context"
```

### Task 15：实现需求覆盖和失败转 Bug（**已扩充**）

> 🔴 **2026-08-26 扩充**：盘点发现 `verifies` **零创建路径**（模型建了但没有任何入口创建），`defect-of` **只覆盖 TestResult** 一端。本 Task 必须补齐。

**Files:**
- Create: `server-plugins/requirements-resources/src/coverage.ts`
- Create: `server-plugins/requirements-resources/src/__tests__/coverage.test.ts`
- Create: `server-plugins/traceability-resources/src/commands/linkVerifies.ts`
- Create: `server-plugins/traceability-resources/src/__tests__/linkVerifies.test.ts`
- Create: `plugins/traceability-resources/src/components/LinkVerifiesDialog.svelte`
- Create: `server-plugins/tracker-resources/src/createDefectFromTestResult.ts`
- Create: `server-plugins/tracker-resources/src/__tests__/createDefectFromTestResult.test.ts`
- Modify: `plugins/test-management-resources/src/components/test-result/TestResultFooter.svelte`
- Modify: `plugins/test-management-resources/src/components/test-case/EditTestCase.svelte`（`verifies` 入口 1 + `defect-of` 从 TestCase 建缺陷）
- Modify: `plugins/requirements-resources/src/components/RequirementDetails.svelte`（`verifies` 入口 2 + `defect-of` 从 Requirement 建缺陷）
- Create: `plugins/test-management-resources/src/components/test-case/BulkLinkVerifies.svelte`（`verifies` 入口 3：批量关联）

**Step 1: 写失败测试**

覆盖 `TestCase --verifies--> Requirement`、权限过滤、覆盖率缓存重建、Failed Result 创建唯一 Bug、Blocked 必须原因、附件/日志引用。

🔴 **新增必测项**：

- **`verifies` 三个创建入口**（TestCase 详情页、Requirement 详情页、批量关联）**调同一个 command**，重复关联幂等；
- **`defect-of` 扩到三端**：Bug → TestResult **/ TestCase / Requirement**（原计划只做 TestResult）；
- **需求改版后 `verifies` 不继承**（Technical Spec §3.2.1）：改版后覆盖率**归零**，Requirement 页面显示「新版本尚未确认测试覆盖」，逼 QA 重新关联。该断言与 Task 18a 的继承策略共同验证。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/requirements-resources && rushx test
cd ../../server-plugins/tracker-resources && rushx test
```

Expected: FAIL。

**Step 3: 实现 coverage 和 defect command**

Bug 内容包括 Case/Step、预期、实际、Build、Environment、执行人和链接；建立 `Bug --defect-of--> TestResult`。

**Step 4: 实现 UI**

失败结果按钮默认打开既有 Bug；Requirement 页面显示覆盖/失败/阻塞摘要。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add server-plugins/requirements-resources server-plugins/tracker-resources plugins/test-management-resources plugins/requirements-resources
git commit -m "feat(test): trace coverage and create defects"
```

### Task 16：实现自动化测试结果导入

**Files:**
- Create: `services/test-import/pod-test-import/package.json`
- Create: `services/test-import/pod-test-import/Dockerfile`
- Create: `services/test-import/pod-test-import/src/index.ts`
- Create: `services/test-import/pod-test-import/src/server.ts`
- Create: `services/test-import/pod-test-import/src/__tests__/import.test.ts`
- Create: `services/test-import/pod-test-import/src/json.ts`
- Create: `services/test-import/pod-test-import/src/junit.ts`
- Create: `services/test-import/pod-test-import/src/mapping.ts`
- Modify: `rush.json`
- Modify: `dev/docker-compose.yaml`
- Modify: `dev/docker-compose.min.yaml`

**Step 1: 写 API 合同测试**

覆盖 scope、idempotency key、已知 Case、未知 Case 待映射、JUnit/JSON、重复 pipeline id、超大附件和无效状态。

**Step 2: 运行确认失败**

Run: `cd services/test-import/pod-test-import && rushx test`

Expected: FAIL。

**Step 3: 实现最小 endpoint 和 mapping**

只接受 `test:result:write` token；未知 Case 不自动创建。

✅ **QA-012 整体留 V1，含 JUnit（2026-08-26 拍板，条目 8）。** JSON **与** JUnit XML 两个转换器**都在本 Task 交付**，JUnit converter 实现为独立纯函数便于单测。此前 PRD §6.5 / §9、Technical Spec §5、本 Task 四处口径不一（有的写 V1、有的写 V1.1），**现统一为 V1**。

🔴 **若本服务消费 Kafka**，handler 必须遵守执行规则里的**硬约束 1**（自行 try/catch，不得让一条毒消息卡死 partition）。

**Step 4: 运行测试**

Run: `cd services/test-import/pod-test-import && rushx test`

Expected: PASS。

**Step 5: Commit**

```bash
git add services/test-import rush.json dev
git commit -m "feat(test): import automated run results"
```

## Phase 5：代码交付和发布

### Task 17：连接 GitHub PR、CI 和 Build

> ⚠️ **路径更正：GitHub 模块不在 `plugins/` 下。** 原计划写的 `plugins/github/src/index.ts` 在本仓库**不存在**。GitHub 能力是 `services/github/` 下的一整个包族：
>
> ```text
> services/github/github                    # @hcengineering/github，插件契约与类型
> services/github/github-assets             # i18n 文案
> services/github/github-resources          # 客户端 UI 实现
> services/github/model-github              # 模型定义
> services/github/pod-github                # 同步服务（webhook / worker）
> services/github/server-github             # server plugin 契约
> services/github/server-github-model       # server plugin 模型注册
> services/github/server-github-resources   # server plugin 实现
> ```
>
> 因此 Task 17 的**修改面比原计划大**：新增 Build/Trace Link 关系需要同时改动契约包（`services/github/github`）、模型包（`services/github/model-github`）、同步服务（`services/github/pod-github`）与 server plugin 实现（`services/github/server-github-resources`），而不是原先设想的单个 `plugins/github` 包。新增 UI 文案必须落在 `services/github/github-assets/lang/{en,zh,ru}.json`。改动上游热点包时保持补丁最小（见 Technical Spec §12）。

**Files:**
- Modify: `services/github/pod-github/src/worker.ts`
- Create: `services/github/pod-github/src/__tests__/crmAlmSync.test.ts`
- Modify: `services/github/github/src/index.ts`
- Modify: `services/github/github/src/types.ts`
- Modify: `services/github/model-github/src/index.ts`
- Modify: `services/github/server-github/src/index.ts`
- Modify: `services/github/server-github-resources/src/index.ts`
- Modify: `services/github/github-assets/lang/en.json`
- Modify: `services/github/github-assets/lang/zh.json`
- Modify: `services/github/github-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Modify: `plugins/tracker-resources/src/components/issues/edit/EditIssue.svelte`
- Modify: `plugins/test-management-resources/src/components/test-run/TestRunHeader.svelte`

**Step 1: 写 webhook 顺序/重复测试**

覆盖 opened→merged、merged→迟到 opened、重复 delivery id、CI failure、GitHub 5xx 和 reconciliation。

**Step 2: 运行确认失败**

Run: `cd services/github/pod-github && rushx test`

Expected: FAIL，Build/Trace Link 未写入。

**Step 3: 实现最小 bridge**

PR/CI 事件创建或更新 Build，Issue/PR 关系继续复用上游；只新增 Test Run/Release 所需关系和状态事件。

**Step 4: 运行测试**

Run: `cd services/github/pod-github && rushx test`

Expected: PASS，乱序事件不导致状态回退。

**Step 5: Commit**

```bash
git add services/github plugins/tracker-resources plugins/test-management-resources
git commit -m "feat(github): connect CI builds to delivery"
```

### Task 17a：实现 `fixed-by`（PR closing reference 解析 + 手工兜底）

> 🆕 **新增 Task（2026-08-26）。🔴 这是 Phase 5 的阻断项。** `fixed-by` 是**零创建路径**的追溯边之一；它不落地，PRD §2.2 的「追溯完整率 100%」**无法验收**。

**Files:**
- Create: `services/github/pod-github/src/fixedByLinks.ts`
- Create: `services/github/pod-github/src/__tests__/fixedByLinks.test.ts`
- Create: `server-plugins/traceability-resources/src/commands/linkFixedBy.ts`
- Create: `server-plugins/traceability-resources/src/__tests__/linkFixedBy.test.ts`
- Create: `plugins/traceability-resources/src/components/LinkPullRequestDialog.svelte`
- Modify: `plugins/tracker-resources/src/components/issues/edit/EditIssue.svelte`（Bug 详情页的手工关联 PR 入口）
- Modify: `services/github/github-assets/lang/en.json`
- Modify: `services/github/github-assets/lang/zh.json`
- Modify: `services/github/github-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）

**Step 1: 写失败测试**

覆盖：

- **closing reference 解析**：`Fixes #123` / `Closes AGENTRA-45` / `Resolves ...` 等 GitHub 关键字，大小写与多条引用；解析出的 Bug 存在且有权限时建 `Bug --fixed-by--> PullRequest` 边；
- **幂等**：同一 PR 事件重复投递只建一条边；PR 描述被编辑后重新解析，**移除的引用把边置 `revoked`，不物理删**；
- **解析不到 / Bug 不存在 / 无权限**：**不建边、不报错、不阻断 PR 同步**，走手工兜底；
- **手工兜底**：Bug 详情页可直接关联/解除 PR，与自动解析走**同一个 command**。

**Step 2: 运行确认失败**

Run: `cd services/github/pod-github && rushx test`

Expected: FAIL。

**Step 3: 实现**

解析器实现为**独立纯函数**（不依赖 GitHub client），便于单测；建边走 Task 3a 的幂等 command。

🔴 遵守**硬约束 1**：webhook / Kafka handler 里的解析失败必须自行 try/catch，不得让一条畸形 PR 描述卡住整个 partition。

**Step 4: 运行测试并提交**

Run: `cd services/github/pod-github && rushx test`

```bash
git add services/github server-plugins/traceability-resources plugins/traceability-resources plugins/tracker-resources
git commit -m "feat(traceability): link defects to fixing pull requests"
```

### Task 18：实现 Release Readiness 和发布 Command

**Files:**
- Create: `server-plugins/products/package.json`
- Create: `server-plugins/products/src/index.ts`
- Create: `server-plugins/products-resources/package.json`
- Create: `server-plugins/products-resources/src/index.ts`
- Modify: `server/server-pipeline/src/serverPlugins.ts`（加 `addLocation(serverProductsId, () => import('@hcengineering/server-products-resources'))`）
- Modify: `server/server-pipeline/package.json`
- Create: `server-plugins/products-resources/src/releaseReadiness.ts`
- Create: `server-plugins/products-resources/src/releaseProductVersion.ts`
- Create: `server-plugins/products-resources/src/deliveredInLinks.ts`（门禁通过后批量建 `delivered-in` 边）
- Create: `server-plugins/products-resources/src/__tests__/releaseGate.test.ts`
- Create: `server-plugins/products-resources/src/__tests__/deliveredIn.test.ts`
- Create: `server-plugins/products-resources/src/__tests__/readinessPermissions.test.ts`
- Modify: `plugins/products-resources/src/components/product-version/CreateProductVersion.svelte`（🔴 第 106-111 行：建子版本时把父版本置 Frozen/`Archived`，**不得置 `Released`**）
- Modify: `models/server-products/package.json`
- Modify: `models/server-products/src/index.ts`
- Modify: `plugins/products/src/types.ts`
- Modify: `models/products/src/index.ts`
- Modify: `models/products/src/migration.ts`
- Create: `plugins/products-resources/src/components/product-version/ReleaseReadiness.svelte`
- Modify: `plugins/products-resources/src/components/product-version/EditProductVersion.svelte`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `rush.json`

> 📌 **现状核实**：`models/server-products` **已存在**（rush.json 有 `@hcengineering/model-server-products` → `models/server-products`），但它目前只注册了一个 `SearchPresenter` mixin；`server-plugins/products` 与 `server-plugins/products-resources` **都不存在，需要新建**。按仓库惯例（对照 `server-plugins/tracker` + `server-plugins/tracker-resources`、`server-plugins/lead` + `server-plugins/lead-resources`），server plugin 必须拆成契约包与实现包两个包，两个都要加进 `rush.json`。
>
> 🔴 **注册分两处，别只做一处**：
> - `server/server-pipeline/src/serverPlugins.ts` 的 `registerServerPlugins()` 里加 `addLocation(serverProductsId, () => import('@hcengineering/server-products-resources'))`，并在 `server/server-pipeline/package.json` 加依赖——**这是唯一把资源 id 解析到实现代码的地方**，漏了它门禁 trigger 一次都不会执行，而模型构建与 typecheck 全都能过；
> - `models/server-products` 用 `builder.mixin(...)` 把 `serverProducts.function.*` / `.trigger.*` 挂到 Product/ProductVersion 上（它当前只注册了一个 `SearchPresenter`）。
>
> ✅ **D7 已关闭（2026-08-26）**：把 `models/all/src/index.ts` 中 products 的注册项改为 **`enabled: true`**（一行改动）。不走 migration 按工作区开启，也不留给管理员在 Settings 里开。QA 的 REL-* 用例**不再需要**「已启用 Products 模块」前置条件。
>
> ✅ **D5 已关闭（2026-08-26）**：`ProductVersionState` **直接扩上游 enum、末尾追加、显式写出全部数值**（不用 mixin）：
>
> ```ts
> export enum ProductVersionState {
>   Active = 0,            // 上游既有，数值绝不可变
>   Released = 1,          // 上游既有，数值绝不可变
>   Planning = 2,          // 本项目追加
>   ReleaseCandidate = 3,  // 本项目追加
>   Archived = 4           // 本项目追加
> }
> ```
>
> 数字枚举末尾追加 → **零数据迁移**（既有取值不变）。🔴 **绝不可重排或删除既有值**；**显式写出每个数值**，不要依赖隐式递增（后来者在中间插一个成员就会全盘错位，而 diff 看上去人畜无害）。状态迁移合法性由状态机判定，**不得用枚举数值大小判断**。
>
> 🔴 **必须同时修上游 `CreateProductVersion.svelte:106-111`。** 该处在创建**子版本**时把父版本状态置为 `Released` —— 任何人都能通过「建一个子版本」**绕过发布门禁直接发版**，REL-003 形同虚设。改为置 Frozen/`Archived`，发版只能走 `ReleaseProductVersion` command 这一条路。对应 **QA `REL-T015`**（2026-08-26 更正：此处原写「QA-T015」是 ID 引用错误 —— `QA-T015` 是「同一用例在多环境/Build 下执行并按环境筛选」，与本条无关；QA §5.5 的 `REL-T015` 才是「子版本不得把父版本置 `Released`」那一条）。

**Step 1: 写门禁失败测试**

覆盖失败测试、Blocked、**`Skipped`（必须显式当作「未通过」，不能落进 `default` 分支）**、P0/P1 Bug、未合并 PR、失败 CI、缺审批、合规豁免、重复发布和状态回写。

🔴 **新增必测项 1：门禁结果按调用者权限二次过滤**（条目 20）。判定与回显是两件事：

- **判定用全局视图** —— 门禁是否通过必须基于**全部**阻断项计算；对某些项目无权的发布负责人**不得漏判**；
- **回显按调用者权限过滤** —— 无权查看的阻断项只显示一行「未通过：存在受限范围内的阻断项」，**不含数量、标题、严重度、负责人**。泄露数量本身就是跨空间侧信道（能数出受限项目里有几个 P0 Bug）。

测试必须以「有权」「无权」两种角色各跑一遍（QA REL-T014）。

🔴 **新增必测项 2：子版本不得把父版本置 `Released`**（QA REL-T015）。

🔴 **新增必测项 3：`delivered-in` 批量建边**（见 Step 4a）。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/products-resources && rushx test
cd ../../models/products && rushx test
```

Expected: FAIL。

**Step 3: 实现兼容状态和 Readiness 查询**

保留上游 Active/Released 兼容映射；Readiness 每次发布前重新计算，不信任 UI 缓存。

**Step 4: 实现发布 Command**

通过门禁后更新 ProductVersion，并通过 Trace Link 将 Requirement/Lead/Account 写入 Activity；豁免包含人、原因、时间和审批。走 Task 3a 的幂等 command（重放同一 idempotencyKey 返回同一发布结果）。

**Step 4a: 实现 `delivered-in` 批量建边（新增，2026-08-26）**

> 🔴 `delivered-in` 此前是**零创建路径**的追溯边之一。

- **时机**：门禁**通过之后**、发布事务收尾时批量建边，范围内每个 Requirement / Work Item / Bug 各一条 `--delivered-in--> ProductVersion`；
- **语义：发布时点快照。** 边指向**发布那一刻**的具体版本 `_id`；需求后续改版**不继承**这条边（Technical Spec §3.2.1）；
- **幂等**：重放同一发布 command 不重复建边；
- **门禁未通过时一条边都不建。**

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add server-plugins/products server-plugins/products-resources models/server-products plugins/products models/products plugins/products-resources models/all rush.json
git commit -m "feat(release): enforce traceable release gates"
```

### Task 18a：实现 TraceLink 的版本继承策略

> 🆕 **新增 Task（2026-08-26，条目 26–29）。** 需求改版时，追溯边按固定规则继承 / 不继承。这条不落地，「追溯完整率」既算不准也说不清。

**Files:**
- Create: `server-plugins/traceability-resources/src/versionInheritance.ts`
- Create: `server-plugins/traceability-resources/src/__tests__/versionInheritance.test.ts`
- Modify: `server-plugins/requirements-resources/src/coverage.ts`（覆盖率按**当前版本口径**统计）
- Modify: `plugins/requirements-resources/src/components/RequirementDetails.svelte`（改版后提示「新版本尚未确认测试覆盖」）

**Step 1: 写失败测试**

追溯边记录的是**具体版本的审计事实**，不是「当前逻辑关系」：边存具体版本的 `_id`，另冗余存两端的 `sourceBaseId` / `targetBaseId` 供查询期归一。

需求产生新版本时：

| kind | 断言 |
| --- | --- |
| `implements` | ✅ **继承**到新版本 |
| `converted-to` | ✅ **继承** |
| `defect-of` | ✅ **继承** |
| `fixed-by` | ✅ **继承** |
| `verifies` | ❌ **不继承** —— 新版本覆盖率**归零**，逼 QA 重新确认 |
| `delivered-in` | ❌ **不继承** —— 发布是**时点快照** |

另需断言：

- **「追溯完整率 100%」按当前版本口径**：边必须指向该需求 `isLatest` 的那一版；指向历史版本的边计入审计历史，**不计入完整率分子**；
- 历史版本上的边**不被改写、不被删除**（审计事实不可变）。

**Step 2: 运行确认失败**

Run: `cd server-plugins/traceability-resources && rushx test`

Expected: FAIL。

**Step 3: 实现继承 trigger**

Requirement 产生新版本时触发；继承是**新建边指向新版本**，不是改写旧边。

**Step 4: 运行测试并提交**

Run: `cd server-plugins/traceability-resources && rushx test`

```bash
git add server-plugins/traceability-resources server-plugins/requirements-resources plugins/requirements-resources
git commit -m "feat(traceability): inherit trace links across requirement versions"
```

### Task 18b：实现 Release Notes 自动生成（REL-005）

> 🆕 **新增 Task（2026-08-26）。** 盘点 PRD §9 反向缺口时发现：`REL-005` 此前标 `Deferred`（QA §4.3 的维持 Deferred 清单里），但 **PRD §7.5 的 Release 页面验收明确要求「必须显示……豁免和 Release Notes」** —— 与 `REL-006`、`PM-009` **被 §7 核心页面验收隐式拉入 V1** 是同一模式。故补 Task。
>
> ✅ **归属已拍板（2026-08-26）**：按 QA §4.3 的判定规则（「有 Task 就 V1」），`REL-005` 已从 `Deferred` 拉回 `V1` 并写入 PRD §9 冻结表；QA §4.3 的 `Deferred` 清单同步剔除，不擅自改冻结表。
>
> **工作量量级：M（2–3 人日）**。**不新建包** —— Release Notes 落在 Task 18 已经建起来的 `products` / `server-products` 包族里，因此**不触发** Technical Spec §3.0 的 11 处注册清单。
>
> **依赖**：**Task 18** 必须先完成（Release Notes 的数据来源就是 Task 18 Step 4a 批量建出的 `delivered-in` 边）；**Task 15**（`defect-of`，Bug 分类）、**Task 17a**（`fixed-by`）提供分类所需的边。

**Files:**
- Create: `server-plugins/products-resources/src/releaseNotes.ts`（按 `delivered-in` 边聚合并分类）
- Create: `server-plugins/products-resources/src/__tests__/releaseNotes.test.ts`
- Modify: `models/server-products/src/index.ts`（`builder.mixin(...)` 把 `serverProducts.function.GenerateReleaseNotes` 挂到 ProductVersion 上）
- Modify: `plugins/products/src/types.ts`（`ProductVersion` **末尾追加**可空 `releaseNotes?: Markup` 与 `releaseNotesGeneratedOn?: Timestamp`）
- Modify: `models/products/src/index.ts`（对应 `@Prop` 声明）
- Create: `plugins/products-resources/src/components/product-version/ReleaseNotesEditor.svelte`
- Modify: `plugins/products-resources/src/components/product-version/EditProductVersion.svelte`（挂载编辑器，与 Task 18 的 `ReleaseReadiness.svelte` 并列）
- Modify: `plugins/products-assets/lang/en.json`
- Modify: `plugins/products-assets/lang/zh.json`
- Modify: `plugins/products-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败；`products-assets/lang/` 下已有 14 种语言，**只需补齐新增 key**）

**Step 1: 写失败测试**

- **来源唯一**：条目范围**必须与发布门禁认定的范围逐字一致**，不另跑一套查询——两套口径必然对不上。
  🔴 **本条已于 2026-08-27 更正。** 原文写的是「只来自该 ProductVersion 的 `delivered-in` 边」，但 Requirement 的 `delivered-in` 边**已被弃用**：`plugins/requirements/src/types.ts:120-124` 记录，为了让 `ViewOptionsModel.groupBy` 能按版本分组（REQ-006），`targetVersion` 改成普通 `TypeRef` **属性**，双写的那条边已删除、属性是唯一记录。而 `releaseGate.ts:246` 的门禁读的正是 `targetVersion`。
  **照原文只读边，会让「需求」分类恒为空，而门禁仍在为这些需求阻断发布** —— 恰是本条警告的失配，只是从反方向发生。
  实际口径（与门禁完全相同的两条读法）：**需求走 `targetVersion` 属性，Issue 走 `delivered-in` 边**；
- **三分类**：Requirement → 「需求」、非 Bug 的 Work Item → 「改进」、Bug（有 `defect-of` 或类型为 Bug）→ 「缺陷修复」；无法归类的条目进「其他」并**显式列出**，不得静默丢弃；
- **可编辑且不被覆盖**：人工编辑后重新生成，**必须提示并要求确认**才覆盖；已 `Released` 的版本其 Release Notes **只读**（发布后正文即审计事实）；
- 🔴 **权限二次过滤，口径与 REL-T014 完全一致**：生成用全局视图（不得漏条目），**回显按调用者权限过滤**；无权条目只折叠成一行「另有受限范围内的条目」，**不含数量、标题、严重度、负责人**——泄露数量本身就是跨空间侧信道；
- **时点快照**：`delivered-in` 不随需求改版继承（Task 18a），故 Release Notes 反映的是**发布那一刻**的范围，事后改需求不改写已发布版本的正文；
- **幂等**：同一版本重复生成产生相同内容，不产生重复条目。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/products-resources && rushx test
cd ../../models/products && rushx test
```

Expected: FAIL。

**Step 3: 实现聚合与分类**

`GenerateReleaseNotes` 是纯读聚合 + 一次写回，**不建任何新的追溯边**（建边是 Task 18 Step 4a 的职责，两处都建必然冲突）。

**Step 4: 实现编辑器**

富文本编辑；生成按钮在 ProductVersion 详情页；已 `Released` 状态下按钮禁用并说明原因。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add server-plugins/products-resources models/server-products plugins/products models/products plugins/products-resources plugins/products-assets
git commit -m "feat(release): generate editable release notes"
```

## Phase 6：横向体验、权限和验收

### Task 19：接入 Search、Inbox、Activity 和 Audit

**Files:**
- Modify: `models/crm-lite/src/index.ts`
- Modify: `models/requirements/src/index.ts`
- Modify: `models/traceability/src/index.ts`
- Modify: `models/cycle/src/index.ts`
- Create: `server-plugins/traceability/src/reconciliation.ts`
- Create: `server-plugins/traceability/src/__tests__/reconciliation.test.ts`

**Step 1: 写失败测试**

验证新对象全文索引、通知条件、Activity 前后状态、受限关系搜索、缓存漂移对账。

**Step 2: 实现 mixin 和 reconciliation**

关系预览始终二次权限检查；失败同步进入 Inbox；对账只修复缓存/缺失索引，不猜测业务关系。

**Step 3: 运行所有新模型/服务聚焦测试**

Run: 在 `models/{crm-lite,requirements,traceability,cycle}` 与 `server-plugins/traceability` 分别执行 `rushx test`。

Expected: PASS。

**Step 4: Commit**

```bash
git add models/crm-lite models/requirements models/traceability models/cycle server-plugins/traceability
git commit -m "feat(platform): index notify and audit CRM ALM objects"
```

### Task 19a：实现归档与恢复（SYS-005）

> 🆕 **新增 Task（2026-08-26）。** 盘点 PRD §9 反向缺口时发现：`SYS-005` 此前标 `Deferred`（QA §4.3 的维持 Deferred 清单里），但**有两条 P0 / V1 用例在验它** —— `SYS-T004`（管理员恢复归档对象，对象及关系恢复且不生成重复对象）与 `CRM-T013`（有引用的 Lead 尝试物理删除，应被阻止或改为归档）。**P0 用例在验、却没有 Task 实现**，是本轮盘点里最硬的一处矛盾。
>
> ✅ **归属已拍板（2026-08-26）**：按 QA §4.3 的判定规则，`SYS-005` 已从 `Deferred` 拉回 `V1` 并写入 PRD §9 冻结表；QA §4.3 的 `Deferred` 清单同步剔除。
>
> 📌 **现状核实（已查证，决定了本 Task 的形状）**：
>
> - **二次确认现成**：`plugins/view-resources/src/actionImpl.ts:175-205` 的 `Delete` 已经走 `contact.component.DeleteConfirmationPopup`，并支持 `confirmation` 文案覆盖与 `skipCheck`。**物理删除的二次确认不用从零做**，只需保证 Agentra 各类都落在这条 action 上、且不传 `skipCheck: true`。
> - **归档 action 现成但目标错**：`view.action.Archive` / `view.action.UnArchive`（`models/view/src/index.ts:849-884`）已经是 `input: 'any'`、已带 `visibilityTester`（`Archive` 还带 `override: [view.action.Delete]` —— ⚠️ **`UnArchive` 没有这个 `override`**，别照抄时凭印象补上），**但 `target` 写死是 `core.class.Space`，`query` 判据是 `Space.archived`，`actionImpl` 的参数类型也是 `Space | Space[]`**。普通业务文档（Lead / Requirement / Work Item / Test Case）**不在其覆盖范围内**。
>
> 所以本 Task = **给业务文档补一个可归档标记 + 复用上游那两个 action 的形状 + 阻止有引用对象的物理删除**。
>
> **工作量量级：M（3–4 人日）**，其中一半在「哪些引用算阻断」的边界与迁移上。
>
> **落地位置：`agentra-core` 包族**（`plugins/agentra-core` / `-resources` / `-assets`、`models/agentra-core`、`server-plugins/agentra-core` / `-resources`、`models/server-agentra-core`）——归档/恢复是**平台级横切能力**，不属于任何单个业务模块。**这些包已存在**（骨架已建），因此**不新增包**。
>
> 🔴 **但仍必须逐项核对 Technical Spec §3.0 的 11 处注册点**（详见 `docs/engineering/agentra-module-checklist.md`），因为本 Task 会给 `agentra-core` **新增 server trigger 与新 UI 文案**，任何一处没跟上就是「编译通过、运行时静默少功能」：① `rush.json`；② `models/all/package.json`；③ `models/all/src/index.ts`；④ `models/all/src/migration.ts`；⑤ `dev/prod/package.json`；⑥ `dev/prod/src/platform.ts`（id 导入 / assets 副作用导入 / `addStringsLoader` / `addLocation` **四处**）；⑦ `server/server-pipeline/src/serverPlugins.ts` + 其 `package.json`；⑧ `desktop/src/ui/platform.ts`（+ `desktop/package.json`）；⑨ `server/server-pipeline/src/internationalization.ts`（服务端只装 en，**静态** import）；⑩ `dev/tool/src/__start.ts`；⑪ `services/github/pod-github/src/loaders.ts`（与 GitHub 集成路径无关可不加，**但要在 PR 里显式写明「已评估、不需要」**，不能默认漏掉）。
>
> **依赖**：**Task 2 / Task 3**（TraceLink 与权限查询——「有引用」的判据要读 TraceLink）、**Task 6**（Lead 类存在，`CRM-T013` 才验得了）、**Task 19**（Activity / Audit 已接入，归档与恢复必须留痕）。

**Files:**
- Modify: `plugins/agentra-core/src/index.ts`（新增 `mixin.Archivable`：`archived: boolean` + `archivedOn?: Timestamp` + `archivedBy?: PersonId`；并声明 `action.Archive` / `action.Restore`、`function.CanArchive` / `CanRestore` 的资源 id）
- Modify: `models/agentra-core/src/index.ts`（`TArchivable` 声明；**照抄 `models/view/src/index.ts:849-884` 的 action 形状**注册 `Archive` / `Restore`：`input: 'any'` + `query: { archived: false }` / `{ archived: true }`；`override: [view.action.Delete]` **只加在 `Archive` 上**，与上游一致）；并把 mixin 挂到 Lead / Requirement / Issue / TestCase 四个类上）
- Modify: `models/agentra-core/src/migration.ts`（存量文档回填 `archived: false`；🔴 幂等，用 `tryMigrate` + 只更新缺字段的文档）
- Create: `plugins/agentra-core-resources/src/components/ArchiveConfirm.svelte`
- Create: `plugins/agentra-core-resources/src/components/RestoreConfirm.svelte`
- Create: `plugins/agentra-core-resources/src/components/ArchivedFilter.svelte`（列表默认过滤掉已归档，提供「显示已归档」开关）
- Modify: `plugins/agentra-core-resources/src/index.ts`（导出上述组件与 `CanArchive` / `CanRestore`）
- Create: `server-plugins/agentra-core-resources/src/archive.ts`（归档 / 恢复 command，走 Task 3a 的幂等 command）
- Create: `server-plugins/agentra-core-resources/src/deleteGuard.ts`（物理删除前置检查：有 TraceLink 引用则阻断并建议归档）
- Create: `server-plugins/agentra-core-resources/src/__tests__/archive.test.ts`
- Create: `server-plugins/agentra-core-resources/src/__tests__/deleteGuard.test.ts`
- Modify: `server-plugins/agentra-core/src/index.ts`（声明 `trigger.OnBeforeDelete` / `function.Archive` / `function.Restore` 资源 id）
- Modify: `models/server-agentra-core/src/index.ts`（`builder.mixin(...)` 把 trigger 挂到四个类上）
- Modify: `plugins/agentra-core-assets/lang/en.json`
- Modify: `plugins/agentra-core-assets/lang/zh.json`
- Modify: `plugins/agentra-core-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）
- Modify: `plugins/agentra-core-assets/src/__tests__/lang.test.ts`（zh key 对齐断言）
- Modify: `server/server-pipeline/src/internationalization.ts`（若 `agentra-core` 尚未登记，补静态 en 装载）
- Modify: `dev/tool/src/__start.ts`（若 `serverAgentraCoreId` 尚未 `addLocation`，补上）

**Step 1: 写失败测试**

归档 / 恢复（`archive.test.ts`）：

- **`SYS-T004`**：管理员恢复已归档对象 → 对象本身与**其 TraceLink 关系一并恢复可见**，且**不生成重复对象**（🔴 命令必须用**确定性 `_id`**，不得 `generateId()` 后「先 find 再 create」——并发下两个调用会双双查空、双双插入，串行测试还测不出来）；
- 归档**不物理删除任何 TraceLink 边**（与 Task 12a 解除关联时置 `revoked` 的口径一致：追溯是审计事实）；
- 归档 / 恢复各写一条 Activity + Audit，含操作人、时间、原因；
- **权限**：只有管理员可恢复；普通用户对已归档对象既看不到也恢复不了；无权用户的归档尝试被拒且**不泄露对象是否存在**；
- **幂等**：重放同一 `idempotencyKey` 不产生第二条 Activity。

物理删除守卫（`deleteGuard.test.ts`）：

- **`CRM-T013`**：Lead 已关联 Requirement（存在 `converted-to` 边）→ 物理删除**被阻断**，提示改为归档，**关系仍可追溯**；
- 无任何引用的对象可以物理删除，但**必须**经过 `DeleteConfirmationPopup` 二次确认（断言 action 未传 `skipCheck: true`）；
- 守卫是**服务端** trigger，不是只在 UI 上拦——绕过 UI 直接发 `TxRemoveDoc` 同样被拒。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/agentra-core-resources && rushx test
cd ../../models/agentra-core && rushx test
cd ../../plugins/agentra-core-assets && rushx test
```

Expected: FAIL。

**Step 3: 实现 mixin、action 与 migration**

`Archivable` 只加三个字段，**不新建平行文档**；migration 幂等回填。

**Step 4: 实现 command 与删除守卫**

归档 / 恢复走 Task 3a 的幂等 command；删除守卫在 server 侧 `OnBeforeDelete` 判定，判据是「是否存在 `state !== 'revoked'` 的 TraceLink 边」。

**Step 5: 逐项核对 11 处注册点并运行测试提交**

> 🔴 **本步不可省略。** 按上面的 ① – ⑪ 逐项 `grep` 核对，把核对结果写进 PR 描述。`dev/prod/src/platform.ts` 与 `desktop/src/ui/platform.ts` **成对**修改；`serverPlugins.ts` 与 `dev/tool/src/__start.ts` **成对**修改。

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add plugins/agentra-core plugins/agentra-core-resources plugins/agentra-core-assets models/agentra-core server-plugins/agentra-core server-plugins/agentra-core-resources models/server-agentra-core server/server-pipeline dev/tool
git commit -m "feat(platform): archive and restore agentra objects"
```

### Task 20：实现 V1 基础 Saved View、Form 和仪表盘

**Files:**
- Create: `plugins/crm-lite-resources/src/components/LeadIntakeForm.svelte`
- Create: `plugins/requirements-resources/src/components/RequirementRoadmap.svelte`
- Create: `plugins/traceability-resources/package.json`
- Create: `plugins/traceability-resources/src/index.ts`
- Create: `plugins/traceability-resources/src/plugin.ts`
- Create: `plugins/traceability-resources/src/components/TraceTimeline.svelte`
- Create: `plugins/traceability-resources/src/components/DeliveryDashboard.svelte`
- Modify: `dev/prod/package.json`（新增 `@hcengineering/traceability-resources` 依赖）
- Modify: `dev/prod/src/platform.ts`（`addLocation(traceabilityId, async () => await import('@hcengineering/traceability-resources'))`）
- Modify: `desktop/package.json` + `desktop/src/ui/platform.ts`（桌面端同样的 `addLocation`）
- Create: `server-plugins/crm-lite/src/intake.ts`
- Create: `server-plugins/crm-lite/src/__tests__/intake.test.ts`

**Step 1: 写 Intake 安全测试**

覆盖字段白名单、限流、隐藏字段越权、重复提交、来源审计和恶意公式/富文本输入。

**Step 2: 实现预设视图**

只实现 PRD V1 所需 Grid/Kanban/Roadmap/Timeline/Dashboard；不提前实现通用低代码设计器。

**Step 3: 实现 Intake**

匿名写入仅创建待分流 Lead，不能设置 owner/权限/Converted 状态。

**Step 4: 运行测试并提交**

Run: `cd server-plugins/crm-lite && rushx test`

```bash
git add plugins/crm-lite-resources plugins/requirements-resources plugins/traceability-resources server-plugins/crm-lite dev/prod
git commit -m "feat(platform): add intake and delivery views"
```

### Task 20a：实现项目概览与风险页（PM-009）

> 🆕 **新增 Task（2026-08-26）。** 盘点 PRD §9 反向缺口时发现 `PM-009` 在 V1 承诺冻结清单里（且是被 **PRD §7.3 核心页面验收隐式拉入**的那一类），实施计划中却没有实现其核心交付物的 Task。本 Task 补齐。
>
> 交付物按 PRD §6.4 / §7.3：项目**概览**页展示**状态、风险、里程碑、工作量、阻塞、测试质量**六块。
>
> 🔴 **本 Task 是纯聚合展示，不新建任何数据。** 六块数据全部来自已有对象：状态/工作量/阻塞来自 Issue（`blockedBy` / `relations` 两个 `RelatedDocument[]` 数组 —— **注意 PM-003 的四类计划依赖已降级 V1.1，这里只有阻塞/关联数组**）、里程碑来自上游 Milestone、周期数据来自 Cycle（Task 10 / 11）、测试质量来自 QA-010 的覆盖率与通过率（Task 15）。**任何一块都不得自己再算一套口径。**
>
> **工作量量级：M（3–4 人日）**，几乎全在查询聚合与权限过滤上。**不新建包** —— 落在 `agentra-core-resources`，通过 `workbench.class.ApplicationNavModel`（`models/workbench/src/index.ts:57-59`，消费点 `plugins/workbench-resources/src/utils.ts:185` 按 `extends: currentApplication._id` 查询）挂进 tracker 应用，**不改上游 `models/tracker/src/index.ts` 的 `specials` 数组**（改它会在每次上游合并时冲突）。
>
> **依赖（🔴 三条都是硬依赖，缺一块该区就是空的）**：
> - **Task 11**（Cycle UI / 完成 / rollover）—— 提供燃尽、承诺/完成差异、滚动未完成项；
> - **Task 15**（需求覆盖和失败转 Bug）—— 提供 **QA-010** 的覆盖率 / 通过率 / 失败 / 阻塞数据，即「测试质量」区的**唯一**数据源；
> - **Task 12**（Requirement ↔ Work Item 接线）—— 风险区要按需求维度归集未覆盖 / 未交付项。
>
> 另：**Task 20** 先落地 `DeliveryDashboard.svelte` 等交付视图，本 Task 与之**共用同一套统计函数**，不各写一份。

**Files:**
- Create: `plugins/agentra-core-resources/src/components/project/ProjectOverview.svelte`（六块的容器）
- Create: `plugins/agentra-core-resources/src/components/project/RiskPanel.svelte`（风险区：逾期、阻塞、无负责人、未覆盖需求、门禁阻断项）
- Create: `plugins/agentra-core-resources/src/components/project/QualityPanel.svelte`（测试质量区，数据源 = Task 15 的覆盖率查询）
- Create: `plugins/agentra-core-resources/src/components/project/WorkloadPanel.svelte`（工作量：估时 / 剩余 / 已报告）
- Modify: `plugins/agentra-core-resources/src/index.ts`（导出上述组件）
- Modify: `plugins/agentra-core/src/index.ts`（声明 `component.ProjectOverview` 等资源 id）
- Modify: `models/agentra-core/src/index.ts`（`builder.createDoc(workbench.class.ApplicationNavModel, ...)`，`extends: tracker.app.Tracker`，`specials` 里加 `ProjectOverview`）
- Modify: `models/agentra-core/package.json`（新增 `@hcengineering/model-workbench`、`@hcengineering/model-tracker` 依赖）
- Create: `server-plugins/agentra-core-resources/src/projectRisk.ts`（风险聚合查询，权限过滤在服务端做）
- Create: `server-plugins/agentra-core-resources/src/__tests__/projectRisk.test.ts`
- Modify: `plugins/agentra-core-assets/lang/en.json`
- Modify: `plugins/agentra-core-assets/lang/zh.json`
- Modify: `plugins/agentra-core-assets/lang/ru.json`（🔴 `makeLocalesTest` 硬编码 `['en','ru']`，缺 `ru.json` 该包 lang 测试直接失败）

> 📌 本 Task 不新增包，`agentra-core` 的 11 处注册点在 **Task 19a Step 5** 已逐项核对过；本 Task 只需确认 `ApplicationNavModel` 这一条新增注册生效（表现为 tracker 导航里出现「概览」入口）。

**Step 1: 写失败测试**

- **六块齐全**：状态、风险、里程碑、工作量、阻塞、测试质量，缺任何一块用例失败（对齐 PRD §7.3 验收）；
- 🔴 **权限二次过滤，口径与 REL-T014 / Task 18b 一致**：统计**判定用全局视图**（不得漏算），**回显按调用者权限过滤**；无权范围只折叠成一行提示，**不含数量、标题、严重度、负责人**；
- **口径一致性**：测试质量区的数字与 Task 15 的覆盖率查询**逐项相等**（同一函数，不是近似）；燃尽 / 承诺完成差异与 Task 11 的 `CycleStats` 相等；
- **空项目**：无 Issue / 无 Cycle / 无 Test Run 时六块各自显示空态，**不报错、不显示 `NaN`**；
- **已归档对象不计入**（依赖 Task 19a 的 `Archivable` mixin；若 Task 19a 未完成则本条断言先跳过并在 PR 中标注）；
- **阻塞口径**：只统计 `Issue.blockedBy` / `Issue.relations` 两个数组（PM-002），**不得引用 `IssueRelation`** —— 那是上游为尚未落地的 Gantt 预留的死 schema，全仓 `addCollection(IssueRelation)` 零命中（PM-003 已降级 V1.1）；
- **性能**：基准数据集下概览页 p95 < 2 秒（PRD §8）；断言聚合查询次数有上限，不得按 Issue 逐条发查询。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/agentra-core-resources && rushx test
```

Expected: FAIL。

**Step 3: 实现风险聚合**

服务端一次聚合返回六块所需数据；权限过滤在服务端完成，**不把全量数据发到前端再过滤**（前端过滤 = 数据已经泄露到客户端）。

**Step 4: 实现六块 UI 与导航挂载**

`ApplicationNavModel` 挂进 tracker；概览为项目下第一个 special。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add plugins/agentra-core plugins/agentra-core-resources plugins/agentra-core-assets models/agentra-core server-plugins/agentra-core-resources
git commit -m "feat(planning): add project overview and risk page"
```

### Task 20b：实现受控自定义字段（FLEX-001）

> 🆕 **新增 Task（2026-08-26）。** 盘点 PRD §9 反向缺口时发现 `FLEX-001` 在 V1 承诺冻结清单里，实施计划中却没有实现其核心交付物的 Task。本 Task 补齐。
>
> 📌 **现状核实（已查证，决定了本 Task 的形状）**：**自定义字段本身上游完全现成，本 Task 要做的只有「受控」那一半。**
>
> - 自定义字段 = `core.class.Attribute`；设置页 `plugins/setting-resources/src/components/ClassAttributes.svelte`（第 77 行 `attrQuery.query(core.class.Attribute, { attributeOf: _class })`）负责列出，`ClassAttributesList.svelte:108` 与 `CreateAttribute.svelte:85` / `CreateAttributePopup.svelte:83` 直接 `client.createDoc(core.class.Attribute, core.space.Model, …)`；
> - **新属性会自动进列配置、进筛选、进详情栏**，且走 live query **免刷新**；
> - 门禁的挂载点也现成：`setting.mixin.Editable`（接口 `plugins/setting/src/index.ts:82`、id `:207`、模型 `models/setting/src/index.ts:102-105` 的 `TEditable extends TClass`，字段就一个 `value: boolean`）；`Attribute` 上还有现成的 `readonly?: boolean`（`foundations/core/packages/core/src/classes.ts:130`）与 `isCustom?: boolean`（`:226`）。
>
> 所以本 Task = **① 给四个类挂 `Editable` 门禁；② 保护核心状态字段不可删、不可改类型**（对应 QA 用例 **FLEX-T002**）。**不实现**通用 Lookup / 公式 / 自动化 —— 那是 `FLEX-003` / `FLEX-004`，已 `Deferred` 到 V1.1，**不得在本 Task 顺手扩张**。
>
> **工作量量级：S–M（1–2 人日）**。**不新建包**。
>
> **依赖**：**Task 6**（Lead 类）、**Task 8**（Requirement 类）、**Task 13**（Test Case 结构化步骤与版本 —— 受保护字段清单要覆盖它新增的核心字段）。Work Item 用上游 tracker 的 Issue，无额外依赖。

**Files:**
- Modify: `models/crm-lite/src/index.ts`（`builder.mixin(crmLite.class.Lead, core.class.Class, setting.mixin.Editable, { value: true })`）
- Modify: `models/requirements/src/index.ts`（同上，Requirement）
- Modify: `models/tracker/src/index.ts`（Issue —— ⚠️ **已查实：上游 `models/tracker/src/index.ts:529-531` 已经挂了 `setting.mixin.Editable`**，本 Task 对 Issue **无需重复添加**，只需在测试里断言它在；此行保留为核对项）
- Modify: `models/test-management/src/index.ts`（TestCase —— 🔴 **已查实：`models/test-management/src/index.ts:416-419` 目前只挂了 `ClassFilters`，没有 `Editable`，这是四个类里唯一真正要新加的一处**）

> 📌 **`Editable` 的逐类现状（已查实，避免重复劳动与漏挂）**：上游 `models/lead/src/index.ts:75-77`（上游 Lead）与 `models/tracker/src/index.ts:529-531`（Issue）**已挂**；`test-management` 的 TestCase **未挂**；Agentra 新建的 `crm-lite` Lead（Task 6）与 `requirements` Requirement（Task 8）是新类，**必须自己挂**。该 mixin 是**逐类显式开**的——上游 `models/setting/src/index.ts:619` 把 `core.class.Space` 那行注释掉了，就是这个语义：不开就不可编辑。
- Create: `server-plugins/agentra-core-resources/src/attributeGuard.ts`（🔴 **受控的核心**：拦 `core.class.Attribute` 的 `TxRemoveDoc` / `TxUpdateDoc`，保护清单内的字段不可删、不可改 `type`）
- Create: `server-plugins/agentra-core-resources/src/__tests__/attributeGuard.test.ts`
- Modify: `server-plugins/agentra-core/src/index.ts`（声明 `trigger.OnAttributeChange` 资源 id）
- Modify: `models/server-agentra-core/src/index.ts`（`builder.mixin(...)` 把 trigger 挂到 `core.class.Attribute` 上）
- Modify: `plugins/agentra-core-assets/lang/en.json`
- Modify: `plugins/agentra-core-assets/lang/zh.json`
- Modify: `plugins/agentra-core-assets/lang/ru.json`（🔴 缺 `ru.json` 该包 lang 测试直接失败）

**Step 1: 写失败测试**

- **可加**：管理员在设置页给 Lead / Requirement / Issue / TestCase 各加一个自定义字段，新字段**自动出现在列配置、筛选器与详情栏**（断言 live query 免刷新，不需要重登）；
- 🔴 **FLEX-T002 —— 核心状态字段受保护**：删除或修改核心状态字段的 `type` **被服务端拒绝**，返回可读原因；断言是**服务端 trigger** 拒绝，绕过 UI 直接发 tx 同样被拒；
- **受保护清单必须显式枚举并在测试里逐条断言**（至少：Lead 状态、Requirement 状态与版本、Issue 状态与优先级、TestCase 状态与版本、以及全部 TraceLink 字段）；新增受保护字段必须同步改这份清单，测试即清单；
- **权限**：只有管理员能增删自定义字段；普通用户在设置页看不到入口（`FLEX-006` 的管理员配置面本身仍是 `Deferred`，本条只验最小门禁）；
- 🔴 **呼应全项目硬约束 2**：自定义字段若是枚举型，**只允许末尾追加**；改动会让固化了枚举值的 Saved View（`FilteredView.filters` 是 JSON 字符串）**静默筛出 0 条**。用例须覆盖。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/agentra-core-resources && rushx test
```

Expected: FAIL。

**Step 3: 挂 `Editable` 门禁**

四个类各一行 `builder.mixin`，**不改 `setting-resources` 的任何 Svelte** —— 上游那套增删改 UI 直接可用，改它等于给上游合并制造冲突。

**Step 4: 实现属性守卫 trigger**

受保护清单集中在 `attributeGuard.ts` 一处导出，前端提示文案复用同一份清单，不各写一份。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add models/crm-lite models/requirements models/tracker models/test-management server-plugins/agentra-core server-plugins/agentra-core-resources models/server-agentra-core plugins/agentra-core-assets
git commit -m "feat(platform): add governed custom fields"
```

### Task 21：添加 Playwright 全链路与角色矩阵

**Files:**
- Create: `tests/sanity/tests/model/crm-alm/crm-page.ts`
- Create: `tests/sanity/tests/model/crm-alm/requirement-page.ts`
- Create: `tests/sanity/tests/model/crm-alm/test-page.ts`
- Create: `tests/sanity/tests/model/crm-alm/release-page.ts`
- Create: `tests/sanity/tests/crm-alm/lead-to-release.spec.ts`
- Create: `tests/sanity/tests/crm-alm/permissions.spec.ts`
- Create: `tests/sanity/tests/crm-alm/failure-recovery.spec.ts`

**Step 1: 写最小 smoke E2E**

覆盖 QA Plan 映射：AUTH-T001、CRM-T004、REQ-T003、PM-T005、**PM-T003a**（V1 的阻塞/关联数组，**不是** PM-T003 的四类依赖 —— 那条已 `Deferred` 到 V1.1）、QA-T011、DEV-T001、REL-T004。

**Step 2: 写角色矩阵 E2E**

覆盖 CRM-T010、PM-T011、QA-T019、REL-T008、SYS-T002、**REL-T014**（门禁结果按调用者权限二次过滤：有权 / 无权两种角色，判定一致、回显不同）。

**Step 3: 写失败恢复 E2E**

模拟 GitHub/Feishu 短暂失败、重复 command 和 DeadLetter 重放。

**Step 4: 用户授权后运行**

Run:

```bash
cd tests/sanity
rushx dev-uitest -g 'CRM ALM'
```

Expected: 所有 CRM ALM E2E PASS。若环境未启动，记录为“等待手动环境验证”，不得声称通过。

**Step 5: Commit**

```bash
git add tests/sanity/tests/model/crm-alm tests/sanity/tests/crm-alm
git commit -m "test(crm-alm): cover lead to release workflow"
```

### Task 22：安全、性能、迁移和运维验收

**Files:**
- Create: `tests/crm-alm/security/README.md`
- Create: `tests/crm-alm/performance/README.md`
- Create: `tests/crm-alm/operations/backup-restore.md`
- Create: `tests/crm-alm/operations/upstream-upgrade.md`
- Create: `docs/release/crm-alm-release-checklist.md`

**Step 1: 用 @security-review 执行认证/权限审查**

逐项验证 OAuth state、tenant、身份绑定、Webhook 签名、Trace Link 侧信道、表单注入、Secret 和日志。

**Step 2: 建立性能脚本入口和数据规模**

按 QA Plan 数据集测试 List/Details/Search/10k Result Run；记录 p50/p95/p99 和错误率。

**Step 3: 执行迁移幂等和对账测试**

升级中断后恢复，重复 migration，核对对象数、Trace Link 数、附件和搜索索引。

**Step 4: 手动备份恢复/上游升级演练**

按照仓库规则由用户运行环境命令；报告必须记录上游 commit、fork commit、镜像 digest 和 migration version。

**Step 5: Commit**

```bash
git add tests/crm-alm docs/release/crm-alm-release-checklist.md
git commit -m "test(ops): define CRM ALM release gates"
```

## Phase 7：自托管发布

### Task 23：在 huly-selfhost fork 增加部署覆盖层

**Files（在 `huly-selfhost` fork）:**
- Create: `compose.crm-alm.yaml`
- Create: `.env.example.crm-alm`
- Create: `docs/crm-alm.md`
- Create: `scripts/smoke-crm-alm.sh`
- Modify: `README.md`

**Step 1: 固定镜像**

使用 platform fork 的不可变 tag/digest，不使用 `latest`。

**Step 2: 添加非敏感配置模板**

`.env.example` 仅列变量名和说明；真实 Secret 不写磁盘模板。

**Step 3: 添加健康检查**

检查 front、account/authProviders、transactor、fulltext、MinIO、Redpanda 和 CockroachDB；不得打印 Secret。

**Step 4: 用户授权后手动验证**

```bash
docker compose -f compose.yaml -f compose.crm-alm.yaml config
./scripts/smoke-crm-alm.sh
```

Expected: Compose config 有效，健康检查通过，飞书 Provider 只在配置完整时出现。

**Step 5: Commit**

```bash
git add compose.crm-alm.yaml .env.example.crm-alm docs/crm-alm.md scripts/smoke-crm-alm.sh README.md
git commit -m "feat(deploy): add CRM ALM self-host overlay"
```

## 最终人工验证

根据根目录 `AGENTS.md`，以下 build/环境命令不由代理自动运行。用户批准后手动执行并将结果附在 Release Report：

```bash
rush update
rush build
rush validate
rush svelte-check
rush test
```

随后运行 Docker 和 E2E：

```bash
cd dev
rush docker:build
rush docker:up
cd ../tests/sanity
rushx dev-uitest -g 'CRM ALM'
```

验收必须逐项映射 [QA Test Plan](./2026-08-25-agentra-qa-test-plan.md)；任何未运行项标记为“未验证”，不得以代码审查代替运行结果。

## V1.1 / V1.2 后续计划入口

V1 验收后再分别编写两个独立实施计划：

- V1.1：通用自定义字段、Lookup/公式 DSL、通用 Form、自动化规则；**PM-003 四类计划依赖 + PM-005 Gantt**（`IssueRelation` 是上游为尚未落地的 Gantt 预留的死 schema，属从零实现）；**PM-008c 重复任务**（tracker 无 recurring issue 能力；calendar 的 recurrence 引擎与 Issue 模型不通用，不能直接复用）；**outbox / 死信队列 / 对账 job 三件套**；
- V1.2：仪表盘设计器、行级权限、项目组合、资源容量和更多 CI/测试平台；**Kubernetes 编排**（V1 非目标）。

⚠️ **JUnit 映射已提前到 V1**（Task 16），不在 V1.1 范围内。

不得在 V1 实现过程中顺手扩张这些范围。

## 🔴 V1 验收的已知阻断点

**PRD §2.2 的「追溯完整率 100%」在 `fixed-by` 与 `delivered-in` 落地前无法验收。**

这两类追溯边此前是**零创建路径**（模型建了但没有任何入口创建数据），对应：

- `fixed-by` → **Task 17a**（PR closing reference 解析 + 手工兜底）—— **Phase 5 阻断项**；
- `delivered-in` → **Task 18 Step 4a**（门禁通过后批量建边）。

在这两个 Task 完成之前，QA 报告中该指标必须标注「**无法验收**」，**不得填写任何百分比**。
