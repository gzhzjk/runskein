<!--
source: docs/capability-matrix.md
source-sha256: 7dd44cad41c807c689176d1adfc63e71caf698669de4c4745e34145d48bd15a3
-->

# 能力矩阵

每个内置 Engine 实际能做什么，以及每项特性落在三个能力层级的哪一层。这里刻意把两
件事叠在一起：层级告诉你这个库_承诺_什么，Measured 列告诉你 Engine 在最近一次探测
里_做到_了什么。只有承诺、没有测量，能力表就是这么烂掉的。

**生成物。** Measured 单元格与整张内置支持表，都是由
`node scripts/generate-capability-tables.mjs` 从
[`conformance/matrix.public.json`](conformance/matrix.public.json) 渲染出来的，而
`pnpm quality` 会在文档与矩阵漂移时失败。`<!-- generated:… -->` 标记之间的任何内容
都不要手改。Capability、Tier 与 API 三列属于判断而非测量，由人工维护。

**生成块保持英文。** 它们是测量输出，不是散文——与 `matrix.public.json` 不翻译、
代码块不翻译是同一个道理。符号的含义在下面的图例里，读表不需要先读英文。

**这是快照，不是兼容性承诺。** 矩阵记录的是每个 Engine 的某一个版本在某一次探测中
所宣告的东西；每个 Engine 被测到的版本在下面的内置支持表里。想知道_你自己_那台机器
上有什么，调用 `hub.engines()` 与 `hub.describe()`——那才是运行时的事实，也是程序
该据以分支的东西。

## 图例

**层级** —— **Core**：有保证，在每个 Engine 上都由 Conformance 门禁把关 ·
**Negotiated**：Engine 有就透传，没有就抛出带类型的 `NotSupportedError`，绝不静默
丢弃 · **Emulated**：由这个库补上缺口，所以它始终可用。

**Measured 符号** —— `✓` 已宣告且已观察到 · `✗` 探测过且明确不支持 · `—` 该 wire
能力不存在或从未被宣告。`✅` 标记的是 Core 行：每个内置 Engine 都通过同一道门禁，
没有可区分的余地。

## Session 生命周期

<!-- generated:lifecycle-capabilities -->
<!-- prettier-ignore -->
| Capability            | Tier                           | API                                                | Measured (oc·ki·cl·cx·pi)                                                                                                                 |
| --------------------- | ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------              |
| New session           | Core                           | `hub.session()`                                    | ✅ ✅ ✅ ✅ ✅                                                                                                                                 |
| Prompt (turn promise) | Core                           | `s.prompt()` → `TurnResult`                        | ✅ ✅ ✅ ✅ ✅ · all `end_turn`                                                                                                                |
| Cancel active turn    | Core                           | `s.cancel()`                                       | active prompt resolves `stopReason:'cancelled'`; queued prompts reject `CancelledError`; every bundled engine advertises `session/cancel` |
| Streaming updates     | Core                           | `s.on('update')`                                   | ✅ ✅ ✅ ✅ ✅                                                                                                                                 |
| Close session         | Core (API) / Negotiated (wire) | `s.close()`                                        | ✓ · ✓ · ✓ · ✓ · ✓                                                                                                                         |
| **Resume**            | **Emulated**                   | `hub.session({engine,cwd,resume})`, `s.resumeTier` | native `session/resume`: ✓ ✓ ✓ ✓ ✓                                                                                                        |
| Load (history replay) | Negotiated (resume tier 2)     | internal                                           | `loadSession`: ✓ ✓ ✓ ✓ ✓                                                                                                                  |
| Fork                  | Negotiated                     | `s.fork()`                                         | ✓ · ✓ · ✓ · — · ✓                                                                                                                         |
| List sessions         | Emulated                       | `hub.sessions()`                                   | wire `session/list`: ✓ ✓ ✓ ✓ ✗                                                                                                            |
| Attach                | Emulated                       | `hub.attach(id)`                                   | store-backed; independent of engine                                                                                                       |

<!-- /generated:lifecycle-capabilities -->

上表 Measured 列的补充：缺少 wire `session/close` 时会降级为本地释放，进程回收不受
影响；原生 resume 今天覆盖全部内置 Engine，第 2、3 层是保险；列举 Session 以本地
Session 存储为准，有宣告的地方用 wire `session/list` 交叉核对；fork 在 0.33.0 版本
到达 kimi。

### Resume 降级链

```
hub.session({ engine, cwd, resume: id })
  1. native   engine session/resume        (every bundled engine supports it today)
  2. load     engine session/load          (history replay)
  3. rebuilt  store.digest(id) → injected as opening context of a fresh session
```

RunSkein 的 `sessionId` 在三层之间保持稳定；`s.resumeTier:
'native'|'load'|'rebuilt'` 是唯一可观察到的差别。第 3 层正是**每个 Engine 都能
resume** 的原因——包括将来某个完全没有持久化的 Engine。

## 对话特性

<!-- generated:conversation-capabilities -->
<!-- prettier-ignore -->
| Capability                         | Tier                                | API                                     | Measured                                                                                                                                        |
| ---------------------------------- | ----------------------------------- | --------------------------------------- | -----------------------------------------------------------------------------------------------                                                 |
| Text out (chunks)                  | Core                                | `update: agent_message_chunk`           | ✅×5                                                                                                                                             |
| Thinking out                       | Core (pass-through)                 | `agent_thought_chunk`                   | streamed by opencode, kimi and codex; claude-code streams none at any thought level — see the note below                                        |
| Tool calls (kind/status/locations) | Core (pass-through)                 | `tool_call` / `tool_call_update`        | ACP ToolKind: read/edit/execute/…                                                                                                               |
| Diffs                              | Negotiated (pass-through)           | `ToolCallContent.diff`                  |                                                                                                                                                 |
| Plan / todo stream                 | Negotiated (pass-through)           | `plan` / `plan_update` / `plan_removed` |                                                                                                                                                 |
| Multimodal prompt                  | Negotiated                          | `s.prompt(ContentBlock[])`              | `promptCapabilities.image`: true on oc·ki·cl·cx, false on pi; ki·pi additionally report `audio: false`                                          |
| Questions / elicitation            | Negotiated                          | `s.on('question')` + `s.respond()`      | engines without it simply never emit                                                                                                            |
| Terminal stream                    | Negotiated (read-only pass-through) | inside tool_call content                | client-side `terminal/*` methods **implemented** (decision 029): permission-gated on command, args, cwd and env; cwd contained by resolved path |
| Available commands                 | Negotiated (pass-through)           | `available_commands_update`             | not observed on pi                                                                                                                              |

<!-- /generated:conversation-capabilities -->

## 内置 Engine 支持

同一份矩阵，按 Engine 读而不是按能力读——每个内置 Engine 在被探测的那个版本上宣告
了哪些 wire 能力。

<!-- generated:builtin-support -->
<!-- prettier-ignore -->
| Engine      | Measured version | Native resume | Load | Fork | List | Delete | Image input | MCP HTTP | MCP SSE | Providers | Token usage |
| ----------- | ---------------- | ------------- | ---- | ---- | ---- | ------ | ----------- | -------- | ------- | --------- | ----------- |
| OpenCode    | 1.18.25          | ✓             | ✓    | ✓    | ✓    | —      | ✓           | ✓        | ✓       | ✗         | ✓           |
| Kimi Code   | 0.38.0           | ✓             | ✓    | ✓    | ✓    | ✓      | ✓           | ✓        | ✓       | ✗         | ✗           |
| Claude Code | 0.70.0           | ✓             | ✓    | ✓    | ✓    | ✓      | ✓           | ✓        | ✓       | ✓         | ✓           |
| Codex       | 1.7.0            | ✓             | ✓    | —    | ✓    | ✓      | ✓           | ✓        | ✗       | ✓         | ✓           |
| pi          | 0.84.2 (shim 1)  | ✓             | ✓    | ✓    | ✗    | ✗      | ✗           | ✗        | ✗       | ✗         | ✓           |

<!-- /generated:builtin-support -->

**Thinking out，以及提高 thought level 到底买到了什么。** 一个 Engine 会不会
_流式输出_思考，和它会不会_真的多想_，是两个不同的问题，而且逐 Engine 的答案不一样。
除 pi 外，每个 Engine 都公布了 thought level，但只有一部分让你看得见结果——而且被钉死
的模型可能会收窄它真正接受的层级，所以在你自己机器上跑 `hub.describe()` 胜过这张表：

| Engine      | 公布 thought level | 流式输出思考文本 | 报告 `usage.thought` | 提高层级后可见于        |
| ----------- | ------------------ | ---------------- | -------------------- | ----------------------- |
| opencode    | 是                 | 是               | 是                   | 两者皆可                |
| kimi        | 是                 | 是               | 否                   | 流式文本                |
| codex       | 是                 | 是，但并非总是   | 是                   | thought token           |
| claude-code | 是                 | 否               | 否                   | runskein 无法呈现的任何 |
| pi          | 否                 | 否               | 否                   | —                       |

出处：thought token 那一列取自各 Engine 矩阵条目的 `usage.fields`；是否公布
thought level 取自 2026-08-31 对 `hub.describe()` 的读取；流式输出那一列取自同日的
实测运行（案例 CF-06、CF-10、PV-02）——kimi 那一格除外，该账号配额已耗尽，跑不了
实测 turn，因此沿用矩阵中更早的实测值。

claude-code 的 ACP 包装器只在思考文本非空时才发出 thought chunk，而近期的 Claude
模型会省略该文本，于是一个花了数千 token 思考的 turn 到达时是一片寂静。**不要把缺失的
`agent_thought_chunk` 读作「模型没有思考」。** 这些工作是真实的——它计费在该 turn 的
output token 里，实测套件也正是在那里测量它（案例 CF-10）——但 Anthropic 并不把它单独
拆出来，所以这个 Engine 永远不会有 `usage.thought` 到达你手里。要渲染思考面板的宿主
应当按 Engine 分支，而不是假定每个 Engine 都会填充它。

**Token usage** 的含义是：探测确实从那个 Engine 的 wire 上读到了真实的 token 数字
——它矩阵条目里的 `usage.fields` 列表非空，于是这些数字能到达 `TurnResult.usage` 与
`session.usage()`。`TurnResult.usage` 描述的是已完成的那一个 turn，而
`session.usage()` 是该 RunSkein Session 的累计值。像 `{used, size}` 这样单纯的
上下文窗口计量不算 token usage，也绝不会被折算成 token 估计值。

矩阵条目里还有一个 `usage.ok`，那是一个更严格、也不同的标志：只有当 Adapter
_声明_了 usage 来源、且该声明解析成功时它才为 true。一个 Engine 可以在什么都没声明
的情况下报出可用的 token，因为 core 默认就会用内建字段名去读 `usage_update`。pi 正
是这种情况——`usage.ok: false` 而 `usage.fields` 有内容——所以它在这一列是 `✓`。
想知道消费者能拿到什么，读 `usage.fields`；想知道 Adapter 有没有把来源钉死，读
`usage.ok`。

即使某个 Engine 没有原生机制，resume 在 RunSkein 这一层依然可用，靠的是上面那条
三层链。如果这个区别对你的应用有意义，检查 `session.resumeTier`。

## 其余内容在哪里

- [`engine-support.md`](engine-support.md) —— 怎么选 Engine、归一化的能力键是什么
  意思，以及运行时怎么读它们。
- [`engine-adapter-api.md`](engine-adapter-api.md) —— 这些能力所经由的、已冻结的
  v1 API 面，包括一个 Negotiated 能力缺席时抛出的确切错误类型。
