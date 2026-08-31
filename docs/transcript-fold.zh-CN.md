<!--
source: docs/transcript-fold.md
source-sha256: 053167b6ef34f941dde29db9d5b29ee4f2409342929befbe9c5ca5e29dc24773
-->

# Transcript folding —— `@runskein/fold`

`Session.on('update')` 会原样交付 Engine 的 `SessionUpdate` 流，Transcript 也会按原样
存储它。这是有意为之：更新词汇由 ACP 所有，runskein 不再另造一套，而 Transcript
则始终是无损的审计事实。但这也不是用户界面想直接消费的东西。

`@runskein/fold` 是两者之间的层。它是可选的——core 中没有任何东西依赖它——展示语义
也正是在这里落地，从而让终端、web UI 与日志阅读器对于工具行究竟_是什么_达成
一致，而不是各自重新推导。

本文是行为契约。导出的类型见 §5；可执行规范是
`packages/fold/test/contract.test.ts`。

---

## 1. 它的用途

交互式消费者需要派生出的、**面向展示的**状态：

- 将文本块归入逻辑消息流，同时不丢失内容元数据；
- 按 `toolCallId` 合并 `tool_call` 与稀疏的 `tool_call_update` patch；
- 将旧式 `plan` 与带键的 `plan_update` / `plan_removed` 状态彼此分开；
- 同时展示 ACP context-window 快照和 runskein token 计数，且不重复计数；
- 将未知或格式错误的未来 variant 作为原始数据浮现，绝不丢弃。

## 2. 在架构中的位置

```
@runskein/core     TranscriptEvent stream — verbatim, frozen (untouched)
@runskein/fold  →  FoldInput → FoldedEvent[]            (this package)
packages/cli       terminal presenter (ANSI/shared streaming line)
your own UI        your own presenter (DOM/bubbles/components)
```

硬性规则：

1. **始终位于消费者侧。** fold 只导入 core 的公开类型。Core 绝不导入 fold；store、
   digest、resume、export 与冻结的 API 均保持不变。
2. **不是 wire 或持久化词汇。** `PresentationEvent` 是 renderer model。它绝不写入
   `TranscriptStore`，也绝不替代 `SessionUpdate`。
3. **确定性，且在单个实例之外无副作用。** 没有 IO、timer、Engine 分支、callback，
   除 core 类型外也无依赖。Folder 可以改变自己的私有状态，但绝不改变输入或此前
   已发出的快照。
4. **在开放的 ingress 边界上运行时完备。** `FoldInput.update` 是 `unknown`，因为 core
   有意让未来的原始更新对象在生成的 TypeScript 跟上之前就能抵达消费者。已知 variant
   会接受最低限度的运行时形状检查；未知或格式错误的已知 variant 会发出 `raw`，
   而不是抛错或消失。

## 3. 输入顺序与生命周期

一个 `Folder` 实例会绑定到它接受的首个输入的 `sessionId` 与 `engineId`。有效的 core
流在每个 Session 内都有严格递增的 `seq`；fold 按抵达顺序处理，绝不凭空添加 reorder
buffer。

「接受」指 envelope：身份与顺序有效的输入会绑定 Folder，即使它的 update 随后变成
`raw` 也是如此。

- gap 是有效的：消费者可以从 `transcript({fromSeq})` 开始。
- 重复或递减的 `seq`、不同的 `sessionId` 或变化的 `engineId` 会发出
  `raw { reason: 'invalid-envelope' }`，且不改变 fold 状态。
- 未知或格式错误的 update 仍会关闭打开的消息流，因为它们是可观察的非 chunk 边界。
- live caller 会在 `prompt()` settle 后以及 Session 关闭时调用 `flush()`。replay caller
  则在输入结束时调用它。Transcript event 不含通用的 turn-end marker，因此 fold
  不得自行推断。
- `flush()` 是幂等的。它只结束打开的消息；tool、plan 与 usage 状态仍然可用。
  另一个 Session 必须使用新的 Folder。

由于冻结的 Transcript 没有通用的 turn-end marker，当两个 turn 含有派生 key 相同的
相邻 chunk，且中间没有 event 时，只依靠 EOF 的 replay 无法重建仅在 live 中存在的
flush 边界。只有 caller 提供相同的显式 flush schedule 时，才能保证 live/replay
消息边界一致。否则，普通 replay 仍会保留 event 顺序与 payload，但在这种退化情形下，
可能会一直合并到 EOF。

## 4. Folding 语义

### 4.1 消息流

`agent_message_chunk`、`agent_thought_chunk` 与 `user_message_chunk` 映射为
`kind: 'agent' | 'thought' | 'user'`。`messageId: null` 会被规范化为缺省。
打开的流以 `(kind, messageId)` 为 key；id 缺省时，只有 kind 构成 key。

对于有效的 text block：

1. 如果 key 与打开的流不同，先为旧流发出 `messageEnd`（以它的最后一个 chunk
   作为 source），再为新流发出 `messageStart`。
2. 为**每一个** text block 发出 `messageAppend`，包括第一个。event 携带完整的
   text block，而不只是其中的 string，因此 presenter 仍能获得 annotation 与 `_meta`。

任何非 chunk update 都会先关闭打开的流，再产生自己的输出。非 text chunk 也会关闭
打开的流，并发出带有 `kind`、规范化后的 `messageId` 及该 block 的 `content`。
role/id 不得丢弃：web UI 需要知道 image 或 resource 属于 user、agent 还是 thought 流。

如果已知 chunk envelope 的 `content` 是带有未知 string `type` 的对象，它就具备
向前兼容性，并会发出包含 `UnknownContentBlock` 的 `content`。缺失、非对象或没有
discriminator 的 `content` 是格式错误的已知 update，按 §4.5 处理。tool content
中嵌套的未知 variant 仍是 tool-row 快照的一部分。

### 4.2 Tool 行

- `tool_call` 创建一行或权威地替换一行。array 会被复制；输入对象绝不改变。
- 对未见过的 id，`tool_call_update` 会创建一个只含 `toolCallId` 的 partial row；
  这使 partial transcript 具有确定性。后来出现的完整 `tool_call` 会替换该 partial row。
- 对固定使用的 ACP v1 nullable patch field（`kind`、`status`、`title`、
  `name`、`content`、`locations`），省略与 `null` 都表示不变；具体值会替换旧值。
  `content` 与 `locations` array 是整体替换，而不是追加 delta。对 `rawInput` /
  `rawOutput`，自有 key 是否存在才是 patch signal，而 `null` 是合法的替换值。
- 每次创建或更新都会发出 `toolRow { row, changed }`。`changed` 列出该输入所提供并已
  应用的 row field，不包括 identity 与 metadata；如果重新计算使派生 `args` 值发生
  变化，也会列出该字段——按 `changed` 重绘的 presenter 必须获知派生行也变了。
  它并不表示值经深层比较后不相等。row 是 readonly snapshot，之后的 patch 不能
  改变较早的 event。
- 发出 `completed` 或 `failed` 后，移除私有 row。后来对该 id 的 update 会开始一个
  新的 partial row。这会把保留状态限制在 active tool call 以内，同时保留完整的
  terminal snapshot。
- 未知的 `ToolCallContent.type` 留在 row 内；presenter 使用其 raw fallback。

#### 4.2.1 `args` —— call 作用于什么

ACP 只要求 `toolCallId` 与 `title`；`rawInput`、`locations` 与 `content` 都是可选的，
因此 Engine 会在不同位置说明「哪个文件、哪条命令」，它们都没有错。某个下游消费者
在一台机器上对自己存储的 Transcript 做过统计：pi 的 141 次 call 全都给出了非空
`rawInput`，claude-code 是 1659 次中的 849 次，opencode 是 348 次中的 45 次，
kimi 的 920 次则一次也没有——kimi 会把 argument 作为 `content` text 逐步增长。
若将这种差异原样传下去，每个 presenter 就只能按 Engine id 分支（还会漏掉下一个
Engine），或者什么也不显示；而 `ToolRow` 已经是 fold 所有的展示类型，因此这种收敛
理应在这里完成。

`args` 是 `{ text, value?, from }`：

- `from` 始终会被报告。消费者必须能区分 Engine 陈述的内容和 fold 组装的内容；fold
  会报告来源，而不是抹平两者的差异。
- 按最明确者优先的顺序尝试 source：非空 `rawInput`，然后是第一个给出非空 path 的
  `locations` entry，最后是累积的 `content` text。空 container（`{}`、`[]`）
  和没有指出任何内容的 entry 都没有提供信息，因此会继续回退。
- `from: 'content'` 受到两重限制。首先，只在 terminal status 时读取它，因为将
  argument 作为 text 流式给出的 Engine 会逐字符增长，而每次中途读取到的都只是半份
  JSON document。其次，只有当 text 能解析为 object 或 array 时才接受——无法解析的
  content 与 tool 的_结果_ text 无法区分，而把 output 标为 input 比什么也不报告更糟。
- `text` 只按 shape 选择，绝不按 Engine 选择：从 `command`、`cmd`、`path`、
  `file_path`、`filePath`、`uri`、`url`、`pattern`、`query` 中选第一个持有非空
  string 的字段；否则选唯一一个值为 string 的 key；再否则使用紧凑 JSON。
  裸 string source 就是它自身的行，且不带 `value`。
- `args` 是派生值，绝不从 wire 读取。Engine 发来的自有 `args` field 不会设置它。

presenter 可以合并重绘，但 fold 会发出每个 patch。隐藏中间 content 增长的 presenter
仍必须在 terminal status 时重绘完整 row。

#### 4.2.2 `diffs` —— diff block 覆盖什么

一个 `diff` content block 是 `{path, oldText?, newText}`。其中没有任何内容说明这些
text 是整个文件还是其中的 fragment，因此 renderer 无法判断从 1 开始为 block
编号是否与文件自身的行号一致；而且即使在同一个 Engine 内，不同 tool 的覆盖范围也
不相同——一项针对 556 个 diff block 的下游调查发现，claude-code 的 `Write` 会发送整个
文件，而 `Edit` 发送 fragment；在 545 次中，`ToolCallLocation.line` 一次也没有
填充。这里按 Engine id 分支并非 fallback，而是错误。

`ToolRow.diffs` 按 content 顺序为每个 diff block 保存一个
`DiffCoverage { index, path, scope, startLine?, from? }`，并且只回答 Transcript
能够证明的内容：

- `from: 'created'` —— block 没有 `oldText`，所以它让文件得以存在，`newText`
  就是文件的全部内容：`wholeFile`，`startLine: 1`。
- `from: 'chained'` —— block 的 `oldText` 与同一 path 更早一个 whole-file block
  的 `newText` 完全一致，所以被替换的 text 是整个文件：`wholeFile`，
  `startLine: 1`。该 path 上任何其他 diff 都会终止 chain，因为之后文件所含内容
  已不再可知。
- 其他情况都是 `scope: 'unknown'`，且没有 `startLine`。定位 fragment 需要文件
  内容，而 fold 不做 IO——replay 的 Transcript 所对应的文件早已继续变化，因此从磁盘
  读回的数字描述的是现在，而非编辑发生的时刻。错误的行号比没有行号更糟。

消费者可以为 `wholeFile` 声称文件行号，但绝不能为 `unknown` 这样做。coverage 会随
event 抵达而派生，因此从流中途开始的 Folder 没有可据以构建的 chain，直到某个 diff
证明了某些内容。

一个 row 已经判断过的 block 会保留它的 verdict，因为 Engine 会随着 call 的进展
重新发送整个 `content` array；若重新判断，就会拿该 block 的 `oldText` 与它自己
第一次经过时记录的 text 比较，从而把已证明的 chain 变成 `unknown`。这种复用以 row
为范围：同一个 edit 跨 row 确实可能发生两次，且中间还有其他 edit；后一次会按当时的
chain 来判断。在一个 row 内，verdict 会逐一原样交回，因为一个 row 可以两次携带相同
edit，而第二份 copy 是根据第一份所留下的状态判断的。verdict 按 row 保存，因此
completed tool call 会与 row 一起释放它们。

判断自身构成一个单元，即 `createDiffCoverageJudge()`；Folder 会像其他消费者一样持有
一个。需要判断某个 path coverage、但不做 fold 的消费者，可以在不携带 message、plan
或 usage 状态的情况下得到相同 verdict，也不会出现第二份实现而发生漂移（决策 036）。
它接收完整 update 而不是 content block，因为 row 规则是判断的一部分：完整
`tool_call` 会开始一轮新的 run，且不继承 verdict；terminal status 会结束 row 并释放
其 verdict。它只接受 Folder 会应用的那些 row patch，并对没有判断任何内容的 update
返回 `undefined`——即不带 `content`，或其中没有任何 block 是可判断 diff 的 update。
将一个 Session 的每个 `tool_call` / `tool_call_update` 按 seq 顺序 push；其他任何
内容都会被忽略。

chain 保存文件 text 本身，并逐字比较。小到值得保留的 hash 只会让 `chained` 从证明
退化为可能性，而 collision 会表现成一个信心十足的错误行号。因此，保留大小是 Engine
上一次完整重写的每个文件的一份 text copy；chain 被打断的 path 会从 map 中删除。

### 4.3 Plan 状态

ACP v1 有两种不同的 shape，fold 不得混淆它们：

- `plan { entries }` 替换一个不带 key 的**旧式 plan**。
- `plan_update { plan }` 替换 `plan.planId` 处完整的带 key value。`items`、`file`
  与 `markdown` 是不同的当前表示；kind switch 会替换此前的表示，而不是保留陈旧字段。
- `plan_removed { planId }` 只移除该带 key plan。它不会移除不带 key 的旧式 plan。

每个有效 plan 输入都会发出完整的 readonly `PlanSnapshot`，并在适用时带上
`changedPlanId` 或 `removedPlanId`。entry array 会被复制；未改变的 immutable plan
value 可以结构共享。创建快照的复杂度是 O(active keyed plan 数量)；保留内存是
O(active plan state)。

### 4.4 Usage 状态

`usage_update.used` 与 `.size` 是**当前 context-window value**，而非 delta。每次 update
都会替换这两个 value。`cost` 若是具体值，则已经是累计 Session cost，并会替换此前的
cost；省略或 `null` 会让上次报告的 cost 保持不变。Fold 从不对这些 field 中的任何一个
求和，也绝不执行 currency conversion。

RunSkein token 计数是另一个通道：`TranscriptEvent.usage` 若存在，就是 core 计算出的
累计 `Usage` snapshot，并会替换此前的 token snapshot。`usageState` 会明确暴露两个
通道：

```ts
interface UsageState {
  readonly context?: Readonly<{ used: number; size: number }>;
  readonly cost?: Readonly<{ amount: number; currency: string }>;
  readonly tokens?: Readonly<Usage>;
}
```

一个 `usage_update` 会在应用 ACP field 和 envelope 中可选的 runskein usage 后发出一个
`usageState`。如果未来的有效 event 在另一种 update 上携带 `TranscriptEvent.usage`，
fold 会先发出正常 event，随后发出更新后的 `usageState`。缺失的数据保持缺失；
零保持为零。

两个通道彼此独立，`usage_update` 可以只携带其中一个。协议要求 `used`/`size`，但
runskein 会合成仅含 token 的 `usage_update`——没有 window gauge，因为从 token count
捏造一个 gauge 就是臆造——并以 `runskein.dev/syntheticUsage` `_meta` key 标记。因此
Fold 接受不带 window 的 usage_update：它会应用 event 实际携带的三个通道（window、
cost、envelope token）中的任意通道，并为结果发出一个 `usageState`。

Fold 只从 envelope 读取 token count，绝不从 update body 上 runskein 的 field name
读取。body name 让 Transcript 在 replay 时能够自描述；对于声明 token 来自其 prompt
response 的 Engine，core 有意不把它们放到 envelope 上，以确保只计数一次，而在这里读取
body 会把它们计算两次。

### 4.5 透传与格式错误的输入

- `available_commands_update`、`current_mode_update`、
  `config_option_update` 与 `session_info_update` 在最低限度的校验后发出
  `notice { update }`。
- 未知的 `sessionUpdate`、primitive/非对象 update，或 payload 格式错误的已知
  discriminant，会发出 `raw { update, reason }`。
- 「最低限度的校验」会检查 discriminant，以及 fold 为 identity 或 state 所读取的
  每个必需 primitive/container field。不透明 metadata 和未知的嵌套 content
  discriminant 仍具备向前兼容性。
- 对 `usage_update` 来说，这意味着存在的 field 必须格式正确——只有一半的 window
  gauge，或两半不是有限 number 的 gauge，都属于格式错误，无论其他通道携带了多少
  内容。
  显式 `null` 在这里视为缺省，和 field 被省略完全一样。完全不带任何通道的 event
  同样格式错误，因为协议要求 gauge；除非它带有 runskein 的 synthetic-usage marker：
  这种 event 即使没有可 fold 的内容也是格式正确的，且既不发出 `raw`，也不发出
  `usageState`。
- 校验先于 variant 特有的状态改变。未知或格式错误的 update 可以按文档中的边界规则
  关闭打开的消息，但不能局部 patch tool、plan 或 usage 状态。无效 envelope 甚至
  不会关闭消息，因为 §3 要求不得改变状态。

### 4.6 整份 Transcript reader

流式 `Folder` 适合 live renderer。在已完成的 Transcript 上工作的 reader 更想获得
settle 后的结果，因此有两个 helper 构建在同一个 Folder 之上——merge 规则仍只有一处：

- `collectToolRows(events)` 会 fold 一条有序 event 流，按首次出现的顺序返回每个
  `toolCallId` 最后抵达的 snapshot。Engine 在 terminal status 后复用的 id 是第二轮
  run（§4.2 的 eviction），保留的是后一次 run 的 row。
- `toolCallText(row)` 会用空行连接 tool call 报告的 text；当 row 不带 text block
  时，回退到 string `rawOutput`——有些 Engine 会在那里报告完整的 tool result，
  正如 core 的 Transcript digest 已经处理的那样。diff、terminal、image 及未来的
  block type 都是 caller 从 `content` 本身读取的结构化 payload；若在这里将它们
  flatten，就会臆造一种并不属于 fold 的 rendering（§6）。

这也就是 Transcript 对于 **「sub-agent 做了什么？」**这个问题所能回答的全部。
启动 sub-agent 的 Engine 不会开启第二个 Session：整个 sub-run 会作为一个 tool call
报告到父 Session 上，所以关于它的一切记录都在这一行中。Engine 选择不报告的内容无法
在这一层恢复——若要浮现更多内容，就需要 Engine 发出它，并由 runskein 对 parent/child
relation 建模，这两件事 fold 都无法独自完成。

## 5. 类型 surface

每个 presentation event 都会携带导致它产生的 Transcript source。对于隐式或显式的
`messageEnd`，source 是该消息的最后一个 chunk，而不是随后到来的 boundary event。
replay 一致性受 §3 的显式边界规则约束。

```ts
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  TranscriptEvent,
  Usage,
} from '@runskein/core';

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type NonTextBlock = Exclude<ContentBlock, { type: 'text' }>;
type UnknownContentBlock = Readonly<Record<string, unknown>> & {
  readonly type: string;
};
type UnknownToolCallContent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};
type FoldedToolCallContent = Readonly<ToolCallContent> | Readonly<UnknownToolCallContent>;
type MessageKind = 'agent' | 'thought' | 'user';
type NoticeUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate:
      'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update';
  }
>;

type FoldInput = Omit<TranscriptEvent, 'update'> & { update: unknown };
type SourceRef = Readonly<Pick<TranscriptEvent, 'seq' | 'ts' | 'sessionId' | 'engineId'>>;

interface FoldedEvent {
  readonly source: SourceRef;
  readonly event: PresentationEvent;
}

type PresentationEvent = Readonly<
  | { type: 'messageStart'; kind: MessageKind; messageId?: string }
  | { type: 'messageAppend'; block: Readonly<TextBlock> }
  | { type: 'messageEnd' }
  | {
      type: 'content';
      kind: MessageKind;
      messageId?: string;
      block: Readonly<NonTextBlock> | Readonly<UnknownContentBlock>;
    }
  | {
      type: 'toolRow';
      row: Readonly<ToolRow>;
      changed: readonly ToolRowField[];
    }
  | {
      type: 'planState';
      state: Readonly<PlanSnapshot>;
      changedPlanId?: string;
      removedPlanId?: string;
    }
  | { type: 'usageState'; usage: Readonly<UsageState> }
  | { type: 'notice'; update: Readonly<NoticeUpdate> }
  | {
      type: 'raw';
      update: unknown;
      reason: 'unknown-update' | 'malformed-known-update' | 'invalid-envelope';
    }
>;

interface PlanSnapshot {
  readonly legacy?: readonly Readonly<PlanEntry>[];
  readonly keyed: readonly Readonly<KeyedPlanState>[];
}

interface ToolRow {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: readonly FoldedToolCallContent[];
  readonly locations?: readonly Readonly<ToolCallLocation>[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  /** Fold-derived (see 4.2.1), never read from the wire. */
  readonly args?: Readonly<ToolCallArgs>;
  /** Fold-derived (see 4.2.2), never read from the wire. */
  readonly diffs?: readonly Readonly<DiffCoverage>[];
}

interface ToolCallArgs {
  readonly text: string;
  readonly value?: unknown;
  readonly from: 'rawInput' | 'locations' | 'content';
}

interface DiffCoverage {
  readonly index: number;
  readonly path: string;
  readonly scope: 'wholeFile' | 'unknown';
  readonly startLine?: number;
  readonly from?: 'created' | 'chained';
}

type ToolRowField = Exclude<keyof ToolRow, 'toolCallId'>;

type KeyedPlanState =
  | {
      readonly type: 'items';
      readonly planId: string;
      readonly entries: readonly Readonly<PlanEntry>[];
    }
  | { readonly type: 'file'; readonly planId: string; readonly uri: string }
  | {
      readonly type: 'markdown';
      readonly planId: string;
      readonly content: string;
    };

declare function createFolder(): Folder;

interface Folder {
  push(input: FoldInput): FoldedEvent[];
  flush(): FoldedEvent[];
}

interface DiffCoverageJudge {
  push(update: unknown): readonly Readonly<DiffCoverage>[] | undefined;
}

declare function createDiffCoverageJudge(): DiffCoverageJudge;
declare function collectToolRows(events: Iterable<FoldInput>): Map<string, Readonly<ToolRow>>;
declare function toolCallText(row: ToolRow): string;
```

`ToolRow`、`ToolCallArgs`、`KeyedPlanState` 与 `UsageState` 是 package 自有的 readonly
展示类型，由 core 的公开词汇派生而来。它们不得导入或重新 export ACP SDK declaration。

大 payload 规则：fold 不解码 base64，也不把 string 复制到额外 buffer 中。JavaScript
string 是 immutable 的，可以共享。为保证 snapshot 稳定性，array/row shell 会被复制；
input 与 output 均被记录为 readonly。Fold 不会 sanitize、truncate、serialize 或
deep-clone 任意的 `rawInput`/`rawOutput` value。

## 6. 哪些内容留给各 UI

fold 有意**不**负责：

- **Rendering/coalescing policy。** terminal 会追加到同一行；web UI 会 patch bubble；
  log consumer 可以打印每个 patch。
- **Output safety。** terminal control stripping 留在 CLI
  ([`cli.md`](cli.md) §4.1)；web presenter 会执行与上下文相适应的 HTML/URL escaping。
  Fold 携带 data，绝不携带 markup。
- **IO 与 interaction。** permission prompt、question、input state machine、
  cancellation 与 shutdown 仍属于消费者。
- **Persistence 或 replay scheduling。** host 提供有序 event，并决定何时发生
  live-turn/end-of-input flush。

## 7. 其他内容的位置

- **可执行规范**是 `packages/fold/test/contract.test.ts`：table-driven、纯粹的
  `FoldInput[]` fixture，不依赖 process 或 ACP。上面的每条规则在那里都有 case——
  message boundary 与 flush 幂等性、envelope rejection、派生 `args` 的 source、
  coverage judge 相对于 Folder 自身的 verdict、tool-row eviction 和 memory bound。
  当本文与该 suite 不一致时，实际发布的是 suite。
- [`engine-adapter-api.md`](engine-adapter-api.md) —— fold 从中读取的冻结 v1 surface。
  这一层不改变它：fold 接受更宽的_运行时_ input shape，只是为了遵守 core 记录在
  文档中的 raw-update fallback；Transcript persistence、resume 与 export 均保持原样。
- [`cli.md`](cli.md) —— 第一个 presenter，也是 §6 留给消费者的 rendering 与
  coalescing policy 的完整示例。
