import { App, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  Block,
  KnownBlock,
} from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  InlineKeyboard,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });

    // ---- Block Kit button actions (inline keyboard equivalent) ----
    //
    // When user clicks an interactive button, Slack fires a `block_actions`
    // payload. We must ack within 3s or Slack retries (and risks double
    // processing). We deliver a synthetic message carrying callback_data so
    // the agent's skill can act on it — same shape as Telegram's
    // callback_query path.
    this.app.action(/.*/, async ({ ack, action, body, client }) => {
      // Ack immediately — Slack's 3s window is hard.
      try {
        await ack();
      } catch (err) {
        logger.warn({ err }, 'Slack action ack failed (non-fatal)');
      }

      // Bolt types `action` as a union; for buttons we have action_id + value.
      const data =
        (action as { action_id?: string; value?: string }).action_id ||
        (action as { value?: string }).value ||
        '';

      // Defensive: body is BlockAction; channel + message + user always present
      // for our use case (button in posted message, not modal/home tab).
      const slackBody = body as {
        channel?: { id?: string };
        message?: { ts?: string };
        user?: { id?: string; username?: string; name?: string };
      };
      const channelId = slackBody.channel?.id;
      const originalMsgTs = slackBody.message?.ts;
      const userId = slackBody.user?.id || '';
      const userName =
        slackBody.user?.name || slackBody.user?.username || userId || 'Unknown';

      if (!channelId) {
        logger.warn(
          { data },
          'Slack block_action without channel context, dropping',
        );
        return;
      }

      const jid = `slack:${channelId}`;
      const timestamp = new Date().toISOString();

      // Always report metadata (so unregistered chats get discovered)
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', true);

      // Only deliver to registered groups — same gate as text messages.
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        logger.debug(
          { jid, data },
          'Slack action from unregistered chat, dropping',
        );
        return;
      }

      // Resolve human-readable sender name (cache hit when possible)
      let senderName = userName;
      if (userId) {
        const resolved = await this.resolveUserName(userId);
        if (resolved) senderName = resolved;
      }

      // Synthetic content matches Telegram exactly so the same skill code
      // routes both. originalMsgTs is Slack's analogue of message_id (it's
      // the only id you can pass to chat.update / chat.delete).
      const content = `[callback] data=${data}${
        originalMsgTs ? ` original_message_id=${originalMsgTs}` : ''
      }`;

      this.opts.onMessage(jid, {
        id: `${originalMsgTs || timestamp}:${data}`,
        chat_jid: jid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        callback_data: data,
        callback_message_id: originalMsgTs,
      });

      logger.info(
        { jid, sender: senderName, data, originalMsgTs },
        'Slack block_action delivered',
      );

      // Mark client unused so eslint doesn't complain — Bolt provides it but
      // we don't need it here (we use this.app.client when needed elsewhere).
      void client;
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  // ---- Block Kit interactive messages ----

  /**
   * Build a Block Kit blocks array from text + an inline keyboard.
   *
   * Layout:
   *   - One `section` block with the message text (mrkdwn)
   *   - One `actions` block per keyboard row, each holding up to 25 buttons
   *     (Slack's max). Our skill uses ≤8 per row, so we never hit the cap.
   *
   * `action_id` carries the callback data — Slack allows up to 255 chars,
   * vastly more than Telegram's 64-byte limit, so any callback scheme that
   * fits Telegram fits Slack.
   */
  private buildBlocks(
    text: string,
    keyboard: InlineKeyboard | null,
  ): (Block | KnownBlock)[] {
    const blocks: (Block | KnownBlock)[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: text || ' ' },
      },
    ];
    if (keyboard) {
      for (const row of keyboard) {
        if (!row.length) continue;
        blocks.push({
          type: 'actions',
          elements: row.slice(0, 25).map((btn) => ({
            type: 'button',
            text: { type: 'plain_text', text: btn.text, emoji: true },
            action_id: btn.callback_data,
          })),
        });
      }
    }
    return blocks;
  }

  /**
   * Send a message with an inline Block Kit keyboard. Returns the message's
   * `ts` (Slack's analogue of message_id) so callers can edit/delete later.
   */
  async sendMessageWithKeyboard(
    jid: string,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<{ messageId: string }> {
    const channelId = jid.replace(/^slack:/, '');
    const blocks = this.buildBlocks(text, keyboard);
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text, // fallback for notifications + screen readers
      blocks,
    });
    if (!result.ts) {
      throw new Error('Slack chat.postMessage returned no ts');
    }
    logger.info(
      { jid, messageId: result.ts, buttons: keyboard.flat().length },
      'Slack keyboard message sent',
    );
    return { messageId: result.ts };
  }

  /**
   * Edit an existing message — text, keyboard, or both.
   *
   * Semantics differ slightly from Telegram:
   *   - keyboard === null: remove keyboard (text-only blocks)
   *   - keyboard === undefined: same as null on Slack. Slack's chat.update
   *     replaces blocks atomically; "leave keyboard unchanged" would require
   *     fetching existing blocks first, which adds an API call per edit and
   *     complicates rate-limiting. The grade-review skill never passes
   *     undefined in practice, so we accept the simplification.
   *   - keyboard array: replace keyboard
   */
  async editMessage(
    jid: string,
    messageId: string,
    text: string,
    keyboard?: InlineKeyboard | null,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const blocks = this.buildBlocks(text, keyboard ?? null);
    try {
      await this.app.client.chat.update({
        channel: channelId,
        ts: messageId,
        text,
        blocks,
      });
      logger.info({ jid, messageId }, 'Slack message edited');
    } catch (err: unknown) {
      const errMsg = (err as { data?: { error?: string }; message?: string })
        ?.data?.error || (err as { message?: string })?.message || String(err);
      // message_not_found / cant_update_message / edit_window_closed are
      // non-fatal — log and move on. Other errors propagate so callers see them.
      if (
        errMsg === 'message_not_found' ||
        errMsg === 'cant_update_message' ||
        errMsg === 'edit_window_closed'
      ) {
        logger.debug(
          { jid, messageId, errMsg },
          'Slack editMessage non-fatal failure',
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Delete a message by ts. Bot can only delete messages it sent. Silent on
   * "already gone" errors so callers don't have to handle them.
   */
  async deleteMessage(jid: string, messageId: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.chat.delete({
        channel: channelId,
        ts: messageId,
      });
      logger.info({ jid, messageId }, 'Slack message deleted');
    } catch (err: unknown) {
      const errMsg = (err as { data?: { error?: string }; message?: string })
        ?.data?.error || (err as { message?: string })?.message || String(err);
      logger.debug(
        { jid, messageId, errMsg },
        'Slack deleteMessage non-fatal failure',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
