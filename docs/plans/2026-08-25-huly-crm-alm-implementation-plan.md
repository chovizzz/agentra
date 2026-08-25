# Huly CRM-ALM V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Huly fork 中交付飞书登录、轻量 CRM、版本化需求、项目周期、专业测试、GitHub 交付和产品发布的自托管闭环。

**Architecture:** 复用 Huly Contact、Card、Tracker、Products、Test Management 和 GitHub 模块；新增 CRM、Requirements、Traceability 与 Cycle 插件，并通过服务端幂等 Command 完成跨对象转换。认证在现有 `pods/authProviders` 中增加飞书 Provider，部署配置进入独立 `huly-selfhost` fork。

**Tech Stack:** TypeScript、Svelte 4、Huly Model/Plugin Framework、Rush、Jest、Playwright、Koa/Passport、CockroachDB、Redpanda、MinIO、Elasticsearch、Docker Compose。

---

## 执行规则

- 开始前阅读仓库根目录 `AGENTS.md`；不要自动运行全量 build。
- 每个任务使用 @test-driven-development；后端 Command 使用 @backend-patterns，Svelte 使用 @frontend-patterns，认证和权限任务使用 @security-review。
- 每个任务只提交列出的垂直切片；不要提前实现后续任务。
- 新包必须加入 `rush.json`；模型必须加入 `models/all` 的依赖、builder 和 migration 顺序。
- 每个新 UI 文案至少提供 `plugins/*-assets/lang/en.json` 和 `zh.json`，并通过语言 key 测试。
- 完成任务后运行该包的 `rushx test`；全量 `rush build`、`rush validate`、Docker 和 UI 套件由用户授权后手动运行。
- 每次提交前执行 `git diff --check`，确认没有 Secret、生成文件或无关上游变更。

## Phase 0：仓库和安全基线

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

**Step 2: 配置 upstream**

```bash
git remote rename origin upstream
git remote add origin <fork-url>
git fetch upstream develop
```

Expected: fetch/push 目标分离；不得把提交推到官方上游。

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
- Create: `models/traceability/package.json`
- Create: `models/traceability/src/index.ts`
- Create: `models/traceability/src/types.ts`
- Create: `models/traceability/src/migration.ts`
- Create: `models/traceability/src/__tests__/model.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `models/all/src/migration.ts`
- Modify: `rush.json`

**Step 1: 写失败的模型测试**

测试应断言 `TraceLink` 具有 source/sourceClass/target/targetClass/kind/createdBy，且 kind 仅允许 Spec 中的七种值。

```ts
expect(traceability.class.TraceLink).toBeDefined()
expect(allowedTraceLink('TestCase', 'verifies', 'Requirement')).toBe(true)
expect(allowedTraceLink('Lead', 'fixed-by', 'Requirement')).toBe(false)
```

**Step 2: 运行测试确认失败**

Run: `cd models/traceability && rushx test`

Expected: FAIL，因为 package/model 尚未注册。

**Step 3: 实现最小模型**

实现 `TraceLinkKind`、`TraceLink`、`DOMAIN_TRACEABILITY`、模型类和 class/kind 组合校验。方向严格遵循 Technical Spec；不创建反向副本。

**Step 4: 注册模型和 migration**

将新包加入 Rush 和 `models/all`；migration 只创建 schema/索引和 marker，重复执行不产生额外默认对象。

**Step 5: 运行聚焦测试**

Run: `cd models/traceability && rushx test`

Expected: PASS；第二次执行 migration 测试仍 PASS。

**Step 6: Commit**

```bash
git add plugins/traceability models/traceability models/all rush.json
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
- Create: `models/server-traceability/package.json`
- Create: `models/server-traceability/src/index.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `rush.json`

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
git add server-plugins/traceability models/server-traceability models/all rush.json
git commit -m "feat(traceability): enforce idempotent authorized links"
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
- Modify: `plugins/login-assets/src/__tests__/lang.test.ts`

**Step 1: 写 OAuth 合同测试**

使用本地 mock server 覆盖授权 URL、state、code 换 token、用户资料、允许租户、非法租户、重放 code、上游 5xx 和日志脱敏。

**Step 2: 运行确认失败**

Run: `cd pods/authProviders && rushx test`

Expected: FAIL，`registerFeishu` 不存在。

**Step 3: 实现 Provider transport**

参考 `github.ts` 和 `openid.ts`，新增 `/auth/feishu` 与 `/auth/feishu/callback`。请求 scope 保持最小；使用现有 `encodeState`、`safeParseAuthState` 和 `handleProviderAuth`。

**Step 4: 增加正式身份类型**

在 `SocialIdType` 增加 FEISHU，identity value 使用可逆转义的 `tenant_key:open_id` 组合；不得复用 OIDC/GITHUB 类型。

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
- Modify: `pods/authProviders/src/feishu.ts`
- Modify: `server/account/src/operations.ts`
- Create: `server/account/src/__tests__/feishuBinding.test.ts`

**Step 1: 写失败测试**

覆盖首次开户、已有绑定、同邮箱未绑定不静默合并、自动开户关闭、union_id 迁移、离职禁用和本地管理员兜底。

**Step 2: 运行确认失败**

Run: `cd server/account && rushx test`

Expected: FAIL，缺少飞书绑定策略。

**Step 3: 实现绑定服务**

分离“认证成功”和“允许加入工作区”两个判断。绑定现有账号要求已登录确认或管理员审批；同步失败不撤销有效 session。

**Step 4: 实现可选资料同步**

仅在 `FEISHU_SYNC_PROFILE=true` 时更新姓名、头像、部门和在职状态；写审计事件，禁止覆盖 Huly 权限角色。

**Step 5: 运行测试与安全检查**

Run:

```bash
cd server/account && rushx test
cd ../../pods/authProviders && rushx test
```

Expected: PASS；测试日志断言不包含 code/token/secret。

**Step 6: Commit**

```bash
git add pods/authProviders server/account
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
- Create: `models/crm-lite/package.json`
- Create: `models/crm-lite/src/index.ts`
- Create: `models/crm-lite/src/types.ts`
- Create: `models/crm-lite/src/plugin.ts`
- Create: `models/crm-lite/src/migration.ts`
- Create: `models/crm-lite/src/__tests__/migration.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `models/all/src/migration.ts`
- Modify: `rush.json`

**Step 1: 写模型和 migration 失败测试**

断言 Lead 是 Card 类型，字段包含 account/contact/source/owner/status/priority/nextActionAt；默认状态和来源只创建一次。

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
git add plugins/crm-lite plugins/crm-lite-assets models/crm-lite models/all rush.json
git commit -m "feat(crm): add card-based lead model"
```

### Task 7：实现 CRM List、Kanban 和详情页

**Files:**
- Create: `plugins/crm-lite-resources/package.json`
- Create: `plugins/crm-lite-resources/src/index.ts`
- Create: `plugins/crm-lite-resources/src/plugin.ts`
- Create: `plugins/crm-lite-resources/src/components/LeadList.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadKanban.svelte`
- Create: `plugins/crm-lite-resources/src/components/EditLead.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadDetails.svelte`
- Create: `plugins/crm-lite-resources/src/components/LeadActivity.svelte`
- Create: `plugins/crm-lite-resources/src/__tests__/leadValidation.test.ts`
- Modify: `plugins/crm-lite/package.json`
- Modify: `rush.json`

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
git add plugins/crm-lite-resources plugins/crm-lite rush.json
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
- Modify: `models/all/src/index.ts`
- Modify: `models/all/src/migration.ts`
- Modify: `rush.json`

**Step 1: 写失败测试**

断言 Requirement 为 Versionable Card，包含状态、priority、owner、product、targetVersion、acceptanceCriteria；状态机拒绝未批准直接进入 In Delivery。

**Step 2: 运行确认失败**

Run: `cd models/requirements && rushx test`

Expected: FAIL。

**Step 3: 实现模型和状态机**

建立 Draft、Reviewing、Approved、InDelivery、Validating、Released、Rejected、Cancelled；摘要计数明确为可重建缓存。

**Step 4: 实现 Requirement 页面**

显示版本化正文、验收标准、来源 Lead、Work Item、Test Coverage、Bug、PR 和 Product Version。

**Step 5: 运行聚焦测试**

Run:

```bash
cd models/requirements && rushx test
cd ../../plugins/requirements-assets && rushx test
```

Expected: PASS。

**Step 6: Commit**

```bash
git add plugins/requirements plugins/requirements-assets plugins/requirements-resources models/requirements models/all rush.json
git commit -m "feat(requirements): add versioned product requirements"
```

### Task 9：实现 Lead → Requirement 幂等转换

**Files:**
- Create: `server-plugins/crm-lite/package.json`
- Create: `server-plugins/crm-lite/src/index.ts`
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

输入 lead/product/project/owner/idempotencyKey；在单个业务事务中创建 Requirement、Link、Lead 状态和 Activity，并通过 outbox 发事件。

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
- Create: `models/cycle/package.json`
- Create: `models/cycle/src/index.ts`
- Create: `models/cycle/src/types.ts`
- Create: `models/cycle/src/migration.ts`
- Create: `models/cycle/src/__tests__/cycle.test.ts`
- Create: `models/cycle/src/__tests__/migration.test.ts`
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
- Modify: `models/all/src/migration.ts`
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
git add plugins/cycle plugins/cycle-assets models/cycle models/all rush.json
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
- Modify: `models/all/package.json`
- Modify: `models/all/src/index.ts`
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
git add plugins/cycle-resources server-plugins/cycle models/server-cycle models/all rush.json
git commit -m "feat(planning): complete and report project cycles"
```

### Task 12：连接 Requirement、Work Item 和项目视图

**Files:**
- Create: `server-plugins/requirements/src/commands/createWorkItems.ts`
- Create: `server-plugins/requirements/src/__tests__/createWorkItems.test.ts`
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

Run: `cd server-plugins/requirements && rushx test`

Expected: PASS。

**Step 4: Commit**

```bash
git add server-plugins/requirements models/server-requirements plugins/requirements-resources plugins/tracker-resources models/all rush.json
git commit -m "feat(requirements): trace delivery work items"
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

**Step 1: 写版本快照失败测试**

创建 Case v1/Plan，修改步骤为 v2，断言旧 Plan/Run 仍解析 v1；migration 给旧 Case 默认版本 1 且可重复。

**Step 2: 运行确认失败**

Run: `cd models/test-management && rushx test`

Expected: FAIL。

**Step 3: 实现 TestStep 和版本策略**

TestStep 使用 AttachedDoc + Rank；Case 更新结构化内容时递增版本并生成不可变快照引用。

**Step 4: 实现步骤编辑器**

支持添加、删除、排序、操作/数据/预期；Approved Case 修改必须进入评审状态。

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
- Modify: `plugins/test-management-resources/src/components/test-run/NewTestRunPanel.svelte`
- Modify: `plugins/test-management-resources/src/components/test-run/TestRunHeader.svelte`

**Step 1: 写失败测试**

断言 Plan Item 固定 Case version，Run 保存 ProductVersion/Build/Environment/Cycle，Result 历史不受 Environment 归档影响。

**Step 2: 实现模型和 UI**

Environment 变量只允许非敏感展示值；Build 保存 commit/CI URL，不保存 CI token。

**Step 3: 运行测试**

Run: `cd models/test-management && rushx test`

Expected: PASS。

**Step 4: Commit**

```bash
git add plugins/test-management models/test-management plugins/test-management-resources
git commit -m "feat(test): capture build and environment context"
```

### Task 15：实现需求覆盖和失败转 Bug

**Files:**
- Create: `server-plugins/requirements/src/coverage.ts`
- Create: `server-plugins/requirements/src/__tests__/coverage.test.ts`
- Create: `server-plugins/tracker/src/createDefectFromTestResult.ts`
- Create: `server-plugins/tracker/src/__tests__/createDefectFromTestResult.test.ts`
- Modify: `plugins/test-management-resources/src/components/test-result/TestResultFooter.svelte`
- Modify: `plugins/requirements-resources/src/components/RequirementDetails.svelte`

**Step 1: 写失败测试**

覆盖 `TestCase --verifies--> Requirement`、权限过滤、覆盖率缓存重建、Failed Result 创建唯一 Bug、Blocked 必须原因、附件/日志引用。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/requirements && rushx test
cd ../../server-plugins/tracker && rushx test
```

Expected: FAIL。

**Step 3: 实现 coverage 和 defect command**

Bug 内容包括 Case/Step、预期、实际、Build、Environment、执行人和链接；建立 `Bug --defect-of--> TestResult`。

**Step 4: 实现 UI**

失败结果按钮默认打开既有 Bug；Requirement 页面显示覆盖/失败/阻塞摘要。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add server-plugins/requirements server-plugins/tracker plugins/test-management-resources plugins/requirements-resources
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

只接受 `test:result:write` token；先支持 JSON，JUnit converter 作为独立纯函数；未知 Case 不自动创建。

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

**Files:**
- Modify: `services/github/pod-github/src/worker.ts`
- Create: `services/github/pod-github/src/__tests__/crmAlmSync.test.ts`
- Modify: `plugins/github/src/index.ts`
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
git add services/github/pod-github plugins/github plugins/tracker-resources plugins/test-management-resources
git commit -m "feat(github): connect CI builds to delivery"
```

### Task 18：实现 Release Readiness 和发布 Command

**Files:**
- Create: `server-plugins/products/package.json`
- Create: `server-plugins/products/src/index.ts`
- Create: `server-plugins/products/src/releaseReadiness.ts`
- Create: `server-plugins/products/src/releaseProductVersion.ts`
- Create: `server-plugins/products/src/__tests__/releaseGate.test.ts`
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

**Step 1: 写门禁失败测试**

覆盖失败测试、Blocked、P0/P1 Bug、未合并 PR、失败 CI、缺审批、合规豁免、重复发布和状态回写。

**Step 2: 运行确认失败**

Run:

```bash
cd server-plugins/products && rushx test
cd ../../models/products && rushx test
```

Expected: FAIL。

**Step 3: 实现兼容状态和 Readiness 查询**

保留上游 Active/Released 兼容映射；Readiness 每次发布前重新计算，不信任 UI 缓存。

**Step 4: 实现发布 Command**

通过门禁后更新 ProductVersion，并通过 Trace Link 将 Requirement/Lead/Account 写入 Activity；豁免包含人、原因、时间和审批。

**Step 5: 运行测试并提交**

Run: 与 Step 2 相同；Expected: PASS。

```bash
git add server-plugins/products models/server-products plugins/products models/products plugins/products-resources models/all rush.json
git commit -m "feat(release): enforce traceable release gates"
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

### Task 20：实现 V1 基础 Saved View、Form 和仪表盘

**Files:**
- Create: `plugins/crm-lite-resources/src/components/LeadIntakeForm.svelte`
- Create: `plugins/requirements-resources/src/components/RequirementRoadmap.svelte`
- Create: `plugins/traceability-resources/package.json`
- Create: `plugins/traceability-resources/src/index.ts`
- Create: `plugins/traceability-resources/src/plugin.ts`
- Create: `plugins/traceability-resources/src/components/TraceTimeline.svelte`
- Create: `plugins/traceability-resources/src/components/DeliveryDashboard.svelte`
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
git add plugins/crm-lite-resources plugins/requirements-resources plugins/traceability-resources server-plugins/crm-lite
git commit -m "feat(platform): add intake and delivery views"
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

覆盖 QA Plan 映射：AUTH-T001、CRM-T004、REQ-T003、PM-T005、QA-T011、DEV-T001、REL-T004。

**Step 2: 写角色矩阵 E2E**

覆盖 CRM-T010、PM-T011、QA-T019、REL-T008、SYS-T002。

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

验收必须逐项映射 [QA Test Plan](./2026-08-25-huly-crm-alm-qa-test-plan.md)；任何未运行项标记为“未验证”，不得以代码审查代替运行结果。

## V1.1 / V1.2 后续计划入口

V1 验收后再分别编写两个独立实施计划：

- V1.1：通用自定义字段、Lookup/公式 DSL、通用 Form、自动化规则和 JUnit 完整映射；
- V1.2：仪表盘设计器、行级权限、项目组合、资源容量和更多 CI/测试平台。

不得在 V1 实现过程中顺手扩张这些范围。
