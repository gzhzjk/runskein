/**
 * GENERATED from @agentclientprotocol/sdk's pinned ACP v1 schema.
 * Run `pnpm --filter @runskein/core generate:vocabulary` after SDK upgrades.
 * RunSkein owns and exports these declarations; core does not re-export SDK types.
 */

export type ToolCallUpdate = {
    toolCallId: ToolCallId;
    kind?: ToolKind | null;
    status?: ToolCallStatus | null;
    title?: string | null;
    name?: string | null;
    content?: Array<ToolCallContent> | null;
    locations?: Array<ToolCallLocation> | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type ToolCallId = string;

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent = (Content & {
    type: "content";
}) | (Diff & {
    type: "diff";
}) | (Terminal & {
    type: "terminal";
});

export type ContentBlock = (TextContent & {
    type: "text";
}) | (ImageContent & {
    type: "image";
}) | (AudioContent & {
    type: "audio";
}) | (ResourceLink & {
    type: "resource_link";
}) | (EmbeddedResource & {
    type: "resource";
});

export type Annotations = {
    audience?: Array<Role> | null;
    lastModified?: string | null;
    priority?: number | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type Role = "assistant" | "user";

type TextContent = {
    annotations?: Annotations | null;
    text: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type ImageContent = {
    annotations?: Annotations | null;
    data: string;
    mimeType: string;
    uri?: string | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type AudioContent = {
    annotations?: Annotations | null;
    data: string;
    mimeType: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type ResourceLink = {
    annotations?: Annotations | null;
    description?: string | null;
    mimeType?: string | null;
    name: string;
    size?: number | null;
    title?: string | null;
    uri: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;

type TextResourceContents = {
    mimeType?: string | null;
    text: string;
    uri: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type BlobResourceContents = {
    blob: string;
    mimeType?: string | null;
    uri: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type EmbeddedResource = {
    annotations?: Annotations | null;
    resource: EmbeddedResourceResource;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type Content = {
    content: ContentBlock;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type Diff = {
    path: string;
    oldText?: string | null;
    newText: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type TerminalId = string;

type Terminal = {
    terminalId: TerminalId;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

export type ToolCallLocation = {
    path: string;
    line?: number | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

export type PermissionOption = {
    optionId: PermissionOptionId;
    name: string;
    kind: PermissionOptionKind;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PermissionOptionId = string;

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

type EnvVariable = {
    name: string;
    value: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServerAcpId = string;

type SessionModeId = string;

type SessionConfigOption = ((SessionConfigSelect & {
    type: "select";
}) | (SessionConfigBoolean & {
    type: "boolean";
})) & {
    id: SessionConfigId;
    name: string;
    description?: string | null;
    category?: SessionConfigOptionCategory | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type SessionConfigId = string;

type SessionConfigOptionCategory = "mode" | "model" | "model_config" | "thought_level" | string;

type SessionConfigValueId = string;

type SessionConfigSelectOptions = Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>;

type SessionConfigSelectOption = {
    value: SessionConfigValueId;
    name: string;
    description?: string | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type SessionConfigSelectGroup = {
    group: SessionConfigGroupId;
    name: string;
    options: Array<SessionConfigSelectOption>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type SessionConfigGroupId = string;

type SessionConfigSelect = {
    currentValue: SessionConfigValueId;
    options: SessionConfigSelectOptions;
};

type SessionConfigBoolean = {
    currentValue: boolean;
};

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type SessionUpdate = (ContentChunk & {
    sessionUpdate: "user_message_chunk";
}) | (ContentChunk & {
    sessionUpdate: "agent_message_chunk";
}) | (ContentChunk & {
    sessionUpdate: "agent_thought_chunk";
}) | (ToolCall & {
    sessionUpdate: "tool_call";
}) | (ToolCallUpdate & {
    sessionUpdate: "tool_call_update";
}) | (Plan & {
    sessionUpdate: "plan";
}) | (PlanUpdate & {
    sessionUpdate: "plan_update";
}) | (PlanRemoved & {
    sessionUpdate: "plan_removed";
}) | (AvailableCommandsUpdate & {
    sessionUpdate: "available_commands_update";
}) | (CurrentModeUpdate & {
    sessionUpdate: "current_mode_update";
}) | (ConfigOptionUpdate & {
    sessionUpdate: "config_option_update";
}) | (SessionInfoUpdate & {
    sessionUpdate: "session_info_update";
}) | (UsageUpdate & {
    sessionUpdate: "usage_update";
});

type MessageId = string;

type ContentChunk = {
    content: ContentBlock;
    messageId?: MessageId | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type ToolCall = {
    toolCallId: ToolCallId;
    title: string;
    name?: string | null;
    kind?: ToolKind;
    status?: ToolCallStatus;
    content?: Array<ToolCallContent>;
    locations?: Array<ToolCallLocation>;
    rawInput?: unknown;
    rawOutput?: unknown;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

export type PlanEntry = {
    content: string;
    priority: PlanEntryPriority;
    status: PlanEntryStatus;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanEntryPriority = "high" | "medium" | "low";

type PlanEntryStatus = "pending" | "in_progress" | "completed";

type Plan = {
    entries: Array<PlanEntry>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanUpdateContent = (PlanItems & {
    type: "items";
}) | (PlanFile & {
    type: "file";
}) | (PlanMarkdown & {
    type: "markdown";
});

type PlanId = string;

type PlanItems = {
    planId: PlanId;
    entries: Array<PlanEntry>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanFile = {
    planId: PlanId;
    uri: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanMarkdown = {
    planId: PlanId;
    content: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanUpdate = {
    plan: PlanUpdateContent;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type PlanRemoved = {
    planId: PlanId;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type AvailableCommand = {
    name: string;
    description: string;
    input?: AvailableCommandInput | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type AvailableCommandInput = UnstructuredCommandInput;

type UnstructuredCommandInput = {
    hint: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type AvailableCommandsUpdate = {
    availableCommands: Array<AvailableCommand>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type CurrentModeUpdate = {
    currentModeId: SessionModeId;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type ConfigOptionUpdate = {
    configOptions: Array<SessionConfigOption>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type SessionInfoUpdate = {
    title?: string | null;
    updatedAt?: string | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type Cost = {
    amount: number;
    currency: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type UsageUpdate = {
    used: number;
    size: number;
    cost?: Cost | null;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServer = (McpServerHttp & {
    type: "http";
}) | (McpServerSse & {
    type: "sse";
}) | (McpServerAcp & {
    type: "acp";
}) | McpServerStdio;

type HttpHeader = {
    name: string;
    value: string;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServerHttp = {
    name: string;
    url: string;
    headers: Array<HttpHeader>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServerSse = {
    name: string;
    url: string;
    headers: Array<HttpHeader>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServerAcp = {
    name: string;
    serverId: McpServerAcpId;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

type McpServerStdio = {
    name: string;
    command: string;
    args: Array<string>;
    env: Array<EnvVariable>;
    _meta?: {
        [key: string]: unknown;
    } | null;
};

export type McpServerConfig = McpServer;
