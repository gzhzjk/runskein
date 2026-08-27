/** Compile-time guard that the generated public vocabulary mirrors pinned ACP v1. */
import type * as acp from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  McpServerConfig,
  PermissionOption,
  SessionUpdate,
  ToolCallLocation,
  ToolKind,
} from '../vocabulary.js';

type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

type _ContentToAcp = Assert<Extends<ContentBlock, acp.ContentBlock>>;
type _ContentFromAcp = Assert<Extends<acp.ContentBlock, ContentBlock>>;
type _UpdateToAcp = Assert<Extends<SessionUpdate, acp.SessionUpdate>>;
type _UpdateFromAcp = Assert<Extends<acp.SessionUpdate, SessionUpdate>>;
type _KindToAcp = Assert<Extends<ToolKind, acp.ToolKind>>;
type _KindFromAcp = Assert<Extends<acp.ToolKind, ToolKind>>;
type _LocationToAcp = Assert<Extends<ToolCallLocation, acp.ToolCallLocation>>;
type _LocationFromAcp = Assert<Extends<acp.ToolCallLocation, ToolCallLocation>>;
type _PermissionToAcp = Assert<Extends<PermissionOption, acp.PermissionOption>>;
type _PermissionFromAcp = Assert<Extends<acp.PermissionOption, PermissionOption>>;
type _McpToAcp = Assert<Extends<McpServerConfig, acp.McpServer>>;
type _McpFromAcp = Assert<Extends<acp.McpServer, McpServerConfig>>;
