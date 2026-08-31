<!--
source: docs/architecture.md
source-sha256: 707f2b09b5afe1e33f39c1a35b04afb9b087864deb61bef6de987374e1b9dc40
-->

# 架构

本页解释什么在哪里运行，以及为什么。已冻结的类型表面见
[API 规范](engine-adapter-api.md)；各 Engine 的实测支持情况见
[Capability 矩阵](capability-matrix.md)。

## 分层

<p align="center">
  <img src="assets/runskein-layers.svg" width="900"
       alt="Your application calls the runskein public API (Hub, Session, typed errors, optional runskein/fold). Beneath it, engine-agnostic core holds sessions, permissions, resume, the transcript store and the process manager. Beneath that, an internal-only ACP client speaks JSON-RPC over stdio to opencode, kimi, claude-code and codex directly, and to pi through a shim translating ACP to pi's JSONL.">
</p>

同一个形状的文字版——diff 和读屏软件能跟着走的是这一份：

```text
        your application
               │
               ▼
┌──────────────────────────────────┐
│  runskein public API             │  Hub, Session, typed errors
│  (runskein's own types)          │  runskein/fold (optional)
├──────────────────────────────────┤
│  core                            │  sessions, permissions, resume,
│  engine-agnostic                 │  transcript store, process manager
├──────────────────────────────────┤
│  ACP client (internal only)      │  JSON-RPC over stdio
└──────────────────────────────────┘
        │        │        │        │
        ▼        ▼        ▼        ▼
   opencode    kimi   claude-code  codex      ← speak ACP directly
                                     pi       ← shim translates to pi's JSONL
```

两条规则维系着这种形状：

- **Core 绝不从 `adapters/*` import。** Adapter 是供 core 读取的数据，
  不是供 core 调用的代码。
- **只有 `packages/core/src/acp/` 与 shim 入口可以 import ACP SDK。**
  消费者能够触达的任何东西都不可以，正因如此，公开类型才能始终属于 runskein 自己。

## 一个轮次的完整流程

```text
session.prompt("…")
      │
      ▼
  core sends the prompt over ACP
      │
      ├──► engine asks to run a command
      │        │
      │        ▼
      │    permission policy decides → allow / deny / ask you
      │
      ├──► engine streams text and tool updates
      │        │
      │        ├──► transcript store  {seq, ts, sessionId, engineId, update, usage?}
      │        └──► session.on('update')  → your code, or fold → your UI
      │
      ▼
  turn ends → TurnResult { stopReason, usage }
```

每个事件都会先保存，再交给你。

## Transcript 属于 runskein，词汇属于 ACP

每个事件都包裹在 runskein 自己的 envelope 中：

```text
{ seq, ts, sessionId, engineId, update, usage? }
```

`update` 是 ACP 的 `SessionUpdate` 形状，保持不变。这里刻意没有第二套事件词汇需要学习，
也没有第二套词汇需要保持同步。`usage` 是 runskein 自己的类型，因为 ACP 的类型不稳定。

**本地 store 才是权威。** Session 列表与 resume 由你自己的 transcript store 回答，
Engine 自身的状态只用于交叉核验。Engine 会遗忘、删除，也会运行在其他机器上；
你的磁盘不会。

## 三类 Capability

每项功能都属于三个层级之一，而且任何失败都绝不会静默发生：

```text
Core       must work on every engine      → call it; the registration gate
                                            blocks any adapter that fails it
Negotiated works only if the engine says   → check hub.describe() first, or
           it can                            catch NotSupportedError
Emulated   runskein fills the gap        → call it; the result tells you
                                             which path was taken
```

缺失的 Capability 是你的代码可以选择的一条分支，不是一次悄无声息地什么都没做的调用。
哪个 Engine 公布了什么是实测所得，而不是声明所得——
[Engine 支持](engine-support.md)提供表格，而
[`conformance/matrix.public.json`](conformance/matrix.public.json) 提供生成该表的实测值。

### Resume：最清楚的 Emulated Capability

runskein 按顺序尝试三件事，并在 `session.resumeTier` 中报告胜出者：

```text
native session/resume  ──absent──►  session/load  ──absent──►  rebuild from
                                                               transcript digest
```

runskein 的 `sessionId` 在三条路径中始终不变，所以调用方只要存下一个 id，
无论 Engine 能做什么，都一定可以用它 resume。

## 进程

一个 Hub 按 Engine id 索引 Engine 进程：**一个 Hub、每个 Engine 一个进程**，
由每个 Session 共享，并通过引用计数释放。只有当没有 Session 持有该 Engine 时，
`idleTimeoutMs` 才开始计时。

这里列出两项细节，是因为它们经过实测，而不是凭空设想：

- **环境清洗。** 启动子进程时会移除宿主的 Session 标记。否则，从 Claude Code
  Session 内启动 Engine 会泄漏标记，导致 Claude Code 的 ACP 包装器以
  「active session」为由拒绝启动。移除哪些标记，由各 Adapter 自己声明——
  claude-code 声明 `CLAUDE*`，codex 声明 `CODEX_SANDBOX*`，opencode 声明
  `OPENCODE_SESSION*`/`OPENCODE_CALLER*`，pi 声明它自己的——所以清洗只作用于
  标记所属的那个 Engine，不作用于其他 Engine（决策 045）。
- **孤儿进程回收。** 目前没有任何内置 Engine 能活过宿主的 `SIGKILL`——
  claude-code 曾经可以，直到它的包装器被替换，而这正是这个「宿主死亡看门狗」
  存在的原因。机制保留下来，由各 Adapter 用 `supervise` 声明：一个 Engine
  会不会自己收拾干净，是它当前这个版本的性质，不是它永远的性质。

从上层触达不了其中任何一项：宿主拿不到 pid、引用计数或 backoff timer。

## Adapter 是数据

Adapter 只回答一个问题——如何启动一个会说该协议的进程？——它是声明式数据，
外加至多一个 `detect()` 探测。Session 生命周期、事件映射、权限、resume 与进程监督
属于 core，并且对每个 Engine 一视同仁。Adapter 也不声明 Capability：
Capability 在运行时依据 Engine 自身的回答实测得出。

Adapter 通过三种方式抵达 Hub：内置 Adapter 由 `runskein` meta-package import，
目录发现机制依据 `package.json` 中的 `runskein.adapter` 标记找到其余 Adapter，
宿主也可以自行传入 Adapter 对象。无论以哪种方式抵达，Adapter 都会依照 schema 检查，
并在失败时隔离：损坏的 Adapter 会被报告为 `health: 'invalid'`，但不会拖垮 Hub。

操作指南见 [Adapter 指南](adapter-guide.md)。

## 不说 ACP 的 Engine

pi 不说 ACP。它由一个 out-of-process shim（`adapters/pi/shim.mjs`）驱动，
该 shim 把 ACP 翻译成 pi 自己的 JSONL RPC。shim 位于线路的远端，因此它可以在
消费者代码不能 import ACP SDK 的地方 import 它；而在你的代码中，`engine: 'pi'`
与 `engine: 'codex'` 的写法完全相同。见
[决策 028](decisions/028-non-acp-engines-via-shim.md)。

## 包

```text
packages/runskein   what consumers install; bundles the built-in adapters
packages/core         Hub, Session, transcript stores, permissions, types
adapters/*            per-engine detection and launch details (data)
packages/fold         turns transcripts into UI state (consumer-side)
packages/testkit      scripted agent for consumers' own tests
packages/conformance  the adapter and transcript test suites
packages/cli          terminal tool for development and checking
```

`cli` 与 `conformance` 是开发工具，不会发布。其余四个包加上五个 Adapter
会在同一条版本线上一起发布：给定版本在每个包中都相同，因此无需考虑它们之间的兼容性矩阵。

## 边界划在哪里

调度、预算、agent 之间的仲裁与 workspace 隔离，**按设计就属于** runskein 上方那一层。
决定一项功能应落在哪一侧的规则看的是**触达范围**，不是重要性：

- **runskein 内部：任何需要进程句柄或 ACP 连接的东西。** 孤儿进程回收、
  进行中请求控制、Engine 引用的空闲释放、resume 时重新应用配置、崩溃恢复、
  错误分类，以及向上传递额度与认证信号。上层宿主看不到 pid、引用计数、
  backoff timer 或线路错误，所以这些东西没有一个能放在那里。
- **外部：任何能够表达为 `prompt()` 加读取结果的东西。** Worktree 隔离——
  经实测，每个内置 Engine 都遵守逐 Session 的 cwd——任务与 DAG 状态、重试与仲裁策略、
  由 runskein 所传信号驱动的预算门禁、审批策略，以及跨任务调度。

有两个例外值得明确指出，因为它们并不对称。容器隔离无法在 runskein 上方实现：
spawn 属于这一层，所以需要在这里提供 launcher hook。而当策略移出后，这一层剩余的职责是
**信号质量**——这正是 `EngineOperationError` 按 cause 拆分，而不是只报告一个不透明故障的原因。
