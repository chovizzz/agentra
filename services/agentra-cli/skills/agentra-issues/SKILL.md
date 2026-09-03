---
name: agentra-issues
description: >-
  Agentra 项目与问题（issue）的查询与读写：agentra project list、agentra issue
  list/get/create/update。用户要查项目、搜 issue、读 issue 正文、建 issue、改标题/状态/
  优先级/描述时用本 skill。不负责测试用例（那是 agentra-testcases）。
metadata:
  cliVersion: ">=0.1.0"
---

# agentra-issues

> **前置条件：** 先阅读 [`../agentra-shared/SKILL.md`](../agentra-shared/SKILL.md)，
> 确认已 `agentra auth login`。

## 职责边界

| 做 | 不做 |
|---|---|
| tracker 项目列表、issue 的搜索/读取/创建/更新 | 测试用例、测试项目（用 `agentra-testcases`） |
| 状态名与优先级的解析 | 删除 issue（CLI 不提供，请到界面操作） |
| 描述的 markdown 读写 | 指派人、组件、周期、附件 |

## 命令

```bash
# 项目 —— identifier 就是 issue 编号的前缀（PLAUD-42 里的 PLAUD）
agentra project list

# 搜索；过滤条件都可选，按 AND 组合
agentra issue list --project PLAUD --status 进行中 --title 登录 --limit 20
agentra issue list --project PLAUD --json

# 读一条，描述渲染成 markdown
agentra issue get PLAUD-42

# 建一条，打印新编号
agentra issue create --project PLAUD --title '登录页在慢网下白屏' \
  --description '## 复现\n1. ...' --priority High

# 改；未传的字段原样保留
agentra issue update PLAUD-42 --status 已完成 --priority Urgent
```

优先级取值：`NoPriority` `Urgent` `High` `Medium` `Low`。

## 三个会咬人的地方

1. **`--status` 必须和 `--project` 一起用。** 状态名是挂在项目类型上的，脱离项目无法解析。
   单独传 `--status` 会直接报错，不会静默忽略。

2. **状态名要用项目里真实存在的那个。** 名字不匹配时报错会把可选值列出来，照着填。
   不要猜英文名——本仓的项目类型多数用中文状态名。

3. **项目有多个任务类型时，`create` 必须传 `--task-type`。**
   一个项目类型可能同时建模「任务」和「缺陷」，两者各有自己的状态流，且状态**同名**。
   不传时 CLI 会报错并列出候选，而不是随便挑一个——挑错会把 issue 放进一个不包含它当前
   状态的流里，界面上看着正常，实际已经错了。

## 给 agent 的建议

- 先 `agentra project list --json` 拿到 identifier，再用它去查，不要靠猜前缀。
- 批量操作前先用 `--json` 查一遍确认命中范围，再逐条 `update`。
- `create` 打印的是新 identifier，直接拿去做后续 `get` / `update`。
