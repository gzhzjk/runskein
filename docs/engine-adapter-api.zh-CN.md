<!--
source: docs/engine-adapter-api.md
source-sha256: ccf5afb8b07dd58301ebe3ad7e1537e49988abb9ddeda9bc088e1f48ab70a0d2
-->

# runskein —— API 规范（v1，已冻结）

> 状态：v1 **已冻结**。变更需要在 `docs/decisions/` 中留下一份决策记录。
>
> runskein 是一个统一的 Engine 适配层：用一套 TypeScript API 管理编码 agent Engine
> （启动 / 退出 / resume / fork）、一种 Transcript 格式，并通过自包含、自动发现的 Adapter
> 集成 Engine。Agent Client Protocol（ACP）是内部脊梁——每个 Engine 都被包装成一个 ACP
> agent 进程——但 ACP 传输与 SDK **绝不暴露**给消费者。公开的 runskein 类型在有用之处
> 在结构上镜像所选的 ACP v1 词汇。

---

## 1. 设计原则

1. **两个对象，两种关注点。**`Hub` 管理 Engine /进程；`Session` 管理一次 Session。
   消费者约 90% 的时间花在 `Session` 上。
2. **三个 Capability 层级**（见 §8）：

- **Core** —— 由库保证；受一致性强制。未通过 Core 的 Engine 不可注册。
- **Negotiated** —— Engine 支持时透传；否则给出类型化的 `NotSupportedError`。
  绝不静默忽略。
- **Emulated** —— 由库自己补齐缺口（例如通过 Transcript 摘要实现 resume）。
  对消费者始终可用。

3. **ACP 是内部的。** 消费者看到的是一套 TS API 与 runskein 的 Transcript 信封。
   `ContentBlock`、`SessionUpdate`、`ToolKind` 及相关公开名称是 runskein 自有的、
   对所选 ACP v1 词汇的结构镜像，而不是 SDK 的再导出。ACP 的破坏性变更由 runskein 的
   映射与版本管理吸收，而不是通过 SDK 依赖泄漏出去。
4. **显式选择 Engine。** 没有 `auto` 路由。路由/策略是消费者自己的事。
5. **一种权限机制。** 单一的 `PermissionPolicy` 函数。
   “bypass” 与 “ask” 只是策略，而不是模式。
6. ** Adapter 是可发现的数据，不是代码。** Adapter 描述的是_如何获得一个说 ACP 的进程_，
   位于遵循 Adapter 规范的独立目录中，并被自动发现。新增 Engine 不需要改动 core 或客户端
   —— Capability 协商吸收差异。

---

## 2. Hub

```ts
import { createHub, jsonlStore, sqliteStore, policies } from 'runskein';

const hub = createHub({
  adapters?: EngineAdapter[],       // explicit — highest priority (tests, embedding)
  adapterPaths?: string[],          // extra directories to scan
  discovery?: boolean,              // default false — opt in to executable discovery (§9)
  store?: TranscriptStore,          // default: jsonlStore('.transcripts')
  defaults?: {
    permissionPolicy?: PermissionPolicy,   // default: policies.allowAll
    idleTimeoutMs?: number,                // process reap, after the last reference
    sessionIdleTimeoutMs?: number,         // session lets go of its engine; off when absent
    reactivationAttempts?: number,         // retries per reactivation episode; default 3
    requestTimeoutMs?: number,             // session setup, resume, fork, and cleanup; default 30_000
    turnTimeoutMs?: number,                // prompt only; unbounded when absent
  },
});
```

### 2.1 Engine 清单与发现

```ts
hub.engines(): Promise<EngineInfo[]>;
```

廉价且**绝不启动进程**，但是异步的，因为它会惰性运行每个 Adapter 的 `detect()` 钩子。
结果缓存至 `hub.rescan()`。

```ts
type EngineInfo = RegisteredEngineInfo | InvalidEngineInfo;

interface RegisteredEngineInfo {
  id: string; // 'opencode' | 'kimi' | 'claude-code' | 'codex' | ...
  installed: boolean;
  version?: string;
  authenticated?: boolean; // from detect(); undefined = unknown
  health: Exclude<Health, 'invalid'>;
  error?: never;
  configHints?: ConfigSchema; // static fallback from the adapter
}

interface InvalidEngineInfo {
  id?: string; // absent when it cannot be recovered from the candidate
  installed?: false;
  health: 'invalid';
  error: string;
}

type Health =
  'stopped' | 'ready' | 'starting' | 'degraded' | 'dead' | 'invalid' | 'not-installed' | 'unauthenticated';
```

`stopped` 表示 Adapter 可用但没有子进程，包括首次使用之前与空闲回收之后。
`invalid` 涵盖发现/schema 校验失败的候选，以及 `detect()` 探测失败的已注册 Adapter。
指向后者会以 `EngineOperationError`（operation 为 `adapter/detect`）拒绝；
它绝不会作为一个健康的 `RegisteredEngineInfo` 返回、宣称该 Engine 只是不存在。

```ts
hub.describe(engineId: string): Promise<EngineDescriptor>;
```

昂贵的探测：spawn →`initialize`→`session/new`→ 收集 → 关闭。
带缓存；缓存键 = `engineId + Engine 版本`。

```ts
interface EngineDescriptor {
  capabilities: CapabilityMatrix; // resume/load/fork/list/... booleans
  providers?: ProviderInfo[]; // when the agent supports providers/list
  modes?: SessionMode[]; // e.g. fast / plan / auto
  models?: SessionModel[]; // when the agent advertises models at session/new
  currentModel?: string; // model a fresh session starts on, as probed (advisory)
  configOptions: ConfigOption[]; // thought levels, toggles, and models on
  // engines that expose them as config options
  source: 'probe' | 'hints'; // live truth vs adapter configHints fallback
}
```

`ConfigOption` 是 runskein 对 ACP`SessionConfigOption` 形状的稳定结构镜像，
外加 runskein 自有的 `settable`，它说明一个选项**何时**可写，而不是它持有什么：

```ts
interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | (string & {});
  type: 'select' | 'boolean';
  options?: SelectOption[] | SelectGroup[]; // for type: 'select'
  currentValue?: string | boolean;
  settable?: 'session' | 'creation'; // absent = 'session'
}

type ConfigSchema = ConfigOption[];

interface SelectOption {
  value: string;
  name: string;
  description?: string;
}

interface SelectGroup {
  name: string;
  options: SelectOption[];
}

interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

interface SessionModel {
  id: string;
  name: string;
  description?: string;
}

interface ProviderInfo {
  id: string;
  protocols: string[];
  required: boolean;
  current?: { apiType: string; baseUrl: string };
  metadata?: Record<string, unknown>;
}

interface CapabilityMatrix {
  loadSession: boolean;
  session: Record<string, boolean>; // resume/fork/list/close/... normalized to booleans
  prompt: Record<string, boolean>; // image/audio/embeddedContext/...
  mcp: Record<string, boolean>; // http/sse/...
  providers: boolean;
}
```

真相优先级：**实时探测 > Adapter configHints**。当 Engine 什么也不上报时
（例如不支持 `configOptions`），`describe()` 降级为 Adapter 的 `configHints`，
并标记 `source: 'hints'`。

模型选择与 `configOptions` 分开上报，因为 Engine 把它暴露在自己的协议表面上。
存在 `models` 时，`setConfig({model})` 通过它写入；不存在而 Engine 把模型列为配置项时，
走配置路径。两种情况下消费者都传 `config: { model }`。

### 2.2 Session

```ts
hub.session(opts: SessionOpts): Promise<Session>;   // main entry; spawns on demand
hub.attach(sessionId: string): Promise<Session>;    // re-attach from transcript store
hub.sessions(filter?: SessionFilter): Promise<SessionMeta[]>;
```

```ts
interface SessionFilter {
  engineId?: string;
  status?: Session['status'];
  cwd?: string;
  since?: number; // epoch ms, inclusive
  until?: number; // epoch ms, inclusive
}

interface SessionMeta {
  sessionId: string;
  engineId: string;
  cwd: string;
  status: Session['status'];
  createdAt: number;
  updatedAt: number;
}

interface SessionOpts {
  engine: string; // required, explicit; never 'auto'
  cwd: string;
  mcpServers?: McpServerConfig[];
  systemInstructions?: string;
  resume?: string;
  permissionPolicy?: PermissionPolicy;
  config?: Record<string, string | boolean>;
  sessionIdleTimeoutMs?: number;
  reactivationAttempts?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}
```

`hub.sessions()` 由**本地 Transcript Store **回答（权威）；Engine 的 `session/list` 仅在可用时
用作交叉核对。`requestTimeoutMs` 让建立类操作以 `EngineOperationError`
（`kind: 'timeout'`）拒绝；一个在超时之后才成功的 Session 创建请求会被关闭，
并在 Engine 声明支持删除时被删除。

### 2.3 进程控制

```ts
hub.quit(engineId?: string, opts?: { timeoutMs?: number }): Promise<void>;
hub.health(): Promise<Record<string, Health>>;
hub.rescan(): Promise<void>;
hub.on('engine:crash' | 'engine:restarted' | 'engine:unauthenticated' | 'engine:cleanup-failed', cb): Unsubscribe;
```

与 `engines()` 一样，`health()` 会等待惰性检测且不启动进程。它的记录包含 `id` 已知的
候选；一个 id 无法恢复的无效候选只能通过 `engines()` 看到。

-`quit` 的降级链：对所有存活 Session 调用 `session/close`→ 关闭 stdin →`SIGTERM`→
`SIGKILL`。不带参数 = 所有 Engine。
\-`engine:cleanup-failed` 携带 `EngineCleanupFailure`，包含 Engine、可选的 runskein/原生
Session id、清理操作与原始错误；当某一步失败时，清理绝不会被报告为成功。

- **没有公开的 spawn/restart。**`session()` 按需启动（每个 Engine 的进程按引用计数共享）；
  崩溃会带退避自动重启并发出 `engine:crash`/`engine:restarted`。
  空闲进程在 `idleTimeoutMs` 之后被回收。

---

## 3. Session

```ts
const s = await hub.session({
  engine: string,                    // required, explicit — no 'auto'
  cwd: string,
  mcpServers?: McpServerConfig[],
  systemInstructions?: string,
  resume?: string,                   // prior sessionId; see §7 degradation chain
  permissionPolicy?: PermissionPolicy,
  config?: Record<string, string | boolean>,  // keys validated against describe()
});
```

`config` 的键会对照 `describe()` 解析，而一个键落在哪个表面上取决于 Engine 声明了什么：

| 键          | 表面                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `mode`      | `describe().modes`→`session/set_mode`，否则是 `mode` 类别的配置项                |
| `model`     | Engine 有 `model` 类别配置项时用它，否则 `describe().models`→`session/set_model` |
| `reasoning` | `thought_level` 类别的配置项                                                     |
| 其他任何键  | 具有该 id 的配置项，否则是该类别                                                 |

一个 Engine 可能以两种方式发布模型——codex 在 `models` 中列出带推理强度后缀的 id，
而它的配置项接受裸 id。此时配置项胜出，因为它是稳定表面，且它的 id 正是调用方已经在用的。

未知的键或值会立即失败并给出合法取值列表——绝不静默忽略，也绝不先发给 Engine。

### 3.1 接口表面

```ts
s.id: string;
s.engine: string;
s.status: 'idle' | 'running' | 'awaiting-input' | 'closed' | 'failed';
s.resumeTier?: 'native' | 'load' | 'rebuilt';

s.prompt(input: string | ContentBlock[]): Promise<TurnResult>;
s.cancel(): Promise<void>;           // interrupt current turn; session survives
s.close(opts?: CloseOptions): Promise<void>;
s.fork(): Promise<Session>;          // [Negotiated]
s.setConfig(patch: Record<string, string | boolean>): Promise<void>;  // [Negotiated]
                                     // refuses a settable:'creation' key with
                                     // NotSupportedError('config:<key>@runtime')
s.configState(): SessionConfigState;  // what runskein wrote vs what the engine reports
s.respond(requestId: string, answer: Answer): Promise<void>;  // question replies (HITL)

s.on('update', (e: TranscriptEvent) => void): Unsubscribe;
s.on('permission', (req: PermissionRequest) => void): Unsubscribe;  // read-only notification
s.on('question', (q: QuestionRequest) => void): Unsubscribe;
s.on('status', (st: Session['status']) => void): Unsubscribe;
s.on('reactivated', (info: { tier: 'native' | 'load' | 'rebuilt' }) => void): Unsubscribe;

s.transcript(opts?: { fromSeq?: number }): AsyncIterable<TranscriptEvent>;
s.usage(): UsageSummary;             // cumulative tokens/cost for this session
```

```ts
interface CloseOptions {
  discard?: boolean;
}
```

### 3.2 轮次语义

`prompt()` 是一个**轮次级 promise**：它在该轮结束时兑现。

```ts
interface TurnResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  usage?: Usage;
  durationMs: number;
  quota?: { engineId: string; payload: unknown }; // engine-reported, opaque
}
```

`quota` 就是 Engine 放在 prompt 响应 `_meta.quota` 下的内容，原样透传，
在 Engine 什么也没报告时**缺席**——发送空 `_meta` 的 Engine 不会获得该字段。
它刻意是不透明且 Engine 作用域的：内置 Engine 中只有 codex 报告了点什么，
且其形状是它自有的，因此 runskein 不会从单一样本构建跨 Engine 词汇。
请对照 `engineId` 指明的 Engine 来读取 `payload`。

它**不是剩余额度**。codex 标为 quota 的其实是每轮 token 计数，因此该字段不能用于
预算门控；runskein 也绝不会用 `usage_update` 回填它——把 token 计数当作余量展示，
会给无人值守的宿主一个自信而错误的预算信号。

已经有一个 Engine 开始报告更多东西，而该字段仍然不承载它。claude-code 会在
`usage_update` 的 `_meta` 上、以 `_claude/rateLimit` 为键流式发送一条限流记录，
携带 `status`、`resetsAt` 与 `rateLimitType`（实测于 2026-08-31）——一个真正的重置，
而该字段被设计时还没有任何 Engine 报告过它。它保持不折叠，有两个理由：`quota` 读的是
提示响应，而这条来自通知；并且折叠一个以某家厂商命名的键，正是上一段所说 runskein
不做的那件事——从单一样本构建跨 Engine 词汇。宿主今天就可以原样读到它，从
`on('update')` 或从 Transcript——信封原样保存 `update`，`resetsAt` 也在其中。
等到第二个 Engine 也报告重置时，它们的共同部分才是词汇可以取材的地方。

流式细节通过 `on('update')` 流动。两种风格可组合：简单流程用
`await s.prompt(...)`；流式 UI 或做流折叠的宿主则订阅更新。

`on('update')` 承载 Session 写入 Transcript 的**每一条**事件，顺序相同、`seq` 相同 ——
Engine 的通知与 runskein 自己生成的一视同仁：Session 状态报告、为使 Transcript 读起来像一段对话
而回显的用户提示，以及为「在提示响应上报告 token 的 Engine」合成的那条
`usage_update`（决策 035）。因此同时订阅又重放 Transcript 的消费者会看到每条事件两次，
按 `seq` 去重。emit 发生在事件被记录之时、落库之前，因此这份一致性以「持久化成功」
为前提 —— Store 失败会在下一个 API 边界以 `StoreError` 浮现，而不是让某条 live 事件
悄悄消失。在调用方来得及订阅之前记录的事件 —— Session 创建，以及开启该 Session 的那次
resume —— 不会送达任何监听器，需从 Transcript 读取；而之后的原地 reactivation 会记录它
自己的事件，已订阅者是看得到的。

其中提示回显通常是宿主想跳过的那一条：它已经画过自己提交的输入，而重放上下文的
Engine 也可能发出一条长得一模一样的 `user_message_chunk`。`isPromptEcho(update)`
区分二者 —— 只有 runskein 自己写的那条为 true。

对同一 Session 的并发 `prompt()` 会排队（FIFO）。`cancel()` 语义
（已澄清——见 `docs/decisions/001-cancel-semantics.md`）：**活动中**的那一轮以
`stopReason: 'cancelled'`**正常兑现**（ACP：`session/cancel` 之后是一个普通的
prompt 响应）；只有从未运行过的 prompt——排队中的，或 `close()` 时所有待处理的
——才以 `CancelledError`**拒绝**。

`close()` 会以 `CancelledError` 拒绝活动中与排队中的 `prompt()`promise，
把 Session 标记为 `closed`，且是幂等的。这与 `cancel()` 不同：
经由 `cancel()` 取消的活动轮次确实运行过，因此以其有序的停止原因兑现。

### 3.3 Session 生命周期 —— 空闲释放与崩溃恢复

`Session` 不必在其整个生命里都持有 Engine。两种触发释放它，一种机制把它带回来：

- **空闲。** 设置了 `sessionIdleTimeoutMs` 后，空闲达到该时长的 Session 会释放它的 Engine
  引用。倒计时只在 Session 真正空闲时运行——没有运行中的轮次、没有排队的 prompt、
  没有未回答的权限或提问——任何活动都会重启它。释放最后一个引用，才使得
  `idleTimeoutMs` 能回收进程；这两个时钟是各自独立的截止期。
- **崩溃。** Engine 死亡时，受影响的 Session 释放其所持有的东西。
  在途的 `prompt()` 以 `EngineCrashError` 拒绝。

无论哪种方式，**下一次使用都会原地复活 Session **：`prompt()`、`setConfig()` 与
`fork()` 会重新获取 Engine、运行 resume 链，并重新应用 runskein 曾确认过的每一项配置。
**没有新的动词**——你保留同一个 `Session` 对象、它的 runskein id 与它的 Transcript，
唯一能察觉的方式是这个事件：

```ts
s.on('reactivated', ({ tier }) => {
  /* 'native' | 'load' | 'rebuilt' */
});
```

那个事件不是可有可无的细节。`rebuilt` 层级会把 Transcript 摘要作为新鲜上下文重放，
这会**花费 token**——恢复可以降级，但绝不允许静默降级。

**被打断的那一轮不会被重放。** 它的输出已经在 Transcript 里，但它没有 `stopReason`，
重发会再花一次 token。是否重试属于策略，因此归调用方所有：
被拒绝的 `prompt()` 就是信号，而你发出的下一个 `prompt()` 就是你的决定。

**有界。** 一次复活过程最多重试 `reactivationAttempts` 次（默认 3），
之后以 `EngineOperationError { operation: 'session/reactivate' }` 失败，
其 `cause` 携带 `{ attempts, cap, lastError }`。这与进程管理器的重启次数是不同的
预算：一次复活尝试最多执行一次 Engine 获取，且可能复用健康进程而完全不启动新进程。

`close()` 总是胜出。在复活过程中关闭是安全且幂等的，
一个在途的复活会归还它取走的一切，而不是往一个已关闭的 Session 上发布内容。

### 3.4 丢弃 Engine 侧状态

`close({ discard: true })` 在普通关闭之外增加 Engine 侧删除。它是 **Negotiated** 的：
未声明 `session/delete` 的 Engine 会以 `NotSupportedError { capability: 'session.delete' }`
拒绝，但本地 Session 仍然不可逆地 `closed`，其 Engine 引用已释放，其 Transcript 仍然可用。
本地 Transcript 保留是另一回事：想要那样做的宿主要在它自己构造的 Store 上调用
`TranscriptStore.delete(sessionId)`。

在有 Capability 的 Engine 上，runskein 会在声明支持时先尝试 `session/close`，
然后即便 close 失败也尝试 `session/delete`。删除失败以
`EngineOperationError { operation: 'session/delete' }` 拒绝；
若 close 与 delete 都失败，该错误的 `cause` 是包含两个失败的 `AggregateError`。
所有这些错误都只发生在本地关闭完成之后。

并发且重复的兼容调用共享第一个 close promise，绝不会再发出一次线路上的
close/delete。而一次普通 `close()` 之后再调用 `close({ discard: true })`
会以 `EngineOperationError { operation: 'session/delete' }` 拒绝：
在那里报告成功会虚假地宣称发生过 Engine 侧删除。
在一次丢弃式关闭之后的普通调用，共享那次丢弃式调用的结果。

### 3.5 配置状态 —— 期望与观测

`setConfig()` 只报告一次写入在线路上被接受。此后 Engine 是否真的运行在那个模型上，
是另一个问题，而多数 Engine 从不回答。`configState()` 把两者分开：

```ts
interface SessionConfigState {
  desired: Readonly<Record<string, string | boolean>>;
  observed: Readonly<Record<string, ConfigObservation>>;
}

interface ConfigObservation {
  value: string | boolean;
  source:
    'session/new' | 'session/resume' | 'session/load' | 'current_mode_update' | 'config_option_update';
  observedAt: number; // epoch ms
  engineOptionId?: string; // the wire option id the report carried
}
```

- **`desired`** —— Engine 确认过其写入的值，包括传给 `hub.session({config})` 的配置
  以及 runskein 替你重新应用的一切。
- **`observed`** —— 只包含 Engine 自己上报的：由产生该 Session 的那次调用回显的状态
  （`session/new`、`session/resume` 或 `session/load`，各自以自己的名字上报，
  因此恢复的状态可与全新的区分开），或推送的 `current_mode_update`/
  `config_option_update`。

`desired`**绝不**被复制进 `observed`。`observed` 中缺少某个键意味着 Engine 从未上报过它
——而不是它与 `desired` 一致。读取任一视图都不发出线路请求。

两个映射都以 runskein 键为键（`model`、`mode`、`reasoning`，或直接使用的 Engine 选项 id），
与 `setConfig` 接受的键相同。当 Engine 上报一个 runskein 无法映射到 runskein 键的选项时，
该观测会记录在原始 Engine 选项 id 下而不是被丢弃，
而 `engineOptionId` 告诉你哪个线路标识符产生了某条记录。

---

## 4. Transcript

本库的差异化资产：**一种格式，所有 Engine，持久化**。

```ts
interface TranscriptEvent {
  seq: number; // monotonic per session (runskein-assigned)
  ts: number; // epoch ms (runskein-assigned)
  sessionId: string;
  engineId: string; // provenance (ACP has none of these three)
  update: SessionUpdate; // ACP vocabulary, verbatim
  usage?: Usage; // runskein-owned field; not ACP's UNSTABLE Usage
}
```

- 信封（`seq`/`ts`/`sessionId`/`engineId`）是 runskein 的；词汇（`update`）是 ACP 的
  （`agent_message_chunk`、`tool_call`、`plan`……）。不发明第二套词汇。
- Engine 私有的怪异之处搭载在 `_meta` 上（ACP 官方的扩展点）。
- 写入是内部且自动的；消费者只读。

```ts
hub.transcripts.get(sessionId): AsyncIterable<TranscriptEvent>;
hub.transcripts.export(sessionId, format: 'jsonl' | 'markdown'): Promise<string>;
hub.transcripts.digest(sessionId): Promise<TranscriptDigest>;
hub.transcripts.digest(sessionId, opts: { format: 'structured', ... }): Promise<StructuredDigest>;
```

### 4.1 用量

```ts
interface Usage {
  input?: number;
  output?: number;
  total?: number;
  uncached?: number;
  cacheRead?: number;
  cacheCreation?: number;
  thought?: number;
}

interface UsageSummary extends Usage {
  cost?: number;
  currency?: string;
}

interface TranscriptDigest {
  sessionId: string;
  throughSeq: number;
  text: string;
}

type DigestRole = 'user' | 'assistant' | 'tool';

interface DigestSegment {
  role: DigestRole;
  text: string;
  fromSeq: number;
  toSeq: number;
}

interface StructuredDigest {
  sessionId: string;
  throughSeq: number;
  segments: DigestSegment[];
  truncatedRanges: Array<{ fromSeq: number; toSeq: number }>;
  estimatedTokens: number; // ceil(UTF-8 bytes / 4)
}

interface DigestOptions {
  format?: 'text' | 'structured'; // default text
  maxChars?: number; // default 32_000 characters
  maxTokens?: number;
  truncation?: 'tail' | 'head' | 'head-tail'; // default tail
}

interface StructuredDigestOptions extends DigestOptions {
  format: 'structured'; // narrows digest() to Promise<StructuredDigest>
}

interface TextDigestOptions extends DigestOptions {
  format?: 'text'; // narrows digest() to Promise<TranscriptDigest>
}
```

成本只有在货币一致时才跨 rebuilt resume 的各次生命累计。
如果一条跨 Engine 的链上报了多种货币，两个标量成本字段都保持缺席，
而不是伪造一个换算后的总额（决策 007）。

runskein 自有（ACP 的 `Usage` 被标记为 UNSTABLE；我们不依赖它）。
由 Engine 报告的内容填充；缺席的字段保持缺席——绝不伪造。填充过程由 Engine Adapter
可选的 `usage` 声明驱动、经由唯一一个解释器完成（决策
[033](decisions/033-usage-mapping-adapter-declared.md)）：来源是带 token 字段的
`usage_update` 通知，或是按声明路径在提示响应结果上寻址到的对象。一份上报要么是
Session 累计值（`cumulative`），要么只属于它所在的那个回合（`per-turn`）；而
**`TurnResult.usage` 在任何 Engine 上都表示"本回合"**——在累计型上报者上，它是相对
回合开启时 snapshot 的逐字段差值，并钳制到零。来自 `_meta` 的上报会作为一条合成的
`usage_update`Transcript 事件持久化，使用 runskein 自己的字段名——携带 Session 累计值并通过
runskein`_meta` 条目标记——从而让 resume 在没有 Adapter 时也能一致地重放。

**该声明管的是 token；成本不在其中。** 五个内置 Engine 中有三个今天就报告成本——
opencode、claude-code 与 pi，都是同一种形状 `{amount, currency}`——无论它们的 Adapter
是否声明了 token 映射，`session.usage().cost` 对它们都会被填充。它落在 `UsageSummary`
而不是 `Usage` 上，是因为这些 Engine 报的是 Session 累计总额，而不是每轮的花费，
因此 `TurnResult.usage` 没有一个诚实的逐轮数字可以承载。

### 4.2 折叠 —— 消费者侧的展示状态

Transcript 刻意保持原样：每条 Engine 通知一个信封化事件，一块接一块。
渲染它需要相反的形状——消息段而非分块，每次工具调用一行而非一条增量流。
那个转换就是 `@runskein/fold`，通过 `runskein/fold` 子路径抵达：

```ts
import { createFolder } from 'runskein/fold';

const folder = createFolder();
for await (const e of s.transcript()) {
  for (const folded of folder.push(e)) render(folded); // PresentationEvent
}
for (const folded of folder.flush()) render(folded); // trailing open state
```

`createFolder()` 返回一个 `Folder`；`push()` 接受 `FoldInput`
（一个 `update` 未经校验的 `TranscriptEvent`，因此未知变体得以存活），
并产出携带一个 `PresentationEvent` 及其来源 `SourceRef` 的 `FoldedEvent`。
`MessageKind`、`ToolRow`、`PlanSnapshot` 与 `UsageState` 描述折叠后的形状。

有一个行字段属于 fold 自己而非 Engine。ACP 把 `rawInput`、`locations` 与 `content`
都设为可选，因此“哪个文件、哪条命令”在每个 Engine 上落在不同位置——而在 kimi 上，
它以逐字符增长的 `content` 文本到来。`ToolRow.args` 把这些收敛为
`{ text, value?, from }`，其中 `from` 指明它读自哪个字段，
因此消费者始终能区分 Engine 的陈述与 fold 的拼装。它按形状选择，绝不按 Engine id 选择，
并且绝不会把一次工具的结果文本当作它的输入。规则见
[transcript-fold.md](transcript-fold.md) §4.2.1。

`ToolRow.diffs` 同样属于 fold 自己。一个 `diff` 内容块是
`{path, oldText?, newText}`，它没有说明这段文本是整个文件还是其中的片段——
因此渲染端无法判断把块内行号从 1 编起是否与文件本身的行号一致，
而 `ToolCallLocation` 提供的 `line` 没有任何 Engine 去填。
fold 只在 Transcript 本身能证明答案时作答：没有 `oldText` 的块创建了该文件，
`oldText` 恰好是先前某个整文件块所写内容的块同样覆盖整个文件。
这两类得到 `scope: 'wholeFile'`、`startLine: 1`，以及指明凭据的 `from`；
其余一律是 `scope: 'unknown'` 且不给行号，因为定位一个片段需要文件内容，
而回头去读文件只会把答案锚定在此刻、而非那次编辑发生的时刻（决策 034）。

这项判定是有状态的 —— `chained` 要拿「同 path 上先前那个整文件块写下的内容」来证明 ——
因此它也可以单独持有：`createDiffCoverageJudge()`。它面向那些在不做折叠的通路上仍需要
覆盖范围的消费者：把一个 Session 的每条 `tool_call` / `tool_call_update` 按 seq 顺序推给它，
它给出与 `ToolRow.diffs` 相同的 `DiffCoverage` 列表，而不必携带消息、计划或用量状态；
folder 自身就建立在同一个单元之上，两者因此不可能给出不同的答案（决策 036）。

对于已完成的 Transcript 而非实时流，`collectToolRows(events)` 返回每个 `toolCallId`
最终确定的 `ToolRow`，而 `toolCallText(row)` 拼接其中之一报告的文本。
这也是“子 agent 做了什么？”的答案：启动子 agent 的 Engine 不会开第二个 Session ——
子运行作为一次工具调用报告在父 Session 上，因此那一行包含了 Engine 选择报告的全部内容。

**折叠不属于冻结契约，它的子路径已经说明了这一点。** 它是 Transcript 之上的展示策略：
它绝不触碰 `Hub` 或 `Session`，想要原始事件的消费者干脆不导入它。
把它放在 `runskein/fold` 而不是主入口，意味着冻结表面仍然只是 Engine 适配层，
而把它随同一个包发布则保持一次安装、一个版本——folder 期望的信封不可能与 core
发出的那个漂移。`@runskein/core/internal` 使用同样的子路径手法来分隔一个具有
不同保证的表面。设计见
[transcript-fold.md](transcript-fold.md)。

---

## 5. 权限 —— 一种策略机制

```ts
type PermissionPolicy = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

interface PermissionRequest {
  sessionId: string;
  engineId: string;
  tool: string;
  kind?: ToolKind; // read|edit|delete|move|search|execute|think|fetch|...
  input: unknown;
  locations?: ToolCallLocation[];
  options: PermissionOption[]; // the agent's offered choices
}

type PermissionDecision =
  | { optionId: string } // pick an offered option directly
  | { outcome: 'allow' | 'deny' }; // runskein maps to the closest optionId
```

```ts
interface QuestionRequest {
  requestId: string;
  sessionId: string;
  engineId: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
}

type Answer = { text: string } | { optionId: string };

type Unsubscribe = () => void;
```

内置项只是预制策略：

```ts
policies.allowAll; // default (headless)
policies.denyAll;
policies.rules([{ tool, pattern, action: 'allow' | 'deny' }]); // declarative table
```

交互式的“ask” = 一个由消费者编写、把 `req` 转发给人并等待回复的策略。
不存在单独的模式。

**runskein 替 Engine 运行的命令也到这里。** 有些 Engine 在自己的进程里执行；
另一些通过 ACP 的 `terminal/*` 方法委托给客户端，而 runskein 实现了它们（决策 029）。
既然此时是 runskein 在启动进程，每个 `terminal/create` 都是一次权限请求，
带 `tool: 'terminal'`、`kind: 'execute'`、`input: { command, args, cwd, env }`，
并以解析出的工作目录作为其位置——因此为 `execute` 写的规则表已经覆盖了它。
`env` 是 agent 请求追加的环境——启动时它会覆盖在宿主已擦除的环境之上——
而且它到达策略时已经过校验。每一项都必须是格式良好、变量名合法、值中不含 NUL
字节的 `{ name, value }`，并且同一个变量名不得设置两次——在所有平台上比较时都不区分
大小写。一个把同一个变量写两遍的请求没有唯一含义：完全相同的重名会在启动时坍缩成最后
一个取值，而只差大小写的两个名字在 Windows 上是一个变量、在 POSIX 上是两个——所以它
会被拒绝，而不是背着策略替它作出决定。覆盖项会顶掉宿主自己会解析到的那个变量，因此
无论 Session 跑在什么宿主上，策略读到的取值就是命令实际运行时的取值。上述每一项检查
读取变量名时都不区分大小写，理由相同：Windows 上 `Path` 和 `PATH` 是同一个变量，
一个只认得自己预期那种拼写的守卫，在一个宿主上是边界，在另一个宿主上就是缺口。
落在宿主拒绝清单上的变量名同样会被拒绝，而且是在策略被询问之前。
该清单收录了那些决定一个命令名最终是哪个程序、或者它会加载什么的变量——`PATH`、
`LD_*`/`DYLD_*`、`NODE_OPTIONS`、`GIT_SSH_COMMAND` 之类——
以及宿主会擦除的 Session 标记——也就是本 Session 所属 Engine 在 `envScrubExtra` 里
自己声明的那些，因此逐个 Engine 各不相同（决策 045）。它是一份固定清单，而不是“其余变量都无法影响一个命令”
的证明：它排除掉的是规则表无法有意义回答的那些问题，例如“我可以在一个我自己挑的
`PATH` 下运行它吗”，其余的则交由策略判断。通过该清单的部分对规则可见——
规则用它的 glob 匹配字符串化后的 input，因此 env 的名字与取值也是规则可以匹配的文本。
拒绝意味着进程从未启动，而工作目录可以在 Session`cwd` 之内收窄，
但绝不能移到它之外。

`s.on('permission')` 是一个**只读通知**（可观测性）。
策略是唯一的应答路径——事件处理器与策略之间没有竞态。

---

## 6. TranscriptStore —— 可插拔，三个内置实现

```ts
interface TranscriptStore {
  append(e: TranscriptEvent): Promise<void>;
  read(sessionId: string, opts?: { fromSeq?: number; toSeq?: number }):
    AsyncIterable<TranscriptEvent>;
  sessions(filter?: SessionFilter): Promise<SessionMeta[]>;
  digest(sessionId: string): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
  digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: DigestOptions): Promise<TranscriptDigest | StructuredDigest>;
  delete(sessionId: string): Promise<void>;
}

jsonlStore(dir: string)              // default; one JSONL + derived metadata sidecar per session
sqliteStore(path: string)            // node:sqlite (Node ≥22, zero external deps)
memoryStore()                        // in-process only; nothing written to disk
```

`format: 'structured'` 返回按时间顺序的同角色连续段。
用相同的边界与截断策略调用 `renderStructuredDigest(digest, opts)`
可复现等价的规范文本（角色前缀、工具标签，以及至多一个截断标记）。
`maxTokens` 使用 `ceil(UTF-8 字节数 / 4)`；新的有界路径取 `maxChars` 与
`maxTokens * 4` 字节中较小者。默认的 `digest(sessionId)` 仍为 text/tail，
以保持 resume 兼容。确切的标记与兼容性语义由
[决策 026](decisions/026-handoff-digest-contract.md)冻结。

三个导出构成同一套摘要工具：`estimateTokens(text)` 按 `ceil(UTF-8 字节数 / 4)`
估算 token——与 `maxTokens` 同一口径，宿主应按它做预算，而不是自己再实现一个
不同的估算；`renderDigestSegments(segments, opts)` 渲染任意 segment 序列；
`renderStructuredDigest(digest, opts)` 则在其上是带边界与截断标记的规范文本
完整复现。

分工：

- **jsonl = 交换/审计格式。** Transcript 读取是流式的，清单使用一个带大小校验、
  可自动修复的元数据旁车文件；`.jsonl` 文件仍是权威。`export` 始终输出 jsonl；
  Store 迁移经由它进行。可 tail、对 git 友好、零依赖。
- **sqlite = 查询格式。** 跨 Session 搜索、用量聚合、无需扫描目录的 `sessions(filter)`。
  `digest()` 可以增量物化。
- **memory = 有意不持久。** 持久化无法被关掉—— Store 对 `sessions()` 与 resume 是权威，
  因此省略 `store` 意味着“把 JSONL 写进 cwd”，而不是“什么都不留”。
  `memoryStore()` 是显式的“什么都不留”：测试、嵌入式宿主与短命桥接可以获得完整契约
  而不触碰文件系统。它无界且从不驱逐（静默丢事件的 Store 会破坏 resume），
  它随进程一起消亡，而 `sessions()` 需要对它持有的全部内容做一次遍历。
  resume 在创建该 Transcript 的那次运行内有效，之后无效。

行为相同，性能不同。三者都通过同一套 Store 一致性套件。
缺失的 Session / Transcript 以 `NotFoundError` 拒绝；其他任何后端失败以
`StoreError{operation,cause}` 拒绝。内置实现包装它们的原生失败，
自定义 Store 必须遵循同样的类型化错误契约。
core 还会在未知的自定义 Store 错误跨越 Hub 或 Session API 边界时防御性地包装它。

### 6.1 保留策略 —— 刻意没有

没有任何内置 Store 会过期、轮转、压实或设上限，默认情况下也永远不会。
Transcript 是 `hub.sessions()` 所列出的东西，也是 resume 链据以重建的东西，
因此任何自动过期都会悄悄截断恰恰最需要 resume 的那些长命 Session ——
其失败会表现为 Engine “忘记”了一次对话，离病因很远。

因此保留是宿主的职责，而删除永远是显式的。长期运行的宿主必须为一个后果做规划：
**只要宿主持续追加，Store 就会无界增长。** 一个写入 jsonl 或 sqlite 的 1–24 小时
任务集群会写满磁盘；同一个集群在 `memoryStore()` 上会写满堆并把进程拖垮。

删除经由 Store 而不是 Hub：`hub.transcripts` 按设计是只读的（§4），
因此想让 Transcript 过期的宿主要构造自己的 Store、保留该引用，并在其上调用
`TranscriptStore.delete(sessionId)`。挑一个策略——按年龄、按 Session 数、按已完成状态
——并由 `hub.sessions(filter)` 驱动它，其 `SessionMeta` 正是为此携带 `status`、
`createdAt` 与 `updatedAt`。库不会替你猜一个。

---

## 7. Resume —— 模拟实现，三层降级

`hub.session({ engine, cwd, resume: id })` 按顺序解析
（`SessionOpts` 仍要求 `engine` 与 `cwd`）：

1.`session/resume`（Engine Capability）—— 原生续接。2.`session/load`（Engine Capability）—— 历史重放。3. ** Transcript 摘要重建** —— runskein 压缩已 Store 的 Transcript （`store.digest()`），
并把它作为一个全新 Session 的开场上下文注入。

除了 `session.resumeTier: 'native' | 'load' | 'rebuilt'`（可观测性）之外，
消费者无法分辨走的是哪一层。第 3 层意味着**每个 Engine 都能 resume**，
包括那些零持久化的。Session 身份在重建中存活：runskein 的 `sessionId` 是稳定的；
Engine 原生 Session id 只是内部账目。

---

## 8. Capability 矩阵（v1）

| Capability                              | 层级                                | 说明                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn / quit / health / 崩溃重启        | **Core**（库）                      | ACP 不覆盖进程生命周期；runskein 覆盖；清单与健康读取是异步的                                                                                                                                 |
| session new / prompt / cancel           | **Core**（Engine）                  | 一致性门禁——不通过 = 不可注册                                                                                                                                                                 |
| session close                           | **Core**（API）/ Negotiated（线路） | `s.close()` 有保证；缺少 `session/close` 时降级为本地释放 + 正常进程回收                                                                                                                      |
| session discard                         | Negotiated                          | `s.close({discard:true})` 需要 `session/delete`；不支持删除时在本地关闭之后显式失败                                                                                                           |
| 流式更新（text / thinking / tool_call） | **Core**                            | 一致性门禁                                                                                                                                                                                    |
| 权限转发                                | **Core**                            | 默认由 `allowAll` 自动应答                                                                                                                                                                    |
| **resume**                              | **Emulated**                        | 三层链（§7）；始终可用                                                                                                                                                                        |
| **用量核算**                            | **Emulated**                        | 有上报时透传；缺席字段绝不伪造；Engine 的 Adapter 声明其核算数据所在之处（决策 033）；回合值在任何 Engine 上都表示本回合                                                                      |
| session list                            | **Emulated**                        | 本地 Store 权威；Engine`session/list` 作交叉核对                                                                                                                                              |
| describe（模型 / 模式 / 思考层级）      | **Emulated**                        | 实时探测 > Adapter configHints；`source` 标记可信度；模型来自 `models` 和/或 configOptions                                                                                                    |
| fork                                    | Negotiated                          | 缺席时 `NotSupportedError`（模拟推迟到 v2）                                                                                                                                                   |
| setConfig / 运行时切换模型              | Negotiated                          | 视表面而定：`session/set_config_option`、`session/set_mode` 或 `session/set_model`（§3）                                                                                                      |
| 提问 / elicitation                      | Negotiated                          | 没有该 Capability 的 Engine 干脆从不发出                                                                                                                                                      |
| plan / todo 流                          | Negotiated（只读透传）              |                                                                                                                                                                                               |
| 多模态 prompt（图像）                   | Negotiated                          | 通过 `promptCapabilities` 探测                                                                                                                                                                |
| terminal 流                             | Negotiated（只读透传）              | agent 侧终端表现为 tool_call 内容                                                                                                                                                             |
| 替 Engine 运行命令                      | **Core**（库）                      | 已实现客户端侧 `terminal/*`（决策 029）：以 `tool: 'terminal'` 受权限门控、限制在 Session cwd 内、关闭时释放。kimi 需要它；claude-code 在被提供时使用它；opencode/codex/pi 在自己的进程里执行 |
| fs/read_text_file、fs/write_text_file   | **v1 范围之外**                     | 无头 agent 自行读盘；避免沙箱语义                                                                                                                                                             |
| 自动 Engine 路由                        | **v1 范围之外**                     | 仅支持显式选择                                                                                                                                                                                |

---

## 9. Adapter

每个 Engine Adapter 位于**自己的目录**中并被**自动发现**；
新增 Engine 时 core 与消费者都无需改动。发现的分层、优先级，以及它们划出的
信任边界，见 [adapter-guide.md](adapter-guide.md)。

```ts
interface EngineAdapter {
  specVersion: 1; // adapter-spec version; gate for loading
  id: string; // === directory basename after an optional runskein-adapter- prefix; unique
  launch: {
    command: string; // e.g. 'kimi'
    args?: string[]; // e.g. ['acp']
    env?: Record<string, string>; // applied AFTER core's env scrub; one entry
    // per name, compared without case (decision 042)
    startTimeoutMs?: number; // npx wrappers need generous budgets
  };
  supervise?: boolean; // launch behind a parent-death watchdog (default false)
  shim?: string; // entry point for engines that don't speak ACP; absolute, or
  // relative to the adapter directory it may not escape (see decision 028)
  detect?: () => Promise<DetectResult>; // installed? version? authenticated?
  configHints?: ConfigSchema; // static fallback for describe()
  /** Config the engine accepts only while the session is being created. */
  creationConfig?: Record<
    string,
    { meta: string[]; values: Record<string, string | number | boolean>; description?: string }
  >;
  envScrubExtra?: RegExp[]; // this engine's own session markers; core declares none
  errorPatterns?: Array<{
    cause: 'auth' | 'rate-limit' | 'context' | 'internal';
    match: string; // RegExp source; compiled case-insensitively by default
    flags?: string;
  }>;
  usage?: UsageMapping; // where this engine's usage accounting lives; absent = the default below
}

interface UsageMapping {
  source:
    | { kind: 'usage_update' } // token-bearing usage_update notification
    | { kind: 'prompt_response_meta'; path: string[] }; // object keys into the prompt response, e.g. ['_meta','quota','token_count']
  tokens?: Partial<
    Record<'input' | 'output' | 'total' | 'uncached' | 'cacheRead' | 'cacheCreation' | 'thought', string[]>
  >; // extra engine field names, tried BEFORE the built-in aliases; additive only
  semantics: 'cumulative' | 'per-turn';
}

interface DetectResult {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  loginHint?: string;
}
```

`creationConfig`（由决策
[032](decisions/032-config-uniform-at-creation-described-at-runtime.md)引入；
`describe()` 将其报告为 `settable: 'creation'`）声明 Engine 只在 Session 创建请求上
接受的设置。它的键是 **runskein 配置键**（`reasoning`、`model`……），绝不是
Engine 原生名称；每个 `meta` 是该值在创建请求 `_meta` 对象内的投递路径；
`values` 把 runskein 的档位映射到 Engine 期望的值，因为"high 是什么意思"是 Adapter 的
知识、不是 core 的。

`usage`（决策 [033](decisions/033-usage-mapping-adapter-declared.md)）是
与 `errorPatterns` 并列的纯数据：core 对它只运行一个解释器，绝不分支 Engine id。
什么都不声明就是声明前的原行为
`{ source: { kind: 'usage_update' }, semantics: 'cumulative' }`。声明的别名
扩展——而非替换——内置 token 表，先命中先赢。`{ kind: 'usage_update' }` 与
`semantics: 'per-turn'` 的组合在加载时即被拒绝（重放按原样 Store Engine 发来的更新，
无法表达逐回合数值）；这类 Engine 请在 shim 中适配。声明的 `prompt_response_meta`
来源对 token 是**独占**的——该 Engine 的 `usage_update`token 折叠被停用，而成本
仍然从每条 `usage_update` 读取。格式错误的声明在加载时未过 schema 校验
（`health: 'invalid'`）。

随 `runskein` 元包静态导入的内置 Adapter 始终会被注册。
在 `discovery: true` 时，解析过程随后扫描工作区的 `adapters/*` 与
`.runskein/adapters/*`，接着是带有 `runskein.adapter` 标记的已安装 `runskein-adapter-*` 包。
每个以目录为载体的候选都使用同一条身份规则（决策
[040](decisions/040-installed-adapter-identity-accepts-the-publishing-prefix.md)）：
`id` 必须直接等于目录 basename，或等于从 basename 中剥去精确前缀
`runskein-adapter-` 后的部分。候选会经过 schema 校验并做失败隔离（坏掉的 Adapter
表现为 `health: 'invalid'` 加 `error`，绝不会让 hub 崩溃）。动态发现默认关闭，
因为导入一个 Adapter 会以宿主权限执行代码；只对可信位置启用它。
显式的 `adapters` 按 `id` 覆盖更低层级。

内置 Adapter （`runskein` 元包还将这一组导出为只读数组 `builtinAdapters`，
供偏好显式装配的宿主通过 `createHub({ adapters: [...] })` 复用——其内容
就是下表）：

| id            | 启动方式                                    | ACP 来源                                |
| ------------- | ------------------------------------------- | --------------------------------------- |
| `opencode`    | `opencode acp`                              | 原生内置                                |
| `kimi`        | `kimi acp`                                  | 原生内置                                |
| `claude-code` | `npx @agentclientprotocol/claude-agent-acp` | ACP 组织的包装器                        |
| `codex`       | `npx @agentclientprotocol/codex-acp`        | ACP 组织的包装器                        |
| `pi`          | `pi --mode rpc`，位于 shim 之后             | runskein shim（`adapters/pi/shim.mjs`） |

前四个无需 shim。`pi` 完全不说 ACP，也正是 shim 机制存在的那个 Engine：
一个小小的独立进程，在 stdio 上说 ACP，在另一侧说 Engine 的私有协议，
于是 core 只保留一条代码路径，并且永远不必知道某个 Engine 的名字。
边界为什么划在那里见[决策 028](decisions/028-non-acp-engines-via-shim.md)，
可用的范例见 `adapters/pi/`。

### 9.1 注册门禁

一个 Adapter 可注册，当且仅当它通过**一致性套件**（`packages/conformance`）：
initialize → session/new → prompt → 更新流 → cancel →`s.close()` 语义，
外加 §8 中的 Core 各行。线路级的 `session/close` 是可选的，
作为协商 Capability 测试，而不是 Core 注册要求。由测试而非评审来强制执行。

在这一切运行之前，候选者会先被校验：一个含义无法唯一确定的 Adapter 声明根本不会加载，
`hub.engines()` 会把它报为一条带着理由的 `InvalidEngineInfo`，而不是让它先注册、
然后在不同宿主上表现不同。`launch.env` 把同一个变量写两遍——`PATH_EXTRA` 和
`Path_Extra`，在 Windows 上会被解析成一个——就是这样被拒绝的，并且在所有平台上都拒绝，
因为被拒绝的是这种对宿主的依赖本身，而不是某一个宿主对它的解读。见
[决策 042](decisions/042-a-launch-environment-names-each-variable-once.md)。

---

## 10. 错误

```ts
class NotSupportedError    // Negotiated capability absent; carries { engineId, capability }
class NotInstalledError    // detect() failed
class UnauthenticatedError // carries the engine's login hint and optional raw/aggregate cause
class NotFoundError        // local session/transcript absent; carries { resource, resourceId }
class EngineStartError     // failed before ready; carries { stage: spawn|initialize|timeout, cause? }
class StoreError           // transcript backend failed; carries { operation, cause }
class EngineCrashError     // process died mid-turn; carries restart info + last seq
class CancelledError       // prompt never completed: queued cancellation or active/queued close
class ConfigError          // invalid config key/value; carries valid options
class EngineOperationError // post-ready ACP operation failed; carries { operation, kind?, cause? }
```

所有 Engine 作用域的错误都携带 `engineId`，并在相关时携带 `sessionId`。
仅 Store 相关的 `NotFoundError` 与 `StoreError` 在已知时携带这些字段，且绝不伪造。
没有任何错误会被吞成静默的空操作。`NotFoundError.resource` 为 `'session'` 或
`'transcript'`；未知的 Engine id 仍是 `NotInstalledError`。

对于就绪之后的失败，core 只按声明顺序，用所选 Adapter 声明的 `errorPatterns`
去匹配 Engine 消息及其 cause 链。**把 `rate-limit` 声明在 `auth` 之前。**
先匹配者胜，而 Engine 完全可能把一次限流写成认证问题 —— kimi 无论何种原因，
都会给上游的拒绝加上 `Authentication required:` 前缀，于是额度耗尽抵达时是
`Authentication required: 403 You've reached your weekly (7-day) usage limit…`
（实测于 2026-08-31），声明在前的 auth 模式会把它认领走。这不是消费方绕得开的错标：
auth 那条路会让缓存的登录状态失效、把该 Engine 上每一个 live Session 判为崩溃、
并回收其进程 —— 而这次失败本会自行恢复。pi 则把同一情形表达为它自己的轮次错误 ——
`Internal error: pi ended the turn with an error: 429 status code (no body)`
（实测于 2026-08-25）—— 那是 cause 链上的普通错误，不是通知。
每一条模式都取自实测文案，且留得足够长，不至于把仅仅提到某个上限或某个数字的句子
也认领走。**当同一情形被实测到不止一次时，模式锚定在这些负载的共同部分**，
而不是其中任何一份的片段（决策 044）：第一版声明落地六天后，kimi 改写了消息，
一次编辑就打断了它的两个片段，把额度耗尽重新送回 auth 那条路；因此 kimi 现在声明
四个锚点，分散在情形描述与补救指引两处。pi 只有一份实测负载，在第二份被捕获之前
保持单一片段。若一次改写打断了全部锚点，失败仍会退回它原先所走的那条路；
究竟是哪一种，只会在现场暴露，不会在测试里暴露。它会落到哪里，取决于排在后面的
`auth` 模式有多宽——这正是要把那一条写窄的理由：kimi 的是它给所有消息都加的通配前缀
`Authentication required`，因此一条失效的 `rate-limit` 模式会把额度耗尽直接送去拆除；
而 pi 的是具体的 `credentials_not_configured`，同样的失效只会让 `kind` 缺席而已。
尚未实测过限流负载的 Adapter（今天是 codex、opencode、claude-code）干脆不声明
`rate-limit` 模式：`kind` 缺席是诚实的，猜一个则不是。`auth` 变成 `UnauthenticatedError`；
`rate-limit`、`context` 与 `internal` 把 `EngineOperationError.kind` 分别设为
`'rate-limit'`、`'context-exceeded'` 与 `'internal'`。runskein 自有的请求超时把它设为
`'timeout'`，与 Adapter 模式无关。没有匹配则 `kind` 缺席。
一次匹配到的运行中认证失败会发出 `engine:unauthenticated`，
使缓存的 detect 结果失效直到 `hub.rescan()`，
并让当前 Engine 进程退役，以便重新登录后的恢复从头开始。
确切细节冻结于
[决策 025](decisions/025-failure-taxonomy-and-auth-recovery.md)。

---

## 附录 A —— 决策日志

| #   | 决策                                                                                                                    | 理由                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | ACP 作为内部脊梁，绝不暴露                                                                                              | 吸收协议变动；复用词汇（ToolKind/plan/ContentBlock/locations）而不发明第二套                                                          |
| D2  | 信封（`seq`/`ts`/`engineId`）是 runskein 自有的                                                                         | ACP 通知缺少来源/排序；审计流需要它们（在一个审计流消费者上得到的教训）                                                               |
| D3  | 没有 `auto`Engine 选择                                                                                                  | 路由是消费者策略                                                                                                                      |
| D4  | 单一 `PermissionPolicy` 函数；bypass/ask 只是它的实例                                                                   | 一条应答路径，不做模式切分，没有事件/策略竞态                                                                                         |
| D5  | `TranscriptStore` 接口 + jsonl 与 sqlite 内置实现                                                                       | jsonl = 交换，sqlite = 查询；格式就是 API                                                                                             |
| D6  | resume 是 Emulated 的，带三层降级                                                                                       | 在参差不齐的 Engine Capability 之上，这是最大的统一收益                                                                               |
| D7  | runskein 自有的 `Usage`；忽略 ACP 那个 UNSTABLE 的                                                                      | 成本核算至关重要，不要建立在实验性类型之上                                                                                            |
| D8  | Adapter 是可发现的、每目录一个的包；一致性是门禁                                                                        | 新增 Engine：core/客户端零改动，由测试强制                                                                                            |
| D9  | v1 跳过客户端 fs 方法；terminal 方法后来加入                                                                            | 无头优先，且 fs 仍然回避沙箱语义。terminal 那一半被决策 029 推翻：kimi 把命令执行委托给客户端，拒绝它会让该 Engine 失去每一个命令工具 |
| D10 | Engine 清单与健康读取是异步的，并包含 `stopped`/invalid 变体                                                            | `detect()` 是异步的；进程不存在不等于失败；畸形候选无法满足已注册 Engine 的字段（决策 003）                                           |
| D11 | 缺失的本地状态、Store 失败与就绪前的启动失败各有不同的类型化错误                                                        | 避免通用错误，并让恢复决策不含糊（决策 004）                                                                                          |
| D12 | 就绪后的 ACP 失败使用 `EngineOperationError`；用量 token 字段是可选的                                                   | 保持每个错误都有类型，并区分“未上报”与“实测为零”（决策 006）                                                                          |
| D13 | 模型选择是它自己的表面：`describe().models` 用 `session/set_model` 写入；当 Engine 两处都发布时，模型配置项优先         | Engine 把模型选择与 configOptions 分开发布；只读 configOptions 会让一个可设置的模型看起来不受支持（决策 009）                         |
| D14 | `memoryStore()` 是第三个公开内置实现；默认没有任何 Store 做保留或设上限                                                 | 持久化此前无法关闭，而自动过期会静默破坏 resume（决策 011）                                                                           |
| D15 | `ConfigOption.settable` 说明一个键何时可写；`session({config})` 把仅限创建的键带在创建请求上，而 `setConfig()` 拒绝它们 | 有些 Engine 只在构建 Session 期间接受某项设置；统一接口并把差异描述出来而不是藏起来（决策 032）                                       |

---

## 附录 B —— 协议词汇类型

`ContentBlock`、`SessionUpdate`、`ToolKind`、`ToolCallLocation`、
`PermissionOption` 与 `McpServerConfig` 由 `runskein` 导出，
它们是 runskein 自有的声明，从锁定的 ACP v1 schema 生成。
同一次生成还会产出 `ToolCallUpdate`、`ToolCallContent`、`ToolCallStatus`、
`PlanEntry`、`PermissionOptionKind` 与 `Annotations`，它们遵循同样的规则。
它们保留 ACP 的判别式与 `_meta` 扩展点，因此消费者无需转换即可渲染该词汇，
但它们不导入也不再导出 `@agentclientprotocol/sdk` 的类型。
它们生成的声明就是详尽的真相来源；改动它们就是一次 runskein API 变更，
即便变更是由一次 ACP 升级引起的。
