# Huly CRM-ALM QA Test Plan & Test Cases

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 范围 | 产品测试管理能力 + fork 自身工程验证 |

## 1. 目标

验证系统在完全自托管环境中能够安全、稳定地完成：

```text
飞书登录 → 线索 → 需求 → 项目/任务 → 测试 → 缺陷 → GitHub PR → 发布 → 回写
```

测试不仅验证成功路径，也覆盖权限隔离、重复请求、外部失败、重试、迁移、备份恢复和上游升级。

## 2. 测试层级

| 层级 | 目标 | 建议自动化 |
| --- | --- | --- |
| Unit | 状态机、权限、计算、门禁、幂等 | Vitest/Jest，随包约定 |
| Model/Migration | Model builder、默认数据、升级和回填 | 现有 model test 工具 |
| Integration | Command、OAuth、Webhook、事件、导入 API | 服务测试 + mock provider |
| E2E | 多角色核心闭环和 UI | 沿用仓库 Playwright sanity 结构 |
| Security | OAuth、越权、注入、Secret、Webhook 签名 | 自动扫描 + 定向测试 |
| Performance | 列表、搜索、关系图、测试结果写入 | 固定数据集压测 |
| Operations | 部署、备份、恢复、升级、回滚 | 隔离自托管环境演练 |

## 3. 测试环境和基准数据

至少准备：

- 一个与生产结构一致的 Docker Compose 环境；
- 一个允许登录的飞书测试租户和一个不允许租户；
- 一个 GitHub 测试组织、仓库和 App/Webhook；
- 6 个角色账号：Sales、Product、PM、Developer、QA、Admin，另加 Guest；
- 100 个 Account、500 个 Contact、5,000 个 Lead；
- 10 个 Product、50 个 Project、100 个 Cycle/Milestone、20,000 个 Work Item；
- 10,000 个 Test Case、200 个 Test Plan、500 个 Test Run、100,000 个 Test Result；
- 2,000 个 PR/Build 映射和 100 个 Product Version。

性能环境扩展到 PRD 容量假设进行独立压测。

## 4. 进入和退出标准

### 4.1 进入标准

- PRD/Spec 对应需求 ID 已冻结；
- migration、feature flag 和回滚说明可用；
- 测试环境健康检查通过；
- 飞书/GitHub 使用测试凭据，未混用生产 Secret；
- P0 用例具备可重复测试数据。

### 4.2 退出标准

- 全部 P0 用例通过；
- P1 通过率不低于 98%，剩余问题有明确风险接受；
- 无未处理 Critical/High 安全问题；
- 无数据丢失、重复转换或权限泄露；
- 性能达到 PRD 指标；
- 备份恢复和一次上游升级演练通过；
- 发布门禁和豁免审计验证通过。

## 5. 功能测试用例

步骤中的“创建/打开/提交”均需验证 UI 反馈、持久化结果、Activity/Audit 和刷新后状态。

### 5.1 飞书认证与账号

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| AUTH-T001 | P0 | 合法租户、未绑定成员、允许自动开户 | 点击飞书登录并授权 | 创建唯一 Huly 账号，绑定 tenant/open_id，进入指定工作区 |
| AUTH-T002 | P0 | 已绑定成员 | 再次飞书登录 | 进入原账号，不创建重复账号 |
| AUTH-T003 | P0 | 非允许租户 | 完成飞书授权 | 拒绝登录，显示租户不允许，审计记录不含 token |
| AUTH-T004 | P0 | OAuth state 被修改 | 调用回调 | 拒绝请求，不发放 Huly token |
| AUTH-T005 | P0 | 同一 code 已使用 | 重放回调 | 第二次失败，不产生额外 session/账号 |
| AUTH-T006 | P0 | 自动开户关闭、成员未邀请 | 登录 | 给出联系管理员提示，不自动加入工作区 |
| AUTH-T007 | P0 | 已有同邮箱本地账号但未绑定 | 飞书首次登录 | 不静默合并；进入确认/管理员审批流程 |
| AUTH-T008 | P0 | 飞书服务不可用 | 登录 | 显示可恢复错误；本地管理员仍能登录 |
| AUTH-T009 | P1 | 资料同步开启 | 飞书更改姓名/头像后同步 | 更新展示资料，不改变对象所有权 |
| AUTH-T010 | P1 | 成员离职事件或同步结果 | 执行同步 | 按策略禁用登录，历史 Activity 保留 |
| AUTH-T011 | P0 | 普通用户 | 尝试修改飞书 Provider 配置 | 拒绝并记录安全审计 |
| AUTH-T012 | P0 | 日志采集开启 | 执行成功和失败登录 | 日志无 client secret、code、access/refresh token |

### 5.2 CRM 与线索转换

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| CRM-T001 | P0 | Sales 登录 | 创建含必填字段的 Lead | Lead 创建成功并出现在表格/看板 |
| CRM-T002 | P0 | Sales 登录 | 缺少 Account/Contact 或下一步动作提交 | 阻止提交并定位必填字段 |
| CRM-T003 | P0 | 已有 Lead | 拖动 Kanban 状态 | 状态和 Activity 更新，刷新后保持 |
| CRM-T004 | P0 | Lead 处于 Qualifying | 转换并选择产品、项目和负责人 | 创建 Requirement、Trace Link，Lead 变 Converted |
| CRM-T005 | P0 | CRM-T004 完成 | 重复点击或重放相同 idempotency key | 返回同一 Requirement，无重复对象/关系/通知 |
| CRM-T006 | P0 | 并发客户端 | 同时转换同一 Lead | 只产生一个 Requirement，另一请求返回既有结果 |
| CRM-T007 | P0 | Lead 已转换 | 打开 Lead | 显示唯一 Requirement 和下游状态 |
| CRM-T008 | P0 | Lead 有评论/附件 | 转需求 | 来源保留；按规则链接附件，不静默丢失 |
| CRM-T009 | P1 | 相似客户已存在 | 新建 Account/Lead | 给出重复提示但不错误合并 |
| CRM-T010 | P0 | Developer 权限受限 | 打开含敏感字段的 Lead 关系 | 只显示允许字段，不泄露敏感信息 |
| CRM-T011 | P1 | Intake 表单启用 | 外部提交有效表单 | 创建待分流 Lead，记录来源和反滥用结果 |
| CRM-T012 | P1 | Intake 表单 | 重复/恶意高频提交 | 触发限流或反滥用，不污染主列表 |
| CRM-T013 | P0 | Lead 关联 Requirement | 尝试物理删除 Lead | 默认归档或阻止；关系仍可追溯 |
| CRM-T014 | P1 | 多个 Lead 关联客户 | 打开 Account | 汇总线索、需求、Bug、版本且遵循权限 |

### 5.3 需求与项目管理

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| REQ-T001 | P0 | Product 登录 | 创建 Requirement 并填写验收标准 | 保存版本化正文和初始版本 |
| REQ-T002 | P0 | Requirement Approved | 修改验收标准 | 产生新版本并标记关联 Test Case 待复核 |
| REQ-T003 | P0 | Requirement Approved | 拆分 Story/Task/Bug | 创建 Work Item 和 implements 关系 |
| REQ-T004 | P0 | 多个来源 Lead | 关联同一 Requirement | 所有来源可查询，计数与关系一致 |
| REQ-T005 | P0 | 未评审 Requirement | 尝试进入 In Delivery | 按工作流拒绝或要求审批 |
| PM-T001 | P0 | PM 登录 | 创建 Project、Component、Milestone | 对象在项目导航和筛选中可见 |
| PM-T002 | P0 | 已有父任务 | 创建多级子任务 | 父子层级、汇总和导航正确 |
| PM-T003 | P0 | 两个 Issue | 配置 FS/SS/FF/SF 依赖 | Gantt 正确展示依赖类型和日期影响 |
| PM-T004 | P0 | 依赖图 | 创建循环依赖 | 阻止并说明冲突链路 |
| PM-T005 | P0 | Project 有 Issue | 创建 Cycle 并加入 Issue | Cycle 范围、容量和 Issue 反向关系正确 |
| PM-T006 | P0 | Active Cycle | 完成 Cycle 并选择 rollover | 完成项保留；未完成项按策略滚动且有 Activity |
| PM-T007 | P1 | Cycle 有历史数据 | 查看燃尽和速度 | 使用快照计算，结果与 Issue 历史一致 |
| PM-T008 | P0 | Issue 有估时 | 填报工时 | reported/remaining 正确，权限和日期规则生效 |
| PM-T009 | P0 | 同一项目数据 | 切换 List/Kanban/Gantt/Calendar | 视图展示同一对象，不复制或丢失更新 |
| PM-T010 | P1 | 已保存筛选 | 创建 Saved View 并共享 | 个人/共享权限正确，字段和排序保持 |
| PM-T011 | P0 | Guest 仅获一个项目 | 全局搜索和关系跳转 | 只返回授权项目对象 |
| PM-T012 | P1 | 项目存在阻塞/延迟/失败测试 | 打开项目概览 | 风险和质量摘要与明细一致 |

### 5.4 测试资产和执行

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| QA-T001 | P0 | QA 登录 | 创建 Test Suite 和子 Suite | 层级、排序和 Test Case 计数正确 |
| QA-T002 | P0 | Suite 已存在 | 创建含前置条件和 3 个步骤的 Case | 步骤顺序、数据和预期结果持久化 |
| QA-T003 | P0 | Test Case Draft | 提交审核并批准 | 状态按规则推进，审核人和时间审计 |
| QA-T004 | P0 | Test Case Approved | 修改步骤 | 新增版本；历史 Test Run 仍显示旧快照 |
| QA-T005 | P0 | Requirement、Case 已存在 | 建立 verifies 关系 | 双向可见，覆盖率重新计算 |
| QA-T006 | P0 | Requirement 无 Case | 查看覆盖率 | 显示未覆盖且可快速创建/关联 Case |
| QA-T007 | P0 | 多版本 Case | 创建 Test Plan | Plan Item 固定所选版本 |
| QA-T008 | P0 | Plan、Build、Environment 已存在 | 创建并开始 Test Run | Run 保存完整上下文和执行人 |
| QA-T009 | P0 | Run 中 Case | 标记 Passed 并填写实际结果 | Result 保存，进度和统计更新 |
| QA-T010 | P0 | Run 中 Case | 标记 Failed、上传日志/截图 | Result 保存失败上下文，通知负责人 |
| QA-T011 | P0 | Failed Result | 一键创建 Bug | Bug 自动含复现/预期/实际/Build/Environment/附件和 Trace Link |
| QA-T012 | P0 | QA-T011 完成 | 重复创建 Bug | 打开已有 Bug 或明确允许另建；默认不重复 |
| QA-T013 | P0 | Bug 已修复 | 创建回归 Run 并执行 Passed | 历史失败保留，新结果关联 Bug 和修复版本 |
| QA-T014 | P0 | Result Blocked | 填写阻塞原因 | 原因必填，统计归入 Blocked，不误算 Failed |
| QA-T015 | P1 | 多环境/Build | 对同一 Case 多次执行 | 各 Result 隔离且可按环境/Build 筛选 |
| QA-T016 | P1 | 结果导入 token | 导入有效 JSON/JUnit | 匹配 Case、Build、Run，状态和日志正确 |
| QA-T017 | P1 | 相同 pipeline id | 重复导入 | 幂等，无重复 Result |
| QA-T018 | P1 | 未知 Case key | 导入 | 进入待映射，不批量静默创建 Case |
| QA-T019 | P0 | Developer 只读测试资产 | 尝试改 Approved Case | 拒绝；允许按权限查看和从失败创建缺陷 |
| QA-T020 | P1 | 大型 Run | 批量执行/筛选 10,000 Result | 进度准确，页面和写入达到性能指标 |

### 5.5 GitHub、CI 与发布

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| DEV-T001 | P0 | GitHub 已连接 | 将 PR 关联 Work Item | Work Item 显示 PR、分支、Review、Checks |
| DEV-T002 | P0 | 相同 webhook event | 重复投递 | 只处理一次，无重复 Activity/关系 |
| DEV-T003 | P0 | Webhook 乱序 | 先投递 merged 再投递 opened | 最终状态保持 merged，不回退 |
| DEV-T004 | P0 | GitHub 暂时失败 | 触发同步 | 进入重试并显示 Pending/Failed，不静默成功 |
| DEV-T005 | P0 | 达到重试阈值 | 查看管理页并人工重放 | DeadLetter 可见，重放成功且审计 |
| DEV-T006 | P0 | PR 合并但必需测试失败 | 接收 merged 事件 | 可推进开发状态，但不得越过发布门禁 |
| DEV-T007 | P1 | CI 失败 | 接收 check run | 关联 Build/Test Run 并通知负责人 |
| REL-T001 | P0 | Product Version 有完整范围 | 打开 Release Readiness | 汇总需求、任务、测试、缺陷、PR 和审批 |
| REL-T002 | P0 | 存在必需测试失败 | 尝试 Release | 阻止并列出准确失败项 |
| REL-T003 | P0 | 存在未关闭 P0 Bug | 尝试 Release | 阻止并提供 Bug 链接 |
| REL-T004 | P0 | 所有门禁通过 | 发布 Product Version | 状态 Released，需求/Lead/Account 回写 |
| REL-T005 | P0 | 重复发布 command | 使用相同 idempotency key 重放 | 返回同一发布结果，无重复通知/版本 |
| REL-T006 | P1 | Admin 有豁免权限 | 带原因和审批执行门禁豁免 | 发布可继续，豁免完整审计并出现在报告 |
| REL-T007 | P1 | Version 已发布 | 生成 Release Notes | 按需求/改进/Bug 分类且可编辑 |
| REL-T008 | P0 | 普通 Developer | 尝试豁免门禁 | 拒绝并记录安全事件 |

### 5.6 灵活视图、自动化和审计

| ID | P | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- |
| FLEX-T001 | P1 | Admin 登录 | 为 Lead 创建合法自定义字段 | 字段出现在允许视图和表单，已有数据不丢失 |
| FLEX-T002 | P1 | 核心状态字段 | 尝试删除或改为不兼容类型 | 阻止并说明影响 |
| FLEX-T003 | P1 | 有关系字段 | 创建 Lookup | 结果只读，关系变化后正确更新 |
| FLEX-T004 | P1 | Formula DSL | 输入任意 JS/危险表达式 | 拒绝，不在服务端执行任意代码 |
| FLEX-T005 | P1 | Intake Form | 提交只读/隐藏字段 | 服务端忽略或拒绝，不能越权写入 |
| FLEX-T006 | P1 | 自动化已配置 | 触发条件两次投递 | 动作幂等，执行日志可查 |
| FLEX-T007 | P1 | 自动化动作会越过门禁 | 触发 | 拒绝高风险动作并记录原因 |
| SYS-T001 | P0 | 多模块对象 | 全局搜索关键词 | 返回授权的 CRM/需求/Issue/Test/Release 结果 |
| SYS-T002 | P0 | 受限对象存在关系 | 无权用户查看关系 | 不显示标题、标识、人员、状态或敏感计数 |
| SYS-T003 | P0 | 执行状态/权限/发布操作 | 查看 Audit | 操作人、时间、对象、前后状态和 correlation id 完整 |
| SYS-T004 | P0 | 对象已归档 | Admin 恢复 | 对象及关系恢复，不生成重复对象 |

## 6. 非功能与运维用例

| ID | P | 场景 | 验证 |
| --- | --- | --- | --- |
| NFR-T001 | P0 | 常用列表/详情基准负载 | p95 < 2 秒 |
| NFR-T002 | P0 | 全局搜索基准负载 | p95 < 3 秒，权限结果正确 |
| NFR-T003 | P0 | 100 并发用户执行常见读写 | 无数据损坏，错误率达到发布阈值 |
| NFR-T004 | P0 | Redpanda/外部 API 短暂中断 | 业务写入可恢复，事件最终处理或进入可见 DeadLetter |
| NFR-T005 | P0 | MinIO/附件暂时不可用 | 主对象不错误标记附件成功，恢复后可重试 |
| NFR-T006 | P0 | 全量备份后灾难恢复 | 工作区、关系、附件、搜索重建和账号登录恢复 |
| NFR-T007 | P0 | 从指定上游基线升级 | migration 可重复，数据量和关键关系对账一致 |
| NFR-T008 | P0 | migration 中断后重启 | 从安全点继续，不重复创建默认数据 |
| NFR-T009 | P0 | Secret 扫描和日志检查 | 仓库、镜像层和日志无飞书/GitHub/数据库 Secret |
| NFR-T010 | P0 | Webhook 伪造/签名错误 | 拒绝，无业务副作用 |
| NFR-T011 | P1 | 中文/英文切换 | 新增核心页面无硬编码、缺失 key 或布局破坏 |
| NFR-T012 | P1 | 键盘操作核心表单/看板 | 可完成主要操作，错误有文本提示 |

## 7. 自动化覆盖映射

| 测试集合 | 必须自动化的用例 |
| --- | --- |
| Unit | 状态机、Trace Link 校验、门禁、权限、Cycle 统计、公式 DSL、幂等键 |
| Model/Migration | 新模型注册、默认配置、Case 版本、Product Version 兼容、重复 migration |
| Integration | AUTH-T001–T008、CRM-T004–T006、QA-T011–T018、DEV-T002–T005、REL-T002–T006 |
| E2E smoke | AUTH-T001、CRM-T004、REQ-T003、PM-T005、QA-T011、DEV-T001、REL-T004 |
| E2E role matrix | CRM-T010、PM-T011、QA-T019、REL-T008、SYS-T002 |
| Operations | NFR-T004–T010 |

## 8. 发布测试报告模板

每个 Release Candidate 必须记录：

- 上游 commit、fork commit、镜像 digest 和 migration version；
- 测试环境、数据规模、浏览器和部署拓扑；
- P0/P1/P2 通过、失败、阻塞、跳过数量；
- 未关闭缺陷及风险接受人；
- 性能结果、备份恢复结果和安全检查结果；
- GitHub/飞书合同测试时间；
- 最终 Go/No-Go 决策和审批人。

