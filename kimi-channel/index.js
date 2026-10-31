/**
 * Host half of the `dsh-kimi-channel` bundle.
 *
 * Starts a loopback-only WebSocket control channel that lets an external
 * programming client (the Kimi Code skill in `kimi-skill/dsh-channel`) create
 * or resume DSH sessions, submit and steer prompts, answer approvals and
 * questions, and receive the turn event stream.
 */
import { startChannel } from './lib/channel.mjs'

export const name = 'kimi-channel'

/** Core services the channel drives. Optional services are looked up with `ctx.get` so
 * a profile without them still loads the plugin. */
export const inject = ['agents']

/**
 * Mount the control channel for the lifetime of the owning fiber.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [rowConfig] - Loader row config; `~/.dsh/kimi-channel.json` overrides it.
 */
export function apply(ctx, rowConfig = {}) {
  return startChannel(ctx, rowConfig)
}
