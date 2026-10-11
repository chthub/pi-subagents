# pi-subagents

[English](README.md) | [中文](README.zh.md)

> 派生自 [`@everyx/pi-subagent`](https://github.com/everyx/pi-extensions/tree/master/packages/pi-subagent) 1.3.7（everyx/pi-extensions@3b455f1，MIT）。原来依赖的 `@everyx/pi-ui` 已内联到 `ui/`，除 pi 本身外没有运行时依赖。目标版本 pi 1.1.0。

**Pi 的协作式子代理——三原语、有名有姓、互通消息，调度权在你。**

```
你： 调研一下这个项目的数据库 schema
  → pi 调用 agent_spawn，spawn 一个常驻的 `pi --mode rpc` 子进程
  → 子 agent 在独立上下文窗口里独立工作
  → 结果返回；你继续聊天
```

## 为什么需要它？

Pi 没有内置 sub-agent。于是重活、并行的活、吃上下文的活，全都挤进你那一个窗口。pi-subagent 把活交给子 pi：噪音留在那边，只有答案回来。

## 特性

- **安静上下文** — 日志、搜索结果、测试输出留在子窗口里。你拿到最终结果，不是一片杂乱。
- **真正并行** — 一次起多个后台 agent，就绪结果在主代理下一个 turn 边界一起交付，每份保留独立卡片。无任务排队、无取结果工具。
- **全程可控** — `agent_send` 给运行中的 agent 发消息重定向（也能唤醒空闲的），`agent_stop` 终止。子 agent 发往父会话的消息是尽力投递（无确认）。
- **追问保留上下文** —— 子代理完成后默认常驻（空闲，零 token；每个约 180 MB 内存），`agent_send` 发给进程已退出的子代理时会从会话文件自动复活它。子代理缺信息或需要决策时，把问题作为最后的回答结束；父代理用 `agent_send` 回答，子代理接着原来的上下文继续。
- **Pi 原生** — 渲染、会话、attach 全复用 pi 自己的机制；卡片看起来像内置工具——因为它们就是。
- **继承或覆盖** — 子 agent 默认继承你的模型与推理强度，也可逐个覆盖。便宜模型做侦察，强模型做实现。
- **无隐藏限制** — 默认无 token 上限、无超时、无并发上限。需要时用可选 `timeoutMs` 加一道护栏。
- **可复盘** — 每个会话持久化、永不删除；任何结果都能 `pi --session <path>` 回看。
- **按需嵌套** — 默认子代理不能再派子代理；在配置文件里调高 `maxDepth` 才允许。
- **Token 经济** — 系统侧保持克制：
  - **系统提示** — 三个工具 + 简短指南，注入约 2–3KB 系统提示（token 数随 tokenizer 略有出入）。
  - **通知** — LLM 只看到最小结构化数据；装饰（label、用量）留在渲染层，永不进入 LLM 上下文。
  - **结果** — 自动截尾（2000 行 / 50KB）；展开任何卡片仍见全量。

## 与同类插件的对比

pi-subagent 与 [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)、[`pi-subagents`](https://github.com/nicobailon/pi-subagents) 都能为 pi 提供隔离并行的子 agent。它们落在 *原语 → 框架* 的光谱上，pi-subagent 刻意站在最极简的**原语**这一端：三个原语、无预定义角色、无框架——组合由你。具体能力见[特性](#特性)；取舍落在哪里，见下表与两个最流行的同类插件对照。

| | **pi-subagent** | **@tintinweb/pi-subagents** | **pi-subagents (nicobailon)** |
|---|---|---|---|
| 设计姿态 | 最小原语 | 全功能框架 | 全功能框架 |
| 工具面 | `agent_spawn` / `agent_stop` / `agent_send`（3 个） | Claude Code 风格 `Agent` / `get_subagent_result` / `steer_subagent` | `subagent` + 管理/状态/控制工具族 |
| 预定义角色 | 无——由 prompt 定义 | 自定义类型 `.pi/agents/*.md`（frontmatter） | 8 个内置（scout / reviewer / worker / oracle…） |
| 并行 | 无并发上限（一 agent 一进程） | 队列，默认并发 4 | 有 spawn / turn / usage budget |
| 默认限制 | 无（可选 `timeoutMs`） | graceful turn limits | turn / usage budget |
| 可观测性 | pi 原生卡片 + widget + `pi --session` | FleetView + conversation viewer | FleetView inspector + fleet |
| 嵌套 | 天然、无深度上限 | opt‑in、有深度上限 | recursion guard |
| 附加能力 | token 经济、零运行时依赖、reload/崩溃零孤儿 | memory、worktree 隔离、定时任务、跨扩展 RPC、事件总线 | missions/定时、watchdog、worktree、intercom、chain 编排 |
| 适合 | 自己掌控组合 | 开箱即用的完整子 agent 系统 | 内置角色 + 工作流编排 |

## 安装

```bash
# 本地目录（开发）
pi install /path/to/pi-subagents

# git
pi install git:github.com/chthub/pi-subagents
```

只在一次会话里试用：`pi -e /path/to/pi-subagents/index.ts`。

重启 pi 后直接说"让子 agent 去…"。

## 快速上手

### 发起一个任务

```
让一个子 agent 分析 src/ 下的认证逻辑
```

Pi 调用 `agent_spawn`（前台），子 agent 隔离运行，结果内联返回。

### 后台并行跑多个

```
同时起三个子 agent 分别看 auth 模块、数据库层和 API 路由
```

Pi 在同一块里发三次 `agent_spawn`——前台调用并行执行，每次调用的结果携带对应 agent 的最终输出（无需轮询、无需额外的取结果工具）。

### 发消息或停止

```
那个数据层子 agent——方案行不通，改用组合式重写
```

Pi 调用 `agent_send` 向运行中的 agent 注入 steering（当前模型响应及工具批次结束后、下一次模型调用前送达）。要停掉失控的 agent：“干掉那个后台子 agent” → `agent_stop`。两者对运行中的 agent 都适用；`persistent: true` 的话，完成后依然可寻址——`agent_send` 唤醒空闲的 agent 继续追问，`agent_stop` 结束。

## 启用方式

三个 agent 工具注册时**默认不激活**：不派子代理的对话里不带它们的参数说明和指引。常驻的只有一个无参数的 `subagent_enable`，你提到子代理（或任务明显适合委托）时模型会先调用它，下一次请求起三个工具才出现。启用记录写进会话，resume 后仍然有效。

## 底部列表与子代理窗口

输入框下方列出本对话的所有子代理，一行一个（运行中 / 空闲 / 完成 / 失败 / 停止）：

```
 ⠋ @jude  只读目录检查   12s  bash: ls -la
 ‖ @yara  keeper        idle
 ✓ @max   分析 auth 模块  1m3s
 点击进入 · /agents
```

- **点击某一行**（pi 默认的全屏模式下可用），或输入 **`/agents`**（`/agents max` 直接打开），进入该子代理的全屏窗口：用 pi 原生组件显示它的完整对话，运行中实时更新。
- **在窗口里直接打字和它对话。** 这是侧聊：回答只留在子代理自己的会话里，**不会**通知主 agent。已结束的子代理在你发第一条消息时用 `pi --mode rpc --session <路径>` 复活，之后常驻（空闲）到主会话结束或被 `agent_stop`。
- **鼠标悬停**时高亮当前行。在 tmux、zellij、screen 里 pi 不开启鼠标移动上报，所以没有悬停高亮，但点击照常可用。
- **Esc** 回到主对话；PgUp/PgDn 或滚轮滚动；全屏鼠标模式下可拖动右侧滚动条滑块、点击轨道跳转，拖到底部后重新跟随新输出。悬停或拖动时滑块从 `┃` 加宽为 `█`，不改变正文换行；悬停依赖终端上报鼠标移动。ctrl+o 展开工具输出。
- resume 或 `/reload` 后列表会从会话记录重建（进程不会保留，会话文件会）。

## 配置

### 配置文件

`<agentDir>/pi-subagents.json`（默认 `~/.pi/agent/pi-subagents.json`，跟随 `PI_CODING_AGENT_DIR`），也可以用 `PI_SUBAGENT_CONFIG` 指定路径。可选；启动和 `/reload` 时读取。

```json
{ "maxDepth": 1 }
```

| 键 | 默认 | 含义 |
|---|---|---|
| `maxDepth` | `1` | 主会话之下允许几层子代理。`1`：主会话能派子代理，子代理不能再派。`2`：子代理还能再派一层。以主会话的值为准，整棵树生效；到达上限的子代理不注册任何子代理工具。 |

值不合法时退回默认值，并在 TUI 里提示。

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PI_SUBAGENT_SESSION_DIR` | `<agentDir>/subagent-sessions/` | 子 agent 会话存放目录；设置可迁移位置。`<agentDir>` 为 pi 的 agent 目录（默认 `~/.pi/agent`，遵循 pi 的 `PI_CODING_AGENT_DIR`）。 |

目录遵循 pi 的 agent-dir 约定，刻意放在 pi 标准会话树之外，让 `pi -r`（resume）保持干净。会话文件永不删除。

### 工具参考

#### `agent_spawn` — spawn 一个隔离的 sub-agent

| 参数 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `prompt` | string | **必填** | 子 agent 的自包含任务描述。 |
| `label` | string | 必填 | 短标识，显示在工具卡、通知卡、widget 行和会话名上。 |
| `model` | string | 继承 | 覆盖子 agent 的模型。指定但注册表中找不到 → **报错，不静默降级**。 |
| `thinking` | `"off"`…`"max"` | 继承 | 覆盖推理强度；省略则用当前会话的级别。 |
| `tools` | string[] | 全部 | 子 agent 可见的工具白名单——白名单之外全部不可见。 |
| `run_in_background` | boolean | `true` | 后台（默认）立即返回 `agent_id`，完成时投递携带最终输出的通知；`false` 阻塞到结果就绪。`pi -p` / json 模式下省略时走前台（宿主答完即退出，后台结果会丢）。子代理里没有这个参数，只能前台。 |
| `timeoutMs` | number | 无 | 可选截止时间（毫秒）。触发时扩展停止子进程、等其 settled 后优雅退出。 |
| `persistent` | boolean | `true`（根会话）/ `false`（子代理内） | 完成后常驻（空闲，零 token），追问时不用重启；`agent_stop` 结束它。`false` 时完成即退出，`agent_send` 仍会从会话文件复活它。 |

同一任务的追问、修订、补测和后续阶段，优先通过原 ID 的 `agent_send` 复用相关代理，包括需要从保存会话恢复的代理。只有独立并行任务、需要干净上下文的独立复核，或已有代理不适合时才新建；不因上一轮完成就创建替代代理。

#### `agent_stop` — 取消代理任务

| 参数 | 含义 |
|---|---|
| `agent_id` | **必填** — `agent_spawn` 返回的 agent id。取消正在执行的任务并停止进程；明确要求停止空闲代理时只关闭进程。优雅终止（stdin EOF）；不生成新的完成通知。 |

用于任务取消、用户明确要求停止，或必须立即中止的错误执行。普通纠正用 `agent_send`，不在完成后例行停止或重建代理。空闲代理不消耗模型 token，随父会话退出而关闭。停止不会删除保存的对话，也不会撤销文件修改或已提交作业；恢复前须核对实际状态。

#### `agent_send` — 树内发消息

| 参数 | 含义 |
|---|---|
| `to` | **必填** — agent_spawn 给到的 agent id（短人名，如 `max`），或 `"@parent"` 发给 spawn 你的会话。 |
| `message` | **必填** —— 消息文本；在目标当前轮结束后送达，唤醒空闲子代理，或从会话文件复活已结束的子代理（回答以通知送回）。 |

`agent_send` 会启动后续工作，不是静默留言。只用于后续任务、必要纠正、补充缺失信息或回答问题；不要用它道谢、发收条、纯状态通报或要求已经完成的代理收尾。完成通知无需确认，应直接整合到工作，不逐条向用户回复“结论不变”。

消息沿树的父子边路由：直接子 agent 下投，`@parent` 上抛，跨层/兄弟消息经途经的父 LLM 上下文中转（见[嵌套 sub-agent](#嵌套-sub-agent)）。

LLM 通过 `promptSnippet` + `promptGuidelines`（系统提示注入）获得使用指南：何时委派、prompt 必须自包含、绝不轮询。

## 进阶

### 指定模型

```
用 claude-sonnet 起一个子 agent 分析数据库设计
```

不指定模型 → 继承当前会话模型。`thinking` 同理：省略时继承当前推理强度，传 `"off"`…`"max"` 可覆盖。

模型**指定但注册表中找不到** → 报错，不静默降级。

### 限制工具

```
让子 agent 调研项目结构，但只允许用 read 和 grep
```

子 agent 看不到其他任何工具。只读探索 + 便宜模型是调研任务的推荐模式。

## 工作原理

每个 sub-agent 都是带持久化 session 的常驻 `pi --mode rpc` 子进程：

- **前台** — `agent_spawn` 等待子进程 settled，取最终输出，然后关闭 stdin（优雅退出）。
- **后台结果** — `agent_spawn` 立即返回；子代理 settled 后，结果进入会话级收件箱。主代理忙碌时，在 `turn_end` 一次交付所有就绪结果，`agent_before_settle` 兜底，不排进逐条 follow-up 队列。空闲时只合并一个事件循环 tick 内已就绪的结果，保留独立卡片、只启动一次模型处理，不等待尚未完成的子代理。
- **发消息/停止** — `agent_send` 双向均用 steering（当前响应及工具批次结束后、下一次模型调用前），空闲子代理会被唤醒；`agent_stop` 关闭 stdin 优雅退出，不新增完成通知，但不删除已排队的有效结果。
- **Persistent idle** — `persistent: true` 时子进程完成后驻留 idle（零 token）；之后 `agent_send` 可唤醒继续同一上下文，`agent_stop` 结束。完成通知与 widget 行带 `idle` 标记。
- **提问与交付** — 每个子任务末尾说明：缺信息时暂停工作，以问题结束本轮回复，等待父代理回答；完成后直接返回交付，结果自动回传，不额外发送一份完成报告。
- **Attach / 复盘** — sub-agent 会话存储在 `<agent 目录>/subagent-sessions/`（见[配置](#配置)）。在主会话里找到 session 路径（agent_spawn 调用结果或完成通知卡片），执行 `pi --session <path>`——通知里也带 path，直接问 LLM 也行。
- **Graceful turn limits（默认不限，opt-in）** — 不设隐藏 deadline：子 agent 一直跑到完成或被停，除非你传 `timeoutMs`。不做 token 限制——用量仅通知卡统计。

## 嵌套 sub-agent

默认关闭（`maxDepth: 1`）。调高 `maxDepth` 之后：

子 agent 是完整 pi 实例——全局安装本扩展后，它天然能再 spawn 子 agent。每一层都是独立进程、独立上下文；深度倍增启动时间与 token 成本。是否值得，由你（或模型）判断。

机制是纯点对点投递器：`agent_send` 按 id（短人名，如 `max`）投给直接子，或投给 `"@parent"`——其他目标显式报错。路由由 LLM 自行完成：每个 agent 只寻址自己被给到的 id，逐跳转发（孙联系祖 = 每层父 LLM 决定用 `@parent` 上转）。信息披露是唯一限制——父持有它 spawn 的 agent 的 id；没被告知的 id 谁也发不到。

## 成本与注意

- **Headless 下子 agent 随宿主退出**（`pi -p`）。主进程在响应结束时退出，后台子 agent 经 stdin EOF 被清理——从不留孤儿。后台流程（等通知、发消息、stop）面向常驻的 TUI 会话。
- **一子 agent 一进程。** 前台后台同是常驻 rpc 子进程。开多了 = 进程多了——请节制。
- **结果一次性投递。** 按进程及 settlement 的 `completion_id` 在当前运行会话内去重。同一代理不同轮次均保留，即使文本相同。主代理中断或报错后，结果只保存、不强行重启模型，供下一轮使用；若主会话先崩，结果仍在子代理 session 文件里（`pi --session <path>`）。
- **恢复依赖保存的会话。** `agent_send` 可从会话文件恢复已退出的直接子代理；`agent_stop` 只针对仍存活的进程。恢复的是对话上下文，不是被中断工具的内存或执行位置。

## 清理

pi 退出时，子 agent（运行中或 idle）都收到优雅的 stdin-EOF 关闭。session 留在磁盘供 attach/复盘——不杀进程、不删文件。
