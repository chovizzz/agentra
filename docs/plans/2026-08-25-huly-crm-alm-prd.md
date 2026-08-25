# Huly CRM-ALM 产品需求文档（PRD）

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 产品形态 | 基于 Huly Platform fork 的自托管一体化系统 |
| 首期范围 | 轻量 CRM + 需求/项目 + 测试 + GitHub + 发布闭环 |

## 1. 背景与问题

销售线索、产品需求、项目任务、测试用例、代码仓库和版本发布通常分散在多套系统中。信息在转换时丢失，客户无法追溯到需求，需求无法证明由哪些任务、测试和 PR 完成，研发状态也无法及时回到业务侧。

本产品要在一个自托管工作区内建立从客户到发布的完整对象图，并保持接近 Linear 的快速操作体验、飞书多维表格的灵活视图，以及专业测试管理的可验证性。

## 2. 产品目标

### 2.1 业务目标

- 销售线索能够无损转换为产品需求；
- 每个已交付需求能够追溯到任务、测试结果、代码和产品版本；
- 测试失败能够快速形成缺陷并进入研发流程；
- 飞书企业成员无需新密码即可安全登录；
- 所有业务数据可以完全自托管、备份和恢复。

### 2.2 成功指标

| 指标 | V1 验收值 |
| --- | --- |
| 飞书首次登录成功率 | 合法测试账号 100% 通过；非法租户 100% 拒绝 |
| 线索转需求重复对象 | 幂等测试中为 0 |
| 已发布需求追溯完整率 | 100% 存在 Requirement → Work Item → Test Result → PR → Product Version 链路，例外须有批准记录 |
| 测试失败转 Bug | 3 次点击内完成，且自动携带必要上下文 |
| 外部同步可见性 | 100% 外部同步对象显示最后状态与失败原因 |
| 核心 E2E | P0 用例全部通过，无未处理 Critical/High 缺陷 |

### 2.3 非目标

V1 不建设：商机金额、报价、合同、回款、销售预测、客服 SLA、客户门户、邮件收件箱、财务成本核算和完整 ERP。

## 3. 用户与角色

| 角色 | 核心任务 |
| --- | --- |
| 销售 | 创建客户/联系人/线索，跟进并提交需求 |
| 产品经理 | 澄清需求、评审、优先级排序、拆解和验收 |
| 项目经理 | 规划项目、周期、里程碑、依赖和资源 |
| 研发 | 实现 Work Item、关联代码、修复缺陷 |
| QA | 设计用例、计划执行、记录结果、提交缺陷和回归 |
| 管理员 | 自托管配置、飞书身份、权限、字段、流程和集成 |
| 只读/Guest | 查看显式授权的项目或对象 |

## 4. 信息架构

主导航包含：

1. **CRM**：客户、联系人、线索、线索看板、跟进视图；
2. **Products**：产品、需求、Roadmap、产品版本；
3. **Projects**：项目、Cycles、Milestones、Work Items、Gantt、工时；
4. **Testing**：测试库、测试计划、测试执行、缺陷和覆盖率；
5. **Releases**：版本清单、发布门禁、Release Notes；
6. **Reports**：项目、测试、交付和业务闭环报表；
7. **Settings**：用户、飞书、角色、字段、状态、自动化和集成。

全局搜索覆盖以上所有对象；Inbox 汇总关注对象、@提及、指派、审批、同步失败和测试门禁。

## 5. 领域对象和生命周期

### 5.1 Lead

必填字段：标题、Account/Contact、来源、负责人、状态、优先级、问题描述、下一步动作时间。

状态：`New → Contacted → Qualifying → Converted`；任何非 Converted 状态可以进入 `Disqualified`，必须填写原因。

### 5.2 Requirement

必填字段：标题、背景/问题、目标用户、需求描述、验收标准、负责人、优先级、状态。

状态：`Draft → Reviewing → Approved → In Delivery → Validating → Released`，也可进入 `Rejected/Cancelled`。

### 5.3 Work Item

V1 类型：Requirement、Story、Task、Bug、Spike。支持自定义工作流，但必须保留 Open/Done 类别以便汇总。

### 5.4 Test Case

审核状态：`Draft → Ready for Review → Approved`，评审不通过进入 `Fix Review Comments/Rejected`。

执行状态：Untested、Passed、Failed、Blocked、Skipped。

### 5.5 Product Version

状态：`Planning → Active → Release Candidate → Released → Archived`。进入 Released 前执行发布门禁。

## 6. 功能需求

优先级：P0 为 V1 阻断项，P1 为 V1 应交付项，P2 为后续增强。

### 6.1 身份、组织与权限

| ID | 优先级 | 需求 |
| --- | --- | --- |
| AUTH-001 | P0 | 登录页提供“使用飞书登录”，完成 OAuth 授权码流程。 |
| AUTH-002 | P0 | 仅允许管理员配置的 `tenant_key` 登录。 |
| AUTH-003 | P0 | 使用 `tenant_key + open_id` 唯一绑定身份，并保存 `union_id`；不得仅按邮箱静默合并。 |
| AUTH-004 | P0 | 首次登录可自动创建账号并加入指定工作区；关闭自动开户时给出明确提示。 |
| AUTH-005 | P0 | 保留本地超级管理员入口和恢复流程。 |
| AUTH-006 | P1 | 可同步姓名、头像、部门和在职状态；同步失败不得阻断普通登录。 |
| AUTH-007 | P1 | 支持角色、空间和对象权限；敏感 CRM 字段可按角色隐藏。 |
| AUTH-008 | P1 | 身份绑定、解绑、禁用、角色变化写入审计日志。 |

### 6.2 CRM 与 Intake

| ID | 优先级 | 需求 |
| --- | --- | --- |
| CRM-001 | P0 | 复用 Organization/Person 管理客户和联系人。 |
| CRM-002 | P0 | 创建、编辑、分配、归档和搜索 Lead。 |
| CRM-003 | P0 | 提供按状态分组的 Kanban 和可筛选表格视图。 |
| CRM-004 | P0 | Lead 页面展示描述、联系人、活动时间线、附件、下一步动作及所有下游对象。 |
| CRM-005 | P0 | 一键将 Lead 转为 Requirement，并建立双向可见关系。 |
| CRM-006 | P0 | 转换操作幂等；已转换 Lead 再次操作时打开原 Requirement。 |
| CRM-007 | P1 | 支持线索来源配置、无效原因配置、批量分配和重复客户提示。 |
| CRM-008 | P1 | 提供公开或受控 Intake 表单，表单提交进入待分流队列。 |
| CRM-009 | P1 | 支持客户页面汇总线索、需求、Bug 和发布记录。 |

### 6.3 产品与需求

| ID | 优先级 | 需求 |
| --- | --- | --- |
| REQ-001 | P0 | Requirement 使用版本化富文本，支持附件、评论、提及和变更历史。 |
| REQ-002 | P0 | 支持背景、目标、范围、非目标、验收标准、优先级和负责人。 |
| REQ-003 | P0 | Requirement 可关联多个 Lead/Account 和多个 Work Item。 |
| REQ-004 | P0 | 支持评审状态和产品/项目负责人审批。 |
| REQ-005 | P0 | 支持将 Requirement 拆分为 Story/Task/Bug，并保留覆盖关系。 |
| REQ-006 | P1 | 提供需求列表、Kanban、Roadmap 和按产品版本分组视图。 |
| REQ-007 | P1 | 需求变更影响已批准验收标准时，标记关联测试用例待复核。 |
| REQ-008 | P1 | 支持需求模板和批量优先级调整。 |

### 6.4 项目管理

| ID | 优先级 | 需求 |
| --- | --- | --- |
| PM-001 | P0 | 复用 Huly Project、Issue、Component、Milestone、估时和工时。 |
| PM-002 | P0 | 支持父子 Work Item 和 blocks/blocked-by/related 关系。 |
| PM-003 | P0 | 支持 FS、SS、FF、SF 四类计划依赖并在 Gantt 展示。 |
| PM-004 | P0 | 支持开始日期、截止日期、负责人、优先级、估时、剩余和已报告工时。 |
| PM-005 | P0 | 提供 List、Kanban、Gantt、Calendar 和个人工作视图。 |
| PM-006 | P0 | 新增 Cycle：名称、起止日期、目标、容量、状态和关联 Work Item。 |
| PM-007 | P1 | 提供 Cycle 燃尽、完成率、承诺与完成差异及滚动未完成项。 |
| PM-008 | P1 | 支持 Work Item 模板、重复任务、批量编辑和 Saved View。 |
| PM-009 | P1 | 项目概览展示状态、风险、里程碑、工作量、阻塞和测试质量。 |
| PM-010 | P1 | 支持项目组合与产品 Roadmap 的汇总只读视图；高级容量规划放入 V1.2。 |

### 6.5 测试管理

| ID | 优先级 | 需求 |
| --- | --- | --- |
| QA-001 | P0 | 复用 Huly Test Project、Suite、Case、Plan、Run、Result。 |
| QA-002 | P0 | Test Case 支持前置条件及可排序结构化步骤：操作、数据、预期结果。 |
| QA-003 | P0 | Test Case 具有类型、优先级、审核状态、负责人、版本和变更历史。 |
| QA-004 | P0 | Requirement 与 Test Case 支持多对多 verifies 关系。 |
| QA-005 | P0 | Test Plan 固定用例版本并关联产品版本、项目、Cycle/Milestone。 |
| QA-006 | P0 | Test Run 记录 Build、Environment、执行人、起止时间和执行状态。 |
| QA-007 | P0 | Test Result 支持 Passed、Failed、Blocked、Skipped、Untested，并记录实际结果、日志和附件。 |
| QA-008 | P0 | Failed/Blocked Result 可以创建 Bug，自动复制运行上下文并建立 `defect-of` 关系。 |
| QA-009 | P0 | Bug 修复后可创建或加入回归 Run，保留历史结果。 |
| QA-010 | P1 | 提供需求覆盖率、执行进度、通过率、失败率、阻塞和缺陷趋势。 |
| QA-011 | P1 | 提供重复用例、批量选择、参数化数据和测试环境模板。 |
| QA-012 | P1 | 提供自动化结果导入 API，首期支持通用 JSON/JUnit 映射。 |

### 6.6 GitHub 与交付

| ID | 优先级 | 需求 |
| --- | --- | --- |
| DEV-001 | P0 | 复用 Huly GitHub Issue/PR 同步和状态自动化。 |
| DEV-002 | P0 | Work Item 页面展示 Repository、Branch、Commit、PR、Review 和检查状态。 |
| DEV-003 | P0 | PR 合并可以推进 Work Item，但受测试和发布门禁约束。 |
| DEV-004 | P0 | Webhook 处理幂等，失败显示原因并支持人工重试。 |
| DEV-005 | P1 | 支持从 Work Item 生成建议分支名和 PR 引用格式。 |
| DEV-006 | P1 | CI 结果可关联 Build/Test Run，失败时通知负责人。 |

### 6.7 发布管理

| ID | 优先级 | 需求 |
| --- | --- | --- |
| REL-001 | P0 | 复用 Product/Product Version，补充 Planning、RC 和 Archived 状态。 |
| REL-002 | P0 | Product Version 汇总需求、Work Item、PR、Test Run 和未关闭缺陷。 |
| REL-003 | P0 | 发布门禁至少检查必需测试通过、阻断缺陷、未合并 PR 和审批。 |
| REL-004 | P0 | 发布成功后将 Requirement 标记 Released，并写入 Lead/Account 时间线。 |
| REL-005 | P1 | 自动生成可编辑 Release Notes，按需求、改进、Bug 分类。 |
| REL-006 | P1 | 支持管理员记录带原因的门禁豁免，豁免必须审计。 |

### 6.8 多维表格式能力、自动化与报告

| ID | 优先级 | 需求 |
| --- | --- | --- |
| FLEX-001 | P1 | 对 Lead、Requirement、Work Item 和 Test Case 提供受控自定义字段。 |
| FLEX-002 | P1 | 支持 Grid、Kanban、Gantt、Calendar、Form 和 Saved View；视图不复制数据。 |
| FLEX-003 | P1 | 支持关联字段、Lookup 和受限公式；计算字段只读。 |
| FLEX-004 | P1 | 提供触发器-条件-动作自动化，首期使用预定义动作白名单。 |
| FLEX-005 | P1 | 提供项目进度、测试质量、发布准备度和 CRM 转换基础仪表盘。 |
| FLEX-006 | P1 | 管理员可配置字段、视图和自动化；普通用户只管理个人 Saved View。 |

### 6.9 搜索、通知和审计

| ID | 优先级 | 需求 |
| --- | --- | --- |
| SYS-001 | P0 | 全局搜索覆盖 CRM、需求、项目、测试、代码和发布对象。 |
| SYS-002 | P0 | 指派、提及、评审、测试失败、门禁失败和同步失败进入 Inbox。 |
| SYS-003 | P0 | 转换、状态、负责人、权限、测试结论、同步和发布操作写入 Activity/Audit。 |
| SYS-004 | P1 | 关系预览必须执行目标对象权限检查，不得泄露无权内容。 |
| SYS-005 | P1 | 归档对象默认可由管理员恢复；物理删除必须二次确认。 |

## 7. 核心页面验收

### 7.1 Lead 页面

必须同时看到客户/联系人、负责人、状态、下一步动作、描述、活动、附件以及需求/Issue/测试/PR/发布摘要。已转换 Lead 显示唯一 Requirement 入口。

### 7.2 Requirement 页面

必须同时看到版本化正文、验收标准、来源线索、拆分 Work Item、测试覆盖、缺陷、PR 和交付版本。状态推进所缺条件清晰可见。

### 7.3 Project 页面

必须提供概览、List、Kanban、Cycle、Milestone、Gantt、Calendar、测试质量和风险视图。

### 7.4 Test Run 页面

必须显示版本、构建、环境、执行进度、各状态计数、失败详情及关联 Bug。批量执行不得覆盖历史结果。

### 7.5 Release 页面

必须显示范围、测试门禁、阻断缺陷、代码检查、审批、豁免和 Release Notes。

## 8. 非功能需求

| 类别 | 要求 |
| --- | --- |
| 部署 | Docker Compose 为首要路径；Kubernetes 作为生产扩展路径；所有依赖可自托管。 |
| 兼容 | 保持 Huly 上游可持续合并；新增模型使用独立命名空间和可重复 migration。 |
| 性能 | 基准数据下常用列表/详情 p95 小于 2 秒，全局搜索 p95 小于 3 秒；外部 API 等待不计入。 |
| 容量假设 | 单组织不超过 500 活跃用户、10 万 Work Item、5 万 Lead、100 万 Test Result；超出需重新压测。 |
| 安全 | HTTPS、OAuth state、防重放、Secret 外置、最小权限、审计、无敏感日志。 |
| 可靠性 | 外部同步可重试、可观测、可对账；备份恢复演练通过。 |
| 国际化 | V1 提供简体中文和英文关键文案；新增文案不得硬编码。 |
| 可访问性 | 核心键盘操作和表单错误提示可用，遵循现有 Huly 组件规范。 |

## 9. 分期与发布条件

### V1

交付所有 P0，并交付 PM-007、PM-008、QA-010、FLEX-001、FLEX-002、FLEX-005 等关键 P1。完成从飞书登录到产品版本发布的演示数据闭环。

### V1.1

完善 Intake 表单、Lookup/公式、自动化规则、更多 Saved View、JUnit 导入及统计。

### V1.2

高级仪表盘设计器、行级权限、项目组合、资源容量、更多自动化测试平台和外部 API。

每个版本进入发布候选必须满足 [QA Test Plan](./2026-08-25-huly-crm-alm-qa-test-plan.md) 的退出标准。
