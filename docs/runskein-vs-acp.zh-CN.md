<!--
source: docs/runskein-vs-acp.md
source-sha256: 8b2186c3a0f2ecddc9b8c4710de2bd6d33a1d992543a375f96c6e3801e3ade4e
-->

# runskein 与 ACP 对比

[Agent Client Protocol (ACP)](https://agentclientprotocol.com)规定一个 client
与一个 agent 进程如何通信。它完全不涉及该进程从何而来、进程崩溃后怎么办、
如何让五个彼此不一致的 Engine 看起来相同，或把对话保存在哪里。

runskein 正是回答这些问题的那一层。底层仍是同一种协议，但你得到的是进程管理、
跨 Engine 共享的一套 API、保存的 transcript、resume、权限，以及类型化错误，
而不是原始 JSON-RPC 故障。

## 完整对比

|                 | ACP 提供什么                              | 你仍需自行构建                                                           | runskein 提供什么                                                                                                                                           |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程            | 什么都没有——由你启动                      | 启动、退出、崩溃后重启、引用计数、空闲释放、宿主自身死亡后的孤儿进程清理 | 全部这些，外加经过实测而非猜测的环境清洗：从 Claude Code Session 内启动 Engine 会泄漏 `CLAUDE*` 标记，导致 Claude Code 的 ACP 包装器拒绝启动                |
| 多个 Engine     | 每个 agent 一条连接                       | 在各不相同的 Engine 之上提供一套 API；不说 ACP 的 Engine 根本无法加入    | 一套 API；即使 pi 不说 ACP，`engine: 'pi'` 的写法也与 `engine: 'codex'` 相同                                                                                |
| 设置            | 各 Engine 自己的键                        | 你自己的映射表                                                           | 每项一个统一名称：OpenCode 用 `effort`、Kimi 用 `thinking`、Codex 用 `reasoning_effort`、Claude Code 使用创建时的思考预算——你只需写 `config: { reasoning }` |
| Capability 缺口 | `initialize` 中的 boolean                 | 逐个缺口决定应该失败、Emulated 还是降级                                  | 三个层级，所以缺口是你可以选择的一条分支，绝不是一次悄无声息地什么都没做的调用                                                                              |
| Resume          | `session/load`、不稳定的 `session/resume` | Engine 两者都没有时的回退链，以及一个经历回退仍保持不变的 id             | native → load → transcript rebuild，并由 `session.resumeTier` 指明所走路径                                                                                  |
| 记录            | 一条事件流                                | 存储、排序、重放、导出、摘要                                             | 保存的 transcript，它是列表与 resume 的权威                                                                                                                 |
| 权限            | 一次请求与响应                            | 一套策略机制，以及 Engine 没有审批协议时的处理方式                       | 逐 Session 策略，内置 `policies.allowAll`、`policies.denyAll` 与 `policies.rules` 表                                                                        |
| 失败            | 一个 JSON-RPC 错误                        | 区分登录过期、额度、崩溃与取消                                           | 类型化错误，携带登录命令、最后保存的序号和有效值                                                                                                            |
| 计量            | 一个上下文窗口计量值                      | 跨轮次 token 总数与成本                                                  | 逐轮次 `usage` 与持续累计的 `session.usage()`，且只取自真实 token 字段                                                                                      |
| 测试            | 什么都没有                                | 一个模拟 agent                                                           | `@runskein/testkit`——真实代码路径，不需要 Engine，也不需要 token                                                                                            |
| 渲染            | 一条原始事件流                            | 合并文本片段与 tool update                                               | `runskein/fold`，可选且独立                                                                                                                                 |

## 你为此付出的代价

ACP 被刻意置于不可触达之处。公开类型是 runskein 自己对协议的镜像，因此，runskein
尚未建模的协议功能只能通过 `_meta` passthrough 触达。这就是代价：你无需处理线路，
但在 runskein 先为某项功能建模之前，你也无法越过它直接触达该功能。

关于 runskein 不承诺的其他事项，见[限制](../README.md#limitations)。

## ACP 在代码中的位置

只有 `packages/core/src/acp/` 与 shim 入口（`adapters/*/shim.mjs`，
即不说 ACP 的 Engine 所在线路远端）可以 import `@agentclientprotocol/sdk`。
消费者能够触达的任何东西都不可以。其理由见
[决策 028](decisions/028-non-acp-engines-via-shim.md)。
