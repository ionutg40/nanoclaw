import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
// IDLE_TIMEOUT is the grace period after the last agent result before the host
// sends `_close` to the container. It MUST be shorter than CONTAINER_TIMEOUT so
// graceful close fires before SIGKILL. Default: 5min (300_000ms). Override via env.
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '300000', 10);

// Programmatic activity feedback while the agent processes a message.
// TYPING_REFRESH_MS: re-send the typing indicator at this interval (Telegram's
// "typing..." action expires after ~5s). Set to 0 to disable refresh.
// SILENCE_ACK_MS: if no agent output reaches the user within this window,
// the host sends a randomly-chosen ack message to the chat — independent of
// whether the LLM remembered to ack. Set MS to 0 to disable.
// SILENCE_ACK_MESSAGE: env override. If set, becomes the only ack text used.
// If empty string, ack is disabled. If unset, host picks a random line from
// SILENCE_ACK_DEFAULTS so back-to-back acks feel less robotic.
export const TYPING_REFRESH_MS = parseInt(
  process.env.TYPING_REFRESH_MS || '4000',
  10,
);
export const SILENCE_ACK_MS = parseInt(
  process.env.SILENCE_ACK_MS || '8000',
  10,
);

const SILENCE_ACK_DEFAULTS: string[] = [
  '⏳ Lucrez...',
  '⏳ Mestec datele...',
  '⏳ Sap prin arhive...',
  '⏳ Frământ ideea...',
  '⏳ Macin gânduri...',
  '⏳ Țes răspunsul...',
  '⏳ Aprind sinapsele...',
  '⏳ Învârt rotițele...',
  '⏳ Distilez...',
  '⏳ Rumeg datele...',
  '⏳ Storc creierul...',
  '⏳ Compilez neuroni...',
  '⏳ Scotocesc prin context...',
  '⏳ Fierb la foc mic...',
  '⏳ Disec problema...',
  '⏳ Adulmec răspunsul...',
  '⏳ Învârt manivela...',
  '⏳ Pun creierul la treabă...',
  '⏳ Trag de fir...',
  '⏳ Calculez ocult...',
];

// Slack runs in English-speaking workspaces (CapYear), so the ack list is
// translated rather than reusing the Romanian defaults.
const SILENCE_ACK_DEFAULTS_EN: string[] = [
  '🤔 Thinking...',
  '🤔 On it...',
  '🤔 Digging in...',
  '🤔 Crunching the data...',
  '🤔 Working on it...',
  '🤔 Let me check...',
  '🤔 Pulling threads...',
  '🤔 Looking into it...',
  '🤔 Processing...',
  '🤔 Putting it together...',
];

export const SILENCE_ACK_MESSAGES: string[] =
  process.env.SILENCE_ACK_MESSAGE !== undefined
    ? process.env.SILENCE_ACK_MESSAGE === ''
      ? []
      : [process.env.SILENCE_ACK_MESSAGE]
    : SILENCE_ACK_DEFAULTS;

// Per-channel ack pool. The orchestrator picks by `channel.name`; falls back
// to SILENCE_ACK_MESSAGES when a channel has no entry.
export const SILENCE_ACK_MESSAGES_BY_CHANNEL: Record<string, string[]> = {
  slack: SILENCE_ACK_DEFAULTS_EN,
};
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
