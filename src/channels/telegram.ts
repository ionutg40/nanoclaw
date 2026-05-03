import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  InlineKeyboard,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name: string;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private isFallback: boolean;
  // Chat JIDs this bot has seen inbound. Populated on every message — grammy
  // polls per bot token, so a chat that reaches THIS bot is definitively owned
  // by THIS instance. Used by ownsJid for outbound routing.
  //
  // Capped LRU: at any given time the bot really only needs ownership info for
  // chats with recent traffic. Without a cap, this Set grows monotonically
  // (every chat the bot was ever DM'd by an attacker / spammer / random user
  // sticks around forever), turning into a slow memory leak in long-running
  // deployments. Set preserves insertion order, so re-inserting on hit moves
  // the entry to the end and the first key is always the least-recently-seen.
  private knownChats: Set<string> = new Set();
  private static readonly KNOWN_CHATS_LIMIT = 5000;

  // Per-bot identity used in /ping replies and possibly other surface text.
  // Defaults to the global ASSISTANT_NAME so existing bots keep their behavior.
  private assistantLabel: string;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    channelName: string = 'telegram',
    isFallback: boolean = true,
    assistantLabel?: string,
  ) {
    this.botToken = botToken;
    this.name = channelName;
    this.opts = opts;
    this.isFallback = isFallback;
    this.assistantLabel = assistantLabel || ASSISTANT_NAME;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      // 'wx' flag (O_CREAT|O_EXCL|O_WRONLY) refuses to overwrite an existing
      // entry at destPath — including a pre-staged symlink, which would
      // otherwise be silently followed to whatever target the attacker chose
      // (an agent inside the container can write into the mounted attachments
      // dir; without this guard, a symlink there steers our host write to an
      // arbitrary path the orchestrator can reach). Mirrors the Slack
      // file_shared defense.
      try {
        fs.writeFileSync(destPath, buffer, { flag: 'wx', mode: 0o600 });
      } catch (writeErr) {
        const code = (writeErr as { code?: string })?.code;
        if (code === 'EEXIST' || code === 'ELOOP') {
          logger.warn(
            { fileId, code },
            'Telegram file download skipped: destination exists or is a symlink',
          );
          return null;
        }
        throw writeErr;
      }

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      this.rememberChat(`tg:${chatId}`);
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}\nBot: ${this.name}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      this.rememberChat(`tg:${ctx.chat.id}`);
      ctx.reply(`${this.assistantLabel} is online (${this.name}).`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      // Claim ownership: this bot received a message from chatJid,
      // so future outbound to that JID must route through THIS instance.
      this.rememberChat(chatJid);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      // Claim ownership on any inbound media from this chat too.
      this.rememberChat(chatJid);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // ---- Inline keyboard callback_query ----
    // When the user taps a button, ack immediately (dismisses spinner) and
    // deliver a synthetic message carrying the callback_data so the agent can
    // act on it. Original message stays in chat with its keyboard until the
    // agent decides to edit_message it.
    this.bot.on('callback_query:data', async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
      } catch (err) {
        logger.warn({ err }, 'answerCallbackQuery failed (non-fatal)');
      }

      const chat = ctx.chat;
      if (!chat) {
        logger.warn('callback_query without chat context, dropping');
        return;
      }
      const chatJid = `tg:${chat.id}`;
      this.rememberChat(chatJid);

      const data = ctx.callbackQuery.data;
      const originalMsg = ctx.callbackQuery.message;
      const originalMsgId = originalMsg?.message_id?.toString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = ctx.from?.id?.toString() || '';
      const timestamp = new Date().toISOString();
      const chatName =
        chat.type === 'private' ? senderName : (chat as any).title || chatJid;
      const isGroup = chat.type === 'group' || chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver to registered groups — same gate as text messages.
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, data },
          'Callback from unregistered chat, dropping',
        );
        return;
      }

      // Synthetic content lets formatMessages render it readably even before
      // the agent learns to read callback_data fields directly.
      const content = `[callback] data=${data}${
        originalMsgId ? ` original_message_id=${originalMsgId}` : ''
      }`;

      this.opts.onMessage(chatJid, {
        id: ctx.callbackQuery.id,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        callback_data: data,
        callback_message_id: originalMsgId,
      });

      logger.info(
        { chatJid, sender: senderName, data, originalMsgId },
        'Telegram callback_query delivered',
      );
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  // Bounded add: evict least-recently-seen JID when at capacity. Set preserves
  // insertion order, so the first key is the oldest entry.
  private rememberChat(jid: string): void {
    if (this.knownChats.has(jid)) {
      this.knownChats.delete(jid); // refresh recency
      this.knownChats.add(jid);
      return;
    }
    if (this.knownChats.size >= TelegramChannel.KNOWN_CHATS_LIMIT) {
      const oldest = this.knownChats.values().next().value;
      if (oldest) this.knownChats.delete(oldest);
    }
    this.knownChats.add(jid);
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('tg:')) return false;
    // A chat this bot has seen inbound is definitively ours.
    if (this.knownChats.has(jid)) {
      // LRU touch: re-insert to refresh recency, so a chat we still talk with
      // doesn't get evicted just because we've also seen many other chats.
      this.knownChats.delete(jid);
      this.knownChats.add(jid);
      return true;
    }
    // Legacy/fallback instance catches any tg: JID we haven't yet seen.
    // Non-fallback instances (new bots) strictly own only what they've observed.
    return this.isFallback;
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  /**
   * Send a message with an inline keyboard. Returns the message_id so callers
   * can later edit/remove the keyboard with editMessage().
   * Falls back to plain text + keyboard if Markdown parsing fails.
   */
  async sendMessageWithKeyboard(
    jid: string,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<{ messageId: string }> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    const replyMarkup = { inline_keyboard: keyboard };
    let result;
    try {
      result = await this.bot.api.sendMessage(numericId, text, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
    } catch (err) {
      logger.debug(
        { err },
        'Markdown keyboard send failed, retrying as plain text',
      );
      result = await this.bot.api.sendMessage(numericId, text, {
        reply_markup: replyMarkup,
      });
    }
    logger.info(
      { jid, messageId: result.message_id, buttons: keyboard.flat().length },
      'Telegram keyboard message sent',
    );
    return { messageId: result.message_id.toString() };
  }

  /**
   * Delete a message by id. Silent on the usual 48h window / already-gone errors.
   */
  async deleteMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    const msgIdNum = parseInt(messageId, 10);
    try {
      await this.bot.api.deleteMessage(numericId, msgIdNum);
      logger.info({ jid, messageId }, 'Telegram message deleted');
    } catch (err: any) {
      // 400 "message to delete not found" / 400 "message can't be deleted" etc.
      // These are non-fatal — log at debug level and move on.
      logger.debug(
        { jid, messageId, err: err?.message || String(err) },
        'Telegram deleteMessage failed (non-fatal — likely older than 48h or already gone)',
      );
    }
  }

  /**
   * Edit an existing message — text, keyboard, or both.
   * keyboard === null  -> remove keyboard
   * keyboard === undefined -> leave keyboard unchanged (text-only edit)
   * keyboard array -> replace keyboard
   */
  async editMessage(
    jid: string,
    messageId: string,
    text: string,
    keyboard?: InlineKeyboard | null,
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    const msgIdNum = parseInt(messageId, 10);
    const opts: any = { parse_mode: 'Markdown' };
    if (keyboard === null) {
      opts.reply_markup = { inline_keyboard: [] };
    } else if (keyboard !== undefined) {
      opts.reply_markup = { inline_keyboard: keyboard };
    }
    try {
      await this.bot.api.editMessageText(numericId, msgIdNum, text, opts);
    } catch (err) {
      // Fallback: retry without Markdown
      logger.debug({ err }, 'Markdown editMessage failed, retrying plain');
      delete opts.parse_mode;
      await this.bot.api.editMessageText(numericId, msgIdNum, text, opts);
    }
    logger.info(
      { jid, messageId, length: text.length },
      'Telegram message edited',
    );
  }
}

// CapYear bot — registered FIRST so router.findChannel() matches it before
// the fallback MicroRekon channel for chats this bot has seen.
registerChannel('telegram-capyear', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN_CAPYEAR',
    'ASSISTANT_NAME_CAPYEAR',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN_CAPYEAR ||
    envVars.TELEGRAM_BOT_TOKEN_CAPYEAR ||
    '';
  if (!token) {
    logger.debug(
      'Telegram: TELEGRAM_BOT_TOKEN_CAPYEAR not set — skipping CapYear bot',
    );
    return null;
  }
  const label =
    process.env.ASSISTANT_NAME_CAPYEAR ||
    envVars.ASSISTANT_NAME_CAPYEAR ||
    undefined;
  return new TelegramChannel(
    token,
    opts,
    'telegram-capyear',
    /*isFallback*/ false,
    label,
  );
});

// MicroRekon bot — the legacy / primary assistant. Registered SECOND, marked
// as fallback so it keeps ownership of any pre-existing chat that hasn't yet
// been claimed by a newer bot instance (e.g. right after restart).
// Backward-compat: falls back to TELEGRAM_BOT_TOKEN if _MICROREKON is unset.
registerChannel('telegram-microrekon', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN_MICROREKON',
    'TELEGRAM_BOT_TOKEN',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN_MICROREKON ||
    envVars.TELEGRAM_BOT_TOKEN_MICROREKON ||
    process.env.TELEGRAM_BOT_TOKEN ||
    envVars.TELEGRAM_BOT_TOKEN ||
    '';
  if (!token) {
    logger.warn(
      'Telegram: neither TELEGRAM_BOT_TOKEN_MICROREKON nor TELEGRAM_BOT_TOKEN set',
    );
    return null;
  }
  return new TelegramChannel(
    token,
    opts,
    'telegram-microrekon',
    /*isFallback*/ true,
  );
});
