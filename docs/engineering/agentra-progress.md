# Agentra 实施进度

> 基线：分支 `feat/agentra-v1`，`develop..HEAD` 共 38 个 commit。
> 核对时间：2026-09-02。核对方式：逐 Task 在代码里找证据（文件 + 行号），**找不到就记未找到，不做推断**。
> 计划原文：[`docs/plans/2026-08-25-agentra-implementation-plan.md`](../plans/2026-08-25-agentra-implementation-plan.md)

## 怎么读这份文档

- **已完成 / 部分完成 / 未开始** 三档，判据是代码证据，不是计划里的勾选框。
- "缺口"列写的是**计划要求但代码里找不到**的东西。文件名与计划不符但功能对齐的，不算缺口，另行注明。
- 末尾「证据不足」一节列的是**我没能判定**的项 —— 不要当成"已完成"，也不要当成"缺失"，需要人工确认。

## 总览

| | 条数 | Task |
|---|---|---|
| 已完成 | 20 | 0, 2, 3, 3a, 4, 6, 7, 8, 9, 10, 11, 12, 12a, 13, 14, 15, 18, 18a, 18b, 20 |
| 部分完成 | 8 | 1, 5, 12b, 16, 17a, 19, 19a, 22 |
| 未开始 | 5 | 12c, 17, 20a, 20b, 21 |

（Task 23 目标是另一个仓库 `huly-selfhost` 的 fork，本仓无法判定，不计入。）

## 🔴 三个"编译全绿但功能静默失效"的风险，建议优先处理

这三条的共同点是 **`rush build` / `rush validate` 全绿，功能却加载不出来或看不到** ——
正是 [`agentra-module-checklist.md`](./agentra-module-checklist.md) 反复强调的失败模式。

1. **Saved View 的 `alias` 只补了一处。**
   `models/crm-lite/src/index.ts:694` 有 `alias: LEAD_INTAKE_ALIAS`；
   `models/requirements`、`models/cycle`、`models/traceability` 三个模型**都没有 `alias:`**。
   Saved View 的分组按 `alias` 挂，缺了会静默消失，没有任何报错。
   （计划 Task 12b 自己标红过这一条。）

2. **`fixed-by` 的自动路径是断的。**
   解析库 `plugins/traceability/src/closingReferences.ts` 全仓只有它自己的测试引用它，
   `services/github/pod-github` **零引用**。也就是说 PR 描述里的 `fixes #123` 不会自动建边，
   `fixed-by` 目前**只有手工路径**（`server-plugins/agentra-core-resources/src/commands/linkFixedBy.ts`）。

3. **Search 与 Inbox 接入没有任何证据。**
   四个 agentra 模型文件里 `FullTextSearchContext`、`SearchPresenter`、`notification.*`
   **全部零命中**。意味着 Lead / Requirement / Cycle / TraceLink 既搜不到、也不进收件箱。
   Activity 也只挂了一半：`models/cycle`、`models/requirements` 有 `activity.mixin.ActivityDoc`，
   `models/crm-lite`（Lead）与 `models/traceability`（TraceLink）没有。

## 分阶段明细

### Phase 0

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 0 载体最小原型验证 | ✅ 已完成 | 裁决结果落地可见：`models/crm-lite/src/index.ts:342` 用 `crmLite.masterTag.Lead`，`models/requirements/src/index.ts:286` 用 `requirements.masterTag.Requirement`，即 Card MasterTag 方案 |
| 1 fork / 上游 / 功能开关 | ⚠️ 部分完成 | remote 与分支正确。**缺口**：计划要求的 `docs/deployment/crm-alm-environment.md` 不存在（环境变量文档实际落在 `docs/engineering/dokploy-deployment.md` 与 `feishu-login-deploy.md`，内容在、位置不同）；`docs/disableFeatures.md` 里 grep `crm|agentra|feishu` 零命中，即 `CRM_ALM_ENABLED` 等开关说明**未写** |

### Phase 1 统一关系和身份

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 2 Traceability plugin + 模型 | ✅ 已完成 | `plugins/traceability/src/types.ts:26` 六种 kind（converted-to / implements / verifies / defect-of / fixed-by / delivered-in）；`models/traceability/*` 全套 + `__tests__/model.test.ts`；11 处注册齐全（`models/all/src/index.ts:49,217`、`migration.ts:22,83`、`dev/prod/src/platform.ts:23,96,335`、`desktop/src/ui/platform.ts:31,99,224`） |
| 3 Trace Link Command / 权限 / 查询 | ✅ 已完成 | `server-plugins/traceability-resources/src/{query,readFilter,middleware,inheritance}.ts`；`server/server-pipeline/src/serverPlugins.ts:39` 已 `addLocation`。**注**：计划里的 `reconciliation.ts`（缓存对账，Task 19）未找到 |
| 3a 幂等 Command Middleware | ✅ 已完成 | `server-plugins/agentra-core/src/command.ts`（`commandExecutionId()` / `CommandInProgressError` / `CommandPreemptedError`）+ `agentra-core-resources/src/{commandMiddleware,commandRequest,partialWrite}.ts`；注册在 `server/server-pipeline/src/pipeline.ts:76,175`。文件名与计划不同（`claim.ts`→`command.ts`），功能对齐 |
| 4 飞书 OAuth Provider | ✅ 已完成 | `pods/authProviders/src/feishu.ts` + `__tests__/feishu.test.ts`；`foundations/core/packages/core/src/classes.ts:1011` `FEISHU = 'feishu'`；`plugins/login-resources/src/components/providers/Feishu.svelte` |
| 5 飞书开户 / 绑定 / 资料同步 | ⚠️ 部分完成 | 开户在：`pods/authProviders/src/feishuWorkspace.ts:276`。**缺口**：① `union_id` 读到但**不落库**（`feishu.ts:359` 注释自述），`feishuIdentity.ts` / `feishuUnionId.ts` 不存在；② 资料同步只做了姓名，**头像 / 部门 / 在职状态未落库**（计划正文 2026-08-28 更正段已自认）；③ `__tests__/feishuIdentity.test.ts`、`feishuWorkspace.test.ts` 不存在 |

### Phase 2 CRM 和需求入口

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 6 CRM Lite 模型 + 默认 Pipeline | ✅ 已完成 | `plugins/crm-lite/*`、`models/crm-lite/*` + `__tests__/model.test.ts`；双端注册齐全 |
| 7 CRM List / Kanban / 详情页 | ✅ 已完成 | `plugins/crm-lite-resources/src/components/` 11 个组件；双端 `addLocation` 在位。组件命名与计划不同（无 `LeadList.svelte` 等），viewlet 走上游渲染 |
| 8 独立 Requirements 模块 | ✅ 已完成 | `plugins/requirements{,-resources}`、`models/requirements/*` + 测试；双端注册齐全 |
| 9 Lead → Requirement 幂等转换 | ✅ 已完成 | `server-plugins/agentra-core-resources/src/commands/convertLeadToRequirement.ts` + 测试；UI `ConvertLeadPopup.svelte`；`server-plugins/crm-lite/src/leadGuard.ts`。**包结构偏离**：计划设想的 `server-plugins/crm-lite-resources` + `models/server-crm-lite` 不存在，命令统一收进 `agentra-core-resources` |

### Phase 3 交付管理

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 10 Cycle 模型 + Issue mixin | ✅ 已完成 | `plugins/cycle/*`、`models/cycle/*` + `__tests__/{model,bulkActions}.test.ts`；双端注册齐全 |
| 11 Cycle UI / 完成 / rollover | ✅ 已完成 | `plugins/cycle-resources/src/components/` 9 个；`commands/completeCycle.ts` + 测试 |
| 12 Requirement ↔ Work Item ↔ 项目视图 | ✅ 已完成 | `commands/createWorkItems.ts` + 测试；`SplitWorkItemsPopup.svelte`、`RequirementDeliverySection.svelte` |
| 12a `implements` 手工双向关联 | ✅ 已完成 | `commands/{linkImplements,unlinkImplements}.ts` + 各自测试；`LinkImplementsPopup.svelte`、两侧 `*TraceLinksSection.svelte` |
| 12b Work Item 批量编辑 + Saved View（PM-008a） | ⚠️ 部分完成 | 批量 `SetCycle` 已注册（`models/cycle/src/index.ts:341,354,359,366`）+ `bulkActions.test.ts`；`ClassFilters` 三处齐全。**🔴 缺口：`alias` 只有 crm-lite 一处**（见上文风险 1）；`models/requirements/src/__tests__/savedView.test.ts` 不存在 |
| 12c Work Item 模板（PM-008b） | ❌ 未开始 | `plugins/tracker/src/index.ts` grep `implementsRequirement` 零命中；`IssueTemplateData` 的 `cycle?` / `implementsRequirement?` 字段、模板列 viewlet、Create/EditIssueTemplate 的 UI、`CreateIssue.svelte` 的 `updateTemplate()` 铺字段 —— 全部未找到 |

### Phase 4 测试与质量

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 13 Test Case 结构化步骤 + 版本 | ✅ 已完成 | `plugins/test-management/src/types.ts:113 version?`、`:114 steps?`、`:132 TestStep`、`:190` 快照类（按 `(attachedTo, version)` 去重）；服务端 `approvedCase.ts`、`snapshotGuard.ts` + 测试 |
| 14 Build / Environment / Test Run Context（QA-007） | ✅ 已完成 | `types.ts:209 TestEnvironmentVariable`、`:222 TestEnvironment`、`:240 Build`、`:311 TestRunStatus.Skipped`；UI `components/{build,environment}/*` |
| 15 需求覆盖 + 失败转 Bug | ✅ 已完成 | 覆盖：`plugins/traceability/src/coverage.ts`、`RequirementCoverageSection.svelte`、`server-plugins/traceability-resources/src/middleware.ts:619`；转 Bug：`commands/createDefect.ts` + `DefectButton.svelte`。**小缺口**：`BulkLinkVerifies.svelte`（批量关联入口）未找到 |
| 16 自动化测试结果导入（QA-012） | ⚠️ 部分完成 | 有导入通道 `packages/importer/src/testManagement/*`。**🔴 缺口：`services/test-import` 不存在**；全仓 grep `junit` 只命中 5 份 docs/plans 文档、**零代码命中** —— JUnit 解析器、HTTP 服务、docker-compose 条目全部未落地 |

### Phase 5 发布与集成

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 17 GitHub PR / CI / Build 连接 | ❌ 未开始 | `services/github/*/src/` grep `traceability|agentra|fixed-by` 零命中。**注意**：`docs/engineering/github-integration.md` 与 commit `3535b4805` 做的是**接入上游 GitHub 集成本身**，不是 Task 17 的 Build/PR→Trace 打通 |
| 17a `fixed-by` | ⚠️ 部分完成 | 解析库在（`closingReferences.ts` + 测试），手工命令在（`linkFixedBy.ts` + 测试）。**🔴 自动路径断开**（见上文风险 2）；`LinkPullRequestDialog.svelte` 未找到 |
| 18 Release Readiness + 发布 Command（REL-003） | ✅ 已完成 | `server-plugins/products/src/releaseGuard.ts`（三种拒绝理由）+ `releaseGuardMiddleware.ts`；`commands/{releaseGate,previewReleaseGate,releaseProductVersion}.ts` + 三个测试；UI `ReleaseGateView.svelte`、`ReleaseProductVersionPopup.svelte` |
| 18a TraceLink 版本继承 | ✅ 已完成 | `server-plugins/traceability-resources/src/inheritance.ts`；`middleware.ts:107` 注释明确区分"继承未跑"与"覆盖为零" |
| 18b Release Notes 自动生成（REL-005） | ✅ 已完成 | `plugins/products-resources/src/{releaseNotes,releaseNotesScope}.ts` + 测试；`ReleaseNotesEditor.svelte`。**位置偏离**：计划要求放服务端 `server-plugins/products-resources/`，实际在客户端 `plugins/products-resources/` |

### Phase 6 平台能力接入

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 19 Search / Inbox / Activity / Audit | ⚠️ 部分完成 | Audit 在（`__tests__/auditRecordRead.test.ts`，基于 `activity.ActivityInfoMessage`；`deleteGuard.ts` / `traceLinkGuard.ts` 内有 audit 逻辑）；Activity 挂了 cycle + requirements。**🔴 缺口**：Lead 与 TraceLink 未挂 Activity；**Search 接入零证据**；**Inbox 接入零证据**（见上文风险 3）；`reconciliation.ts` 未找到 |
| 19a 归档与恢复（SYS-005） | ⚠️ 部分完成 | 契约 `plugins/agentra-core/src/index.ts:55 Archivable`、`:58 archivedOn?`；`models/agentra-core/src/index.ts:48` 已 `createModel(TAgentraMarker, TArchivable)`；`commands/archive.ts` + `deleteGuard.ts` + 各自测试。**🔴 UI 全缺**：`plugins/agentra-core-resources/src/components/` 只有 `AgentraCorePlaceholder.svelte` 与 `McpSettings.svelte`，`ArchiveConfirm` / `RestoreConfirm` / `ArchivedFilter` 三个组件均不存在 |
| 20 基础 Saved View / Form / 仪表盘 | ✅ 已完成 | `LeadIntakeForm.svelte`、`RequirementRoadmap.svelte`、`TraceTimeline.svelte`、`DeliveryDashboard.svelte`；服务端 `server-plugins/crm-lite/src/{intake,guestScope}.ts` + 测试 |
| 20a 项目概览与风险页（PM-009） | ❌ 未开始 | 全仓 grep `ProjectOverview|RiskPanel` 零命中；`server-plugins/agentra-core-resources/src/projectRisk.ts` 不存在 |
| 20b 受控自定义字段（FLEX-001） | ❌ 未开始 | crm-lite / requirements / test-management 三个模型 grep `setting.mixin.Editable` 全部零命中；`attributeGuard.ts` 全仓不存在 |

### Phase 7 验收

| Task | 状态 | 证据 / 缺口 |
|---|---|---|
| 21 Playwright 全链路与角色矩阵 | ❌ 未开始 | `tests/sanity/tests/` 无 `crm-alm/` 目录；`tests/` 与 `ws-tests/` 下**没有任何**针对 CRM / Requirement / Cycle / TraceLink / Release 的 spec 或 page object（唯三的 grep 命中都是上游既有文件里的普通英文单词） |
| 22 安全 / 性能 / 迁移 / 运维验收 | ⚠️ 部分完成 | 有替代产物：`docs/engineering/agentra-accepted-risks.md`、`agentra-module-checklist.md`、`dokploy-deployment.md`、`feishu-login-deploy.md`。**缺口**：计划指定的 `tests/crm-alm/{security,performance,operations}/*` 与 `docs/release/crm-alm-release-checklist.md` 均不存在 |

## 计划之外、已经做掉的东西

这几块不在原实施计划的 23 个 Task 里，是执行过程中新增的：

- **MCP server**（`services/mcp/pod-mcp-server/`）—— 让 agent 读写 issue 与测试用例，走飞书 OAuth 授权，agent 以**授权者本人**身份操作。10 个工具（list/search/get/create/update × issue + test case），**不含 delete**。
- **设置 → MCP 接入页**（`plugins/agentra-core-resources/src/components/McpSettings.svelte`）—— Claude Code / Codex / Cursor / VS Code 四个一键接入按钮（deeplink 唤起）。
- **生产部署**（`dev/docker-compose.prod.yaml` + `docs/engineering/dokploy-deployment.md`）—— Dokploy 单机，12 个容器，7 个域名全部 HTTPS（Traefik + Let's Encrypt）。本地数据已逐条迁移到线上，含附件。
- **多语言热切换修复**（`foundations/core/packages/platform/src/i18n.ts` 并行加载 + `packages/theme/src/Theme.svelte` 响应式 `lang`）—— 原来切语言要刷新页面。

## 部署现状（2026-09-02 实测）

| 服务 | 域名 | 探测 |
|---|---|---|
| front | `agentra.49.51.37.69.sslip.io` | 200 |
| account | `account.…` | 405（GET 不允许，服务正常） |
| transactor | `transactor.…` | 404（WS 端点，符合预期） |
| collaborator | `collab.…` | 404（同上） |
| datalake | `datalake.…` | 200 |
| github | `github.…` | 404（webhook 在 `/api/webhook`） |
| mcp | `mcp.…` | `/health` → `{"status":"ok"}` |

飞书 provider 已注册：`account` 的 `/providers` 返回 `[{"name":"feishu","displayName":"飞书"}]`。

## 证据不足，需要人工确认

下面几条我**没能判定**，不要当成已完成：

1. **Task 11**：`CyclesView.svelte` 是否等价于计划里的 `CycleStats.svelte`（统计面是否真的做了）。
2. **Task 13 / 14**：`models/test-management/src/__tests__/` 目录不存在，契约与 UI 齐全但**模型级单测没有**。
3. **Task 18**：`delivered-in` 的建边逻辑是否在 `releaseProductVersion.ts` 内（无独立 `deliveredInLinks.ts`）。
4. **Task 19a**：`Archivable` mixin 是否真的挂到了 Lead / Requirement / Issue / TestCase 四个类上 —— `models/agentra-core/src/index.ts:29` 有一条警告注释需要人工读全。
5. **Task 18a**：RequirementDetails 上"新版本尚未确认测试覆盖"的提示未直接定位到。
