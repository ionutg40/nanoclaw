import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    actionHandlers: { pattern: RegExp | string; handler: Handler }[] = [];
    commandHandlers: { pattern: RegExp | string; handler: Handler }[] = [];

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1704067200.999999' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
      files: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          file: {
            id: 'F0TEST',
            name: 'NHA_Detailed_Report.CSV',
            url_private_download:
              'https://files.slack.com/files-pri/T0/F0TEST/download/test.csv',
          },
        }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    action(pattern: RegExp | string, handler: Handler) {
      this.actionHandlers.push({ pattern, handler });
    }

    command(pattern: RegExp | string, handler: Handler) {
      this.commandHandlers.push({ pattern, handler });
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

// Mock group-folder helper (resolves group folder to absolute path on host)
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
  isValidGroupFolder: vi.fn(() => true),
}));

// Mock global fetch for file download
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock fs for file write (we don't want real I/O in tests)
vi.mock('fs', async (orig) => {
  const actual = (await orig()) as typeof import('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    default: { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() },
  };
});

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

async function triggerSlashCommand(payload: {
  command: string;
  text?: string;
  channel_id?: string;
  user_id?: string;
  user_name?: string;
}) {
  const ack = vi.fn().mockResolvedValue(undefined);
  const command = {
    command: payload.command,
    text: payload.text ?? '',
    channel_id: payload.channel_id ?? 'C0123456789',
    user_id: payload.user_id ?? 'U_USER_456',
    user_name: payload.user_name ?? 'alice',
    trigger_id: '12345.67890.abcdef',
  };
  for (const { pattern, handler } of currentApp().commandHandlers) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (re.test(payload.command)) {
      await handler({ ack, command, client: currentApp().client });
      return ack;
    }
  }
  return ack;
}

async function triggerBlockAction(payload: {
  action_id: string;
  channel?: string;
  message_ts?: string;
  user_id?: string;
  user_name?: string;
}) {
  const ack = vi.fn().mockResolvedValue(undefined);
  const action = { action_id: payload.action_id, value: payload.action_id };
  const body = {
    channel: { id: payload.channel ?? 'C0123456789' },
    message: { ts: payload.message_ts ?? '1704067200.000000' },
    user: {
      id: payload.user_id ?? 'U_USER_456',
      username: payload.user_name ?? 'alice',
    },
  };
  // Match any registered action handler whose pattern matches the action_id
  for (const { pattern, handler } of currentApp().actionHandlers) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (re.test(payload.action_id)) {
      await handler({ ack, action, body, client: currentApp().client });
      return ack;
    }
  }
  return ack;
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage — T4.24 internal-meta prose gate', () => {
    const REAL_LEAKED_EXAMPLES = [
      "Sent. Waiting for Monica's tap.",
      "Acknowledged — that's the batch submit task I already read the output from... No further action needed.",
      'Batch processed by Alberto',
      'The task is complete for this turn... No further work to track.',
    ];

    it.each(REAL_LEAKED_EXAMPLES)(
      'blocks the real leaked example: %s',
      async (leaked) => {
        const opts = createTestOpts();
        const channel = new SlackChannel(opts);
        await channel.connect();

        await channel.sendMessage('slack:C0AU7PHUJBX', leaked);

        expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
      },
    );

    it('blocks a variant even when wrapped in <reply> markers', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0AU7PHUJBX',
        '<reply>Acknowledged. No further action needed.</reply>',
      );

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('does not block a legitimate daily drain summary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0AU7PHUJBX',
        "As of this morning's 12:30 run, 86 cleared and 14 held. The held bucket is mostly the Practice Exam Grad Out cohort that Stephanie reviews manually. Let me know if you want a fresh run on demand.",
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalled();
    });

    it('does not block a legitimate refusal explanation', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0AU7PHUJBX',
        "I'm holding this one for manual review — the NHA score and the self-report differ by more than usual and I'd rather a human confirm before I write it.",
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalled();
    });

    it('does not block a legitimate correction-card style message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0AU7PHUJBX',
        'Corrected one grade: the student reported 78% but NHA has them at 91%. Updated to match NHA, per the standing rule that NHA always wins.',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('scrubs internal server paths and IPs from outbound text (opsec net)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        'venv at /home/fasty/rt_arnold_capyear/active/grade_verifier/venv/bin/python3 and /usr/bin/python3.11 on 95.217.59.112',
      );

      const sent = (currentApp().client.chat.postMessage as any).mock
        .calls[0][0].text as string;
      expect(sent).not.toContain('/home/fasty');
      expect(sent).not.toContain('/usr/bin/python3.11');
      expect(sent).not.toContain('95.217.59.112');
      expect(sent).toContain('[internal path]');
    });

    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('chunked send: requeues only the unsent suffix when a chunk fails mid-stream (ADV-4)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'A'.repeat(4000) + 'B'.repeat(4000) + 'C'.repeat(500);
      currentApp()
        .client.chat.postMessage.mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('rate_limited'));

      await channel.sendMessage('slack:C0123456789', longText);

      // After mid-stream failure, the queue must hold only the unsent suffix
      // (chunks 2+3 = 4500 chars), NOT the full original 8500. Without this
      // fix (ADV-4), a flush retry would duplicate chunk 1 (already delivered).
      const queue = (
        channel as unknown as { outgoingQueue: Array<{ text: string }> }
      ).outgoingQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toHaveLength(4500);
      expect(queue[0].text.startsWith('B')).toBe(true);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });

    // T2.1: <reply>...</reply> marker extraction
    it('extracts content inside <reply> markers and posts only that', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        'Let me think about this. <reply>Done, 86 cleared.</reply> Internal note: refresh next.',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Done, 86 cleared.',
      });
    });

    it('concatenates multiple <reply> blocks with blank lines', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Part one.</reply> some planning <reply>Part two.</reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Part one.\n\nPart two.',
      });
    });

    it('passes through whole text when no <reply> markers present (loose fallback)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        'Daily heartbeat: 86 cleared, 14 held.',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Daily heartbeat: 86 cleared, 14 held.',
      });
    });

    it('falls back to whole text when <reply> is empty after trim', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        'Whole text. <reply>   </reply>',
      );

      // Falls back to whole text, untouched.
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Whole text. <reply>   </reply>',
      });
    });

    it('is case-insensitive on the tag name (<Reply>, <REPLY>)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        'planning <Reply>Real reply.</Reply> trailing',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Real reply.',
      });
    });

    // T4.2: <private_postscript_to:USERID>...</private_postscript_to> marker
    it('strips <private_postscript_to> marker and appends as segregated postscript with mention', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>86 cleared, 14 held. <private_postscript_to:U0AJEN4CBS8>Heads-up: product=4280 retried once.</private_postscript_to></reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: '86 cleared, 14 held.\n\n---\n_(note for <@U0AJEN4CBS8>:)_\nHeads-up: product=4280 retried once.',
      });
    });

    it('appends multiple <private_postscript_to> blocks in order with their own headers', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Daily heartbeat: 47 cleared.<private_postscript_to:U0AAA>First note.</private_postscript_to><private_postscript_to:U0BBB>Second note.</private_postscript_to></reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Daily heartbeat: 47 cleared.\n\n---\n_(note for <@U0AAA>:)_\nFirst note.\n\n_(note for <@U0BBB>:)_\nSecond note.',
      });
    });

    it('passes through whole text when no <private_postscript_to> marker present (loose fallback)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Just a regular heartbeat, no postscripts.</reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Just a regular heartbeat, no postscripts.',
      });
    });

    it('drops empty <private_postscript_to> body silently and keeps main text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Main reply. <private_postscript_to:U0AJEN4CBS8>   </private_postscript_to></reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Main reply.',
      });
    });

    it('is case-insensitive on the <private_postscript_to> tag name', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Heartbeat.<Private_Postscript_To:U0AJEN4CBS8>Adrian note.</Private_Postscript_To></reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Heartbeat.\n\n---\n_(note for <@U0AJEN4CBS8>:)_\nAdrian note.',
      });
    });

    it('emits postscript alone (no separator) when there is no main text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'slack:C0123456789',
        '<reply><private_postscript_to:U0AJEN4CBS8>Adrian-only one-liner.</private_postscript_to></reply>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: '_(note for <@U0AJEN4CBS8>:)_\nAdrian-only one-liner.',
      });
    });

    it('handles postscript outside <reply> markers (lost by extractReplyMarkers, documented behavior)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Per the contract, postscript markers OUTSIDE the <reply> block are
      // discarded along with all other non-reply content. This test pins the
      // behavior so a future change cannot silently start preserving them.
      await channel.sendMessage(
        'slack:C0123456789',
        '<reply>Heartbeat.</reply><private_postscript_to:U0AJEN4CBS8>This is lost.</private_postscript_to>',
      );

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Heartbeat.',
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Interactive messages (Block Kit) ---

  describe('sendMessageWithKeyboard', () => {
    it('posts a section + actions block with the keyboard buttons', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const result = await channel.sendMessageWithKeyboard(
        'slack:C0123456789',
        'Pick one',
        [
          [
            { text: 'Approve', callback_data: 'a:7f3a' },
            { text: 'Bounce', callback_data: 'x:7f3a' },
          ],
        ],
      );

      expect(result.messageId).toBe('1704067200.999999');
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.channel).toBe('C0123456789');
      expect(call.text).toBe('Pick one');
      expect(call.blocks[0]).toMatchObject({
        type: 'section',
        text: { type: 'mrkdwn', text: 'Pick one' },
      });
      expect(call.blocks[1]).toMatchObject({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: 'a:7f3a',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Bounce' },
            action_id: 'x:7f3a',
          },
        ],
      });
    });

    it('emits one actions block per keyboard row', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessageWithKeyboard('slack:C0123456789', 'Title', [
        [{ text: 'Row1Btn', callback_data: 'r1' }],
        [{ text: 'Row2Btn', callback_data: 'r2' }],
        [{ text: 'Row3Btn', callback_data: 'r3' }],
      ]);

      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      // 1 section + 3 actions
      expect(call.blocks).toHaveLength(4);
      expect(call.blocks[0].type).toBe('section');
      expect(call.blocks[1].type).toBe('actions');
      expect(call.blocks[2].type).toBe('actions');
      expect(call.blocks[3].type).toBe('actions');
    });

    it('throws when chat.postMessage returns no ts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockResolvedValueOnce({});

      await expect(
        channel.sendMessageWithKeyboard('slack:C0123456789', 'x', [
          [{ text: 'A', callback_data: 'a' }],
        ]),
      ).rejects.toThrow(/no ts/);
    });

    it('skips empty rows (no actions block emitted)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessageWithKeyboard('slack:C0123456789', 'x', [
        [],
        [{ text: 'A', callback_data: 'a' }],
      ]);

      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      // section + 1 actions (empty row dropped)
      expect(call.blocks).toHaveLength(2);
    });
  });

  describe('editMessage', () => {
    it('updates with new text + keyboard via chat.update', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.editMessage(
        'slack:C0123456789',
        '1704067200.000000',
        '✓ Approved',
        [[{ text: 'Undo', callback_data: 'undo:7f3a' }]],
      );

      const call = currentApp().client.chat.update.mock.calls[0][0];
      expect(call.channel).toBe('C0123456789');
      expect(call.ts).toBe('1704067200.000000');
      expect(call.text).toBe('✓ Approved');
      expect(call.blocks).toHaveLength(2);
      expect(call.blocks[1].elements[0].action_id).toBe('undo:7f3a');
    });

    it('removes keyboard when keyboard=null', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.editMessage(
        'slack:C0123456789',
        '1704067200.000000',
        '✓ Done',
        null,
      );

      const call = currentApp().client.chat.update.mock.calls[0][0];
      expect(call.blocks).toHaveLength(1); // section only
      expect(call.blocks[0].type).toBe('section');
    });

    it('treats keyboard=undefined as null (Slack-specific simplification)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.editMessage(
        'slack:C0123456789',
        '1704067200.000000',
        '✓ Done',
      );

      const call = currentApp().client.chat.update.mock.calls[0][0];
      expect(call.blocks).toHaveLength(1);
    });

    it('swallows message_not_found gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.update.mockRejectedValueOnce({
        data: { error: 'message_not_found' },
      });

      await expect(
        channel.editMessage('slack:C0123456789', '1.000', 'x', null),
      ).resolves.toBeUndefined();
    });

    it('swallows channel_not_found / is_archived / not_in_channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      for (const code of [
        'channel_not_found',
        'is_archived',
        'not_in_channel',
      ]) {
        currentApp().client.chat.update.mockRejectedValueOnce({
          data: { error: code },
        });
        await expect(
          channel.editMessage('slack:C0123456789', '1.000', 'x', null),
        ).resolves.toBeUndefined();
      }
    });

    it('swallows cant_update_message gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.update.mockRejectedValueOnce({
        data: { error: 'cant_update_message' },
      });

      await expect(
        channel.editMessage('slack:C0123456789', '1.000', 'x', null),
      ).resolves.toBeUndefined();
    });

    it('propagates other errors', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.update.mockRejectedValueOnce({
        data: { error: 'rate_limited' },
      });

      await expect(
        channel.editMessage('slack:C0123456789', '1.000', 'x', null),
      ).rejects.toBeTruthy();
    });
  });

  describe('deleteMessage', () => {
    it('calls chat.delete with channel + ts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.deleteMessage('slack:C0123456789', '1704067200.000000');

      const call = currentApp().client.chat.delete.mock.calls[0][0];
      expect(call.channel).toBe('C0123456789');
      expect(call.ts).toBe('1704067200.000000');
    });

    it('swallows errors silently (PII hygiene best-effort)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.delete.mockRejectedValueOnce({
        data: { error: 'message_not_found' },
      });

      await expect(
        channel.deleteMessage('slack:C0123456789', '1.000'),
      ).resolves.toBeUndefined();
    });
  });

  describe('file_share / files attached to message', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });
    });

    it('downloads file and emits [Document: name] (path) marker', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0TEST', name: 'NHA_Detailed_Report.CSV' }],
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://files.slack.com/files-pri/T0/F0TEST/download/test.csv',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-test-token',
          }),
        }),
      );
      expect(onMessage).toHaveBeenCalledTimes(1);
      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toContain(
        '[Document: NHA_Detailed_Report.CSV]',
      );
      expect(delivered.content).toContain(
        '/workspace/group/attachments/NHA_Detailed_Report.CSV',
      );
    });

    it('appends file marker to text when message has both', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: 'Latest CSV',
          ts: '1.0',
          files: [{ id: 'F0TEST', name: 'NHA_Detailed_Report.CSV' }],
        },
      });
      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toMatch(
        /^Latest CSV\n\[Document: NHA_Detailed_Report\.CSV\]/,
      );
    });

    it('emits placeholder when download fails', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Force download failure: files.info returns no url_private_download
      currentApp().client.files.info.mockResolvedValueOnce({
        ok: true,
        file: { id: 'F0X', name: 'lost.csv' },
      });

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0X', name: 'lost.csv' }],
        },
      });
      const delivered = onMessage.mock.calls[0][1];
      // Falls back to a marker without path so the agent still sees something
      expect(delivered.content).toContain('[Document: lost.csv]');
      expect(delivered.content).not.toContain('/workspace/group');
    });

    it('does NOT download files for bot-sent messages (avoid recursion)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_BOT_123', // bot's own user id
          text: '',
          ts: '1.0',
          files: [{ id: 'F0TEST', name: 'test.csv' }],
        },
      });

      // fetch should NOT have been called
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('drops files event from unregistered channel', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({
        onMessage,
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0TEST', name: 'test.csv' }],
        },
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects file larger than MAX_FILE_BYTES (size from files.info)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      // 26 MB — exceeds 25 MB cap. files.info advertises size; downloadFile
      // should refuse to fetch the body, returning the no-path placeholder.
      currentApp().client.files.info.mockResolvedValueOnce({
        ok: true,
        file: {
          id: 'F0BIG',
          name: 'huge.csv',
          url_private_download:
            'https://files.slack.com/files-pri/T0/F0BIG/download/huge.csv',
          size: 26 * 1024 * 1024,
        },
      });

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0BIG', name: 'huge.csv' }],
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toContain('[Document: huge.csv]');
      expect(delivered.content).not.toContain('/workspace/group');
    });

    it('rejects file with disallowed mimetype', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.files.info.mockResolvedValueOnce({
        ok: true,
        file: {
          id: 'F0EXE',
          name: 'tool.exe',
          url_private_download:
            'https://files.slack.com/files-pri/T0/F0EXE/download/tool.exe',
          mimetype: 'application/x-msdownload',
        },
      });

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0EXE', name: 'tool.exe' }],
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toContain('[Document: tool.exe]');
      expect(delivered.content).not.toContain('/workspace/group');
    });

    it('accepts known CSV mimetypes (text/csv, vnd.ms-excel, plain)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.files.info.mockResolvedValueOnce({
        ok: true,
        file: {
          id: 'F0VND',
          name: 'export.csv',
          url_private_download:
            'https://files.slack.com/files-pri/T0/F0VND/download/export.csv',
          mimetype: 'application/vnd.ms-excel',
          size: 200,
        },
      });

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          channel: 'C0123456789',
          channel_type: 'channel',
          user: 'U_USER_456',
          text: '',
          ts: '1.0',
          files: [{ id: 'F0VND', name: 'export.csv' }],
        },
      });

      expect(fetchMock).toHaveBeenCalled();
      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toContain(
        '/workspace/group/attachments/export.csv',
      );
    });
  });

  describe('Markdown translation (Telegram MD → Slack mrkdwn)', () => {
    it('translates **bold** to *bold*', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessageWithKeyboard(
        'slack:C0123456789',
        'Hello **world** today',
        [[{ text: 'OK', callback_data: 'ok' }]],
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.blocks[0].text.text).toBe('Hello *world* today');
    });

    it('translates [text](url) to <url|text>', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessageWithKeyboard(
        'slack:C0123456789',
        'See [docs](https://example.com)',
        [[{ text: 'OK', callback_data: 'ok' }]],
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.blocks[0].text.text).toBe('See <https://example.com|docs>');
    });

    it('preserves single-asterisk bold (Telegram V1 + Slack mrkdwn both treat *x* as bold)', async () => {
      // CRITICAL contract: skill emits `*Pending Review*` for bold (per
      // Telegram V1 convention which the skill ecosystem was built on).
      // Slack mrkdwn ALSO treats `*x*` as bold. Channel must not flip this
      // to `_x_` (italic) — that was the bug motivating the V2 translator.
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        '*Pending Review — 50 submissions*',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('*Pending Review — 50 submissions*');
    });

    it('preserves _italic_ underscore form on both channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage('slack:C0123456789', 'Note: _do not_ skip');
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('Note: _do not_ skip');
    });

    it('translates **bold** (CommonMark) to *bold* defensively', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'CommonMark **important** statement',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('CommonMark *important* statement');
    });

    it('preserves URL containing balanced parens (Wikipedia)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'See [Slack docs](https://en.wikipedia.org/wiki/Slack_(software))',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe(
        'See <https://en.wikipedia.org/wiki/Slack_(software)|Slack docs>',
      );
    });

    it('encodes pipes inside URLs to avoid Slack <url|label> collision', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        '[ticket](https://x.io/q?a=1|2)',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('<https://x.io/q?a=1%7C2|ticket>');
    });

    it('does NOT translate markdown inside backtick code spans', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'Use `**bold**` to emphasize',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('Use `**bold**` to emphasize');
    });

    it('does NOT translate markdown inside triple-backtick fences', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'Example:\n```\nx = a**b**\nlink: [docs](https://x)\n```\n*italic* outside',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain('x = a**b**');
      expect(call.text).toContain('[docs](https://x)');
      // *italic* outside fences is bold on both channels — no translation
      expect(call.text).toContain('*italic* outside');
    });

    it('handles unbalanced markdown gracefully (no crash)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Each pathological input must not throw. Result format may vary;
      // contract is "no exception, output is a string".
      const cases = [
        '**unbalanced bold',
        '*unbalanced italic',
        '[link without closing](url',
        '[link]( without close',
        '[]()',
        '`unclosed code',
        '```\nunclosed fence',
        '***triple***',
        '****quad****',
        '* * * *',
        '[a](b)[c](d)',
      ];
      for (const input of cases) {
        await channel.sendMessage('slack:C0123456789', input);
      }
      // All N succeeded
      expect(currentApp().client.chat.postMessage.mock.calls.length).toBe(
        cases.length,
      );
    });

    it('handles multiple consecutive code spans correctly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'First `**code1**` then **bold** then `code2` end',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('First `**code1**` then *bold* then `code2` end');
    });

    it('preserves URL with query string + hash + spaces', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        'Try [this](https://x.io/path?a=1&b=2#section)',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('Try <https://x.io/path?a=1&b=2#section|this>');
    });

    it('translates bold inside list items', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        '• First **item**\n• Second **item**\n• Third *one*',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      // *bold* and *one* both stay as bold (no italic translation)
      expect(call.text).toBe('• First *item*\n• Second *item*\n• Third *one*');
    });

    it('handles empty input safely', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      // Empty text -> sendMessage doesn't translate (translator returns '')
      // But postMessage may reject empty — mock accepts everything
      await channel.sendMessage('slack:C0123456789', '');
      // No crash; postMessage was called (with empty text)
      expect(currentApp().client.chat.postMessage).toHaveBeenCalled();
    });

    it('truncates button text > 75 chars with ellipsis', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      const longLabel = 'X'.repeat(100);
      await channel.sendMessageWithKeyboard('slack:C0123456789', 'Pick:', [
        [{ text: longLabel, callback_data: 'a' }],
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      const btnText = call.blocks[1].elements[0].text.text;
      expect(btnText.length).toBeLessThanOrEqual(75);
      expect(btnText.endsWith('…')).toBe(true);
    });

    it('truncates action_id > 255 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      const longCallback = 'a:' + 'x'.repeat(300);
      await channel.sendMessageWithKeyboard('slack:C0123456789', 'Pick:', [
        [{ text: 'OK', callback_data: longCallback }],
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      const actionId = call.blocks[1].elements[0].action_id;
      expect(actionId.length).toBeLessThanOrEqual(255);
    });

    it('caps total blocks at 50 (drops extra keyboard rows)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      const keyboard = Array.from({ length: 60 }, (_, i) => [
        { text: `Btn${i}`, callback_data: `a:${i}` },
      ]);
      await channel.sendMessageWithKeyboard(
        'slack:C0123456789',
        'Header:',
        keyboard,
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.blocks.length).toBeLessThanOrEqual(50);
    });

    it('caps elements per actions block at 25 (Slack hard limit)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      const row = Array.from({ length: 30 }, (_, i) => ({
        text: `B${i}`,
        callback_data: `a:${i}`,
      }));
      await channel.sendMessageWithKeyboard('slack:C0123456789', 'Pick:', [
        row,
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.blocks[1].elements.length).toBe(25);
    });

    it('truncates section text over 3000 chars (Slack limit)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      const longText = 'x'.repeat(3500);
      await channel.sendMessageWithKeyboard('slack:C0123456789', longText, [
        [{ text: 'OK', callback_data: 'ok' }],
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      const sectionText = call.blocks[0].text.text;
      expect(sectionText.length).toBeLessThanOrEqual(3000);
      expect(sectionText).toContain('truncated');
    });

    it('applies translation in plain sendMessage too', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessage(
        'slack:C0123456789',
        '**Done** — see [details](https://x.io)',
      );
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('*Done* — see <https://x.io|details>');
    });
  });

  describe('block_action synthetic id includes action_ts', () => {
    it('uses action_ts to distinguish legitimate re-clicks from Bolt retries', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      // Simulate two clicks on the same button with different action_ts
      // (legitimate re-click after chat.update)
      const ack = vi.fn().mockResolvedValue(undefined);
      const body = {
        channel: { id: 'C0123456789' },
        message: { ts: '1704067200.000000' },
        user: { id: 'U_USER_456', username: 'alice' },
      };
      for (const { pattern, handler } of currentApp().actionHandlers) {
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        if (!re.test('a:7f3a')) continue;
        await handler({
          ack,
          action: {
            action_id: 'a:7f3a',
            action_ts: '1704067210.111',
          },
          body,
          client: currentApp().client,
        });
        await handler({
          ack,
          action: {
            action_id: 'a:7f3a',
            action_ts: '1704067220.222',
          },
          body,
          client: currentApp().client,
        });
      }

      expect(onMessage).toHaveBeenCalledTimes(2);
      const id1 = onMessage.mock.calls[0][1].id;
      const id2 = onMessage.mock.calls[1][1].id;
      expect(id1).not.toBe(id2);
      expect(id1).toContain('1704067210.111');
      expect(id2).toContain('1704067220.222');
    });
  });

  describe('ack failure early-return (block_actions + slash commands)', () => {
    it('block_action: returns early without onMessage when ack throws', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      // Override ack with one that throws
      const ack = vi.fn().mockRejectedValue(new Error('socket dropped'));
      const action = { action_id: 'a:7f3a' };
      const body = {
        channel: { id: 'C0123456789' },
        message: { ts: '1.0' },
        user: { id: 'U_USER_456' },
      };
      for (const { handler } of currentApp().actionHandlers) {
        await handler({ ack, action, body, client: currentApp().client });
      }
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('slash command: returns early without onMessage when ack throws', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockRejectedValue(new Error('socket dropped'));
      const command = {
        command: '/review',
        text: '',
        channel_id: 'C0123456789',
        user_id: 'U_USER_456',
        user_name: 'alice',
        trigger_id: 'TX',
      };
      for (const { handler } of currentApp().commandHandlers) {
        await handler({ ack, command, client: currentApp().client });
      }
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('block_action defensive paths (missing fields)', () => {
    it('drops action without channel context (warn + return)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      for (const { handler } of currentApp().actionHandlers) {
        await handler({
          ack,
          action: { action_id: 'a:7f3a', action_ts: '1.0' },
          body: {
            // no channel
            message: { ts: '1.0' },
            user: { id: 'U1' },
          },
          client: currentApp().client,
        });
      }
      expect(onMessage).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalled();
    });

    it('handles action without action_id, falls back to value', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      for (const { handler } of currentApp().actionHandlers) {
        await handler({
          ack,
          action: { value: 'fallback_value', action_ts: '1.0' },
          body: {
            channel: { id: 'C0123456789' },
            message: { ts: '1.0' },
            user: { id: 'U1' },
          },
          client: currentApp().client,
        });
      }
      expect(onMessage).toHaveBeenCalledTimes(1);
      const msg = onMessage.mock.calls[0][1];
      expect(msg.callback_data).toBe('fallback_value');
    });

    it('handles action with neither action_id nor value (defaults to empty string)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      for (const { handler } of currentApp().actionHandlers) {
        await handler({
          ack,
          action: { action_ts: '1.0' }, // no action_id, no value
          body: {
            channel: { id: 'C0123456789' },
            message: { ts: '1.0' },
            user: { id: 'U1' },
          },
          client: currentApp().client,
        });
      }
      // Empty data still delivered — skill side will see content="[callback] data="
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].callback_data).toBe('');
    });

    it('handles missing message.ts (action without original message context)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      for (const { handler } of currentApp().actionHandlers) {
        await handler({
          ack,
          action: { action_id: 'a:7f3a', action_ts: '1.0' },
          body: {
            channel: { id: 'C0123456789' },
            // no message
            user: { id: 'U1' },
          },
          client: currentApp().client,
        });
      }
      expect(onMessage).toHaveBeenCalledTimes(1);
      const msg = onMessage.mock.calls[0][1];
      // callback_message_id is undefined when no message
      expect(msg.callback_message_id).toBeUndefined();
      // synthetic id falls back to ISO timestamp instead of message_ts
      expect(msg.id).toContain(':a:7f3a:');
    });
  });

  describe('action_ts retry simulation (Bolt slow-ack retry)', () => {
    it('drops duplicate retry at the action handler so onMessage runs exactly once (ADV-8)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      const samePayload = {
        ack,
        action: { action_id: 'a:7f3a', action_ts: '1704067210.111' },
        body: {
          channel: { id: 'C0123456789' },
          message: { ts: '1704067200.000' },
          user: { id: 'U_USER_456' },
        },
        client: currentApp().client,
      };
      // Slack delivers the SAME payload twice when ack was slow on first try.
      // Dedup must catch the retry BEFORE it reaches onMessage — otherwise any
      // non-idempotent side effect downstream fires twice.
      for (const { handler } of currentApp().actionHandlers) {
        await handler(samePayload);
        await handler(samePayload);
      }

      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it('lets a legitimate re-click of the same button (different action_ts) through', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      const basePayload = {
        ack,
        body: {
          channel: { id: 'C0123456789' },
          message: { ts: '1704067200.000' },
          user: { id: 'U_USER_456' },
        },
        client: currentApp().client,
      };
      // Two distinct action_ts → two legit clicks → both delivered.
      for (const { handler } of currentApp().actionHandlers) {
        await handler({
          ...basePayload,
          action: { action_id: 'a:7f3a', action_ts: '1704067210.111' },
        });
        await handler({
          ...basePayload,
          action: { action_id: 'a:7f3a', action_ts: '1704067220.222' },
        });
      }

      expect(onMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('error shape coverage (WebAPIRequestError + generic Error)', () => {
    it('extracts message from WebAPIRequestError shape (no .data, has .message)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // WebAPIRequestError = network/transport error, has .message but no .data
      const networkErr = Object.assign(new Error('socket hangup'), {
        code: 'slack_webapi_request_error',
      });
      currentApp().client.chat.update.mockRejectedValueOnce(networkErr);

      // Should NOT swallow (errMsg='socket hangup' is not in any swallow set)
      await expect(
        channel.editMessage('slack:C0123456789', '1.0', 'x', null),
      ).rejects.toBeTruthy();
    });

    it('extracts message from generic Error (no .data, no .code)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.update.mockRejectedValueOnce(
        new Error('unexpected runtime'),
      );
      await expect(
        channel.editMessage('slack:C0123456789', '1.0', 'x', null),
      ).rejects.toBeTruthy();
    });
  });

  describe('action_ts monotonic counter fallback', () => {
    it('uses seq counter when action has no action_ts/ts', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const ack = vi.fn().mockResolvedValue(undefined);
      const body = {
        channel: { id: 'C0123456789' },
        message: { ts: '1.0' },
        user: { id: 'U_USER_456' },
      };
      // Two clicks, no action_ts on either
      for (let i = 0; i < 2; i++) {
        for (const { handler } of currentApp().actionHandlers) {
          await handler({
            ack,
            action: { action_id: 'a:7f3a' }, // no action_ts
            body,
            client: currentApp().client,
          });
        }
      }
      expect(onMessage).toHaveBeenCalledTimes(2);
      const id1 = onMessage.mock.calls[0][1].id;
      const id2 = onMessage.mock.calls[1][1].id;
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/seq\d+$/);
      expect(id2).toMatch(/seq\d+$/);
    });
  });

  describe('editMessage operational vs gone-forever errors', () => {
    it('warns on not_in_channel (operational, fixable) but does not throw', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      currentApp().client.chat.update.mockRejectedValueOnce({
        data: { error: 'not_in_channel' },
      });
      await expect(
        channel.editMessage('slack:C0123456789', '1.0', 'x', null),
      ).resolves.toBeUndefined();
    });

    it('debug-logs on edit_window_closed (gone forever)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      currentApp().client.chat.update.mockRejectedValueOnce({
        data: { error: 'edit_window_closed' },
      });
      await expect(
        channel.editMessage('slack:C0123456789', '1.0', 'x', null),
      ).resolves.toBeUndefined();
    });
  });

  describe('userNameCache LRU eviction', () => {
    it('evicts oldest entry when cache reaches capacity', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Force resolve 1001 distinct users — 1001st triggers eviction
      const cacheRef = (
        channel as unknown as {
          userNameCache: Map<string, string>;
        }
      ).userNameCache;
      // Mock users.info to return distinct names
      currentApp().client.users.info.mockImplementation(
        (args: { user: string }) =>
          Promise.resolve({ user: { real_name: `Name-${args.user}` } }),
      );

      // resolveUserName is private; trigger it via the action handler
      const ack = vi.fn().mockResolvedValue(undefined);
      for (let i = 0; i < 1001; i++) {
        for (const { handler } of currentApp().actionHandlers) {
          await handler({
            ack,
            action: { action_id: `a:${i}`, action_ts: `ts-${i}` },
            body: {
              channel: { id: 'C0123456789' },
              message: { ts: '1.0' },
              user: { id: `U-${i}` },
            },
            client: currentApp().client,
          });
        }
      }
      expect(cacheRef.size).toBeLessThanOrEqual(1000);
      // Oldest user (U-0) should have been evicted
      expect(cacheRef.has('U-0')).toBe(false);
      // Newest user (U-1000) must still be present
      expect(cacheRef.has('U-1000')).toBe(true);
    });
  });

  describe('sendMessageWithKeyboard empty text guard', () => {
    it('replaces empty text with "(no message)" placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessageWithKeyboard('slack:C0123456789', '', [
        [{ text: 'OK', callback_data: 'ok' }],
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('(no message)');
      expect(call.blocks[0].text.text).toBe('(no message)');
    });

    it('replaces whitespace-only text with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      await channel.sendMessageWithKeyboard('slack:C0123456789', '   \n  ', [
        [{ text: 'OK', callback_data: 'ok' }],
      ]);
      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toBe('(no message)');
    });
  });

  describe('flushOutgoingQueue rate-limit handling', () => {
    it('sleeps + retries on ratelimited (retry_after honored)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'msg-1');
      await channel.sendMessage('slack:C0123456789', 'msg-2');

      // 1st post hits rate-limit; 2nd succeeds.
      // retry_after=0.05 keeps the test fast (~50ms) while still exercising
      // the "honor retry_after value" code path. The source defensively
      // floors falsy values to 1s; using a positive value avoids triggering
      // that branch and keeps the unit test focused on the parse-and-sleep
      // behavior — not on the floor.
      let callCount = 0;
      currentApp().client.chat.postMessage.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject({
            data: {
              error: 'ratelimited',
              response_metadata: { retry_after: 0.05 },
            },
          });
        }
        return Promise.resolve({ ts: '1.0' });
      });

      await channel.connect();
      // Wait long enough for retry_after sleep (~50ms) + throttle (~100ms)
      // + scheduler overhead. 300ms is a safe margin without bloating the
      // suite runtime.
      await new Promise((r) => setTimeout(r, 300));

      // Both messages were eventually delivered (or in queue if still rate-limited)
      // Importantly: the queue isn't permanently broken
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('outgoingQueue cap', () => {
    it('drops oldest when queue reaches MAX_QUEUE_SIZE', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Force every send to fail so messages queue up
      currentApp().client.chat.postMessage.mockRejectedValue(
        new Error('network down'),
      );

      // Push beyond MAX_QUEUE_SIZE (500)
      for (let i = 0; i < 510; i++) {
        await channel.sendMessage('slack:C0123456789', `msg-${i}`);
      }

      // Internal queue should not exceed MAX_QUEUE_SIZE
      const internalQueue = (
        channel as unknown as {
          outgoingQueue: { jid: string; text: string }[];
        }
      ).outgoingQueue;
      expect(internalQueue.length).toBeLessThanOrEqual(500);
      // FIFO drop: pushed 510, cap 500, so oldest 10 (msg-0..msg-9) are gone
      // and msg-10..msg-509 remain in insertion order. Strictly assert the
      // ordering — a previous bug where the drop logic kept "newest only by
      // luck" would still satisfy a toBeDefined check on msg-509 alone.
      expect(internalQueue[0].text).toBe('msg-10');
      expect(internalQueue[internalQueue.length - 1].text).toBe('msg-509');
      expect(internalQueue.find((m) => m.text === 'msg-0')).toBeUndefined();
      expect(internalQueue.find((m) => m.text === 'msg-9')).toBeUndefined();
    });
  });

  describe('slash_commands handler', () => {
    it('registers a command handler covering all slash commands', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);
      expect(currentApp().commandHandlers.length).toBeGreaterThan(0);
    });

    it('acks slash command immediately', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);
      const ack = await triggerSlashCommand({ command: '/review' });
      expect(ack).toHaveBeenCalled();
    });

    it('synthesizes a message with the command text (slash stripped)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      await triggerSlashCommand({
        command: '/review',
        channel_id: 'C0123456789',
        user_id: 'U_USER_456',
      });

      expect(onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          chat_jid: 'slack:C0123456789',
          content: 'review',
          is_from_me: false,
        }),
      );
    });

    it('appends args after stripped command', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      await triggerSlashCommand({
        command: '/grade',
        text: '12345 approve',
      });

      const delivered = onMessage.mock.calls[0][1];
      expect(delivered.content).toBe('grade 12345 approve');
    });

    it('drops slash commands from unregistered chats', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({
        onMessage,
        registeredGroups: vi.fn(() => ({})),
      });
      new SlackChannel(opts);

      await triggerSlashCommand({ command: '/review' });
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('block_actions handler', () => {
    it('registers an action handler covering all action_ids', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);
      expect(currentApp().actionHandlers.length).toBeGreaterThan(0);
    });

    it('calls ack() immediately (Slack 3s window)', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      const ack = await triggerBlockAction({ action_id: 'a:7f3a' });
      expect(ack).toHaveBeenCalled();
    });

    it('synthesizes a [callback] message with callback_data + message_id', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      await triggerBlockAction({
        action_id: 'b:approve:K1',
        channel: 'C0123456789',
        message_ts: '1704067200.123456',
        user_id: 'U_USER_456',
        user_name: 'monica',
      });

      expect(onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          chat_jid: 'slack:C0123456789',
          callback_data: 'b:approve:K1',
          callback_message_id: '1704067200.123456',
          content:
            '[callback] data=b:approve:K1 original_message_id=1704067200.123456',
          is_from_me: false,
        }),
      );
    });

    it('drops actions from unregistered chats', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({
        onMessage,
        registeredGroups: vi.fn(() => ({})),
      });
      new SlackChannel(opts);

      await triggerBlockAction({ action_id: 'a:7f3a' });
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('still emits onChatMetadata for unregistered chats (group discovery)', async () => {
      const onChatMetadata = vi.fn();
      const opts = createTestOpts({
        onChatMetadata,
        registeredGroups: vi.fn(() => ({})),
      });
      new SlackChannel(opts);

      await triggerBlockAction({ action_id: 'a:7f3a' });
      expect(onChatMetadata).toHaveBeenCalled();
    });

    it('resolves user real_name when available', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      await triggerBlockAction({
        action_id: 'a:7f3a',
        user_id: 'U_USER_456',
        user_name: 'monica',
      });

      const delivered = onMessage.mock.calls[0][1];
      // resolveUserName mock returns 'Alice Smith'
      expect(delivered.sender_name).toBe('Alice Smith');
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- thread anchor + reaction id-shape guards (ADV-1) ---

  describe('thread anchor / reaction id-shape guards', () => {
    it('setActiveThread accepts real Slack ts and threads outbound replies', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      channel.setActiveThread('slack:C0123456789', '1704067200.123456');
      await channel.sendMessage('slack:C0123456789', 'Hello in thread');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C0123456789',
          text: 'Hello in thread',
          thread_ts: '1704067200.123456',
        }),
      );
    });

    it('setActiveThread rejects synthetic composite id (button-click callback) so chat.postMessage stays unthreaded', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // This is what slack.ts emits at line ~570 for a button click.
      const syntheticId = '1704067200.000000:b:approve:K1:1704067210.111';
      channel.setActiveThread('slack:C0123456789', syntheticId);
      await channel.sendMessage('slack:C0123456789', 'Hello');

      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call).not.toHaveProperty('thread_ts');
    });

    it('addReaction skips non-ts ids (button-click callbacks) instead of 400ing reactions.add', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const syntheticId = '1704067200.000000:b:approve:K1:1704067210.111';
      await channel.addReaction('slack:C0123456789', syntheticId, 'eyes');

      expect(currentApp().client.reactions.add).not.toHaveBeenCalled();
    });

    it('addReaction calls reactions.add for real Slack ts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.reactions.add.mockResolvedValueOnce({ ok: true });
      await channel.addReaction(
        'slack:C0123456789',
        '1704067200.123456',
        'eyes',
      );

      expect(currentApp().client.reactions.add).toHaveBeenCalledWith({
        channel: 'C0123456789',
        timestamp: '1704067200.123456',
        name: 'eyes',
      });
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });
});
