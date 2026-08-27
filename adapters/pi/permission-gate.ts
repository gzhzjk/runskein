/**
 * runskein's permission gate for pi.
 *
 * pi has no approval protocol: built-in tools execute as soon as the model
 * asks for them. The `tool_call` hook is the only place a decision can be
 * inserted, and in RPC mode a dialog raised from that hook becomes an
 * `extension_ui_request` frame the shim can answer — which is how runskein's
 * permission policy gets to decide anything at all here.
 *
 * The dialog title is the only field that travels from this extension to the
 * client, so it carries the whole request: a marker, the nonce the shim gave
 * this process, and the base64 of the tool call. A pi run started by anything
 * other than the shim has no nonce, and this extension then does nothing —
 * blocking every tool because no answer is possible would break the user's own
 * `pi` while the file happens to be on their extension path.
 *
 * This file is loaded by pi's own TypeScript loader, never by runskein's build.
 */

/** Marker that lets the shim tell its own dialogs from other extensions'. */
const MARKER = 'runskein-pi-permission';

/**
 * How long a tool may wait for an answer before pi auto-dismisses the dialog.
 * The shim applies its own, shorter deadline; this one exists so a shim that
 * dies mid-question cannot wedge the tool forever.
 */
const DIALOG_TIMEOUT_MS = 180_000;

/** Answers the shim can send back, as option ids. */
type Choice = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

const CHOICES: Choice[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

/**
 * Register the gate.
 * @param pi - pi's extension API.
 */
export default function register(pi: any): void {
  const nonce = process.env['RUNSKEIN_PI_GATE_NONCE'];
  if (!nonce) return;

  // "Always allow" is remembered for this process only. Nothing is written to
  // pi's config: runskein's policy is the durable authority, and a decision
  // cached on disk would silently outlive the session that made it.
  const allowed = new Set<string>();

  pi.on('tool_call', async (event: any, ctx: any) => {
    const signature = `${event.toolName}:${JSON.stringify(event.input ?? {})}`;
    if (allowed.has(signature)) return undefined;

    const payload = Buffer.from(
      JSON.stringify({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input ?? {},
      }),
      'utf8',
    ).toString('base64');

    const choice = await ctx.ui.select(`${MARKER}:${nonce}:${payload}`, CHOICES, {
      timeout: DIALOG_TIMEOUT_MS,
    });

    // `undefined` means dismissed or timed out. The tool is waiting on this
    // answer, so the only safe reading of "no answer" is refusal.
    if (choice === 'allow_once') return undefined;
    if (choice === 'allow_always') {
      allowed.add(signature);
      return undefined;
    }
    return {
      block: true,
      reason: 'Denied by runskein permission policy',
      terminate: choice === 'reject_always',
    };
  });
}
