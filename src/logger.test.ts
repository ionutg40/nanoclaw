import { describe, it, expect, vi, afterEach } from 'vitest';

// Capture both stdout and stderr — info/debug write to stdout, warn/error/fatal
// to stderr, and we want to assert against logs from any level.
function captureStdio(): {
  read: () => string;
  restore: () => void;
} {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let buf = '';
  const sink = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    read: () => buf,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger credential redaction', () => {
  it('redacts xoxb tokens out of err.stack', async () => {
    const { logger } = await import('./logger.js');
    const cap = captureStdio();
    try {
      const err = new Error(
        'Slack API failed (config.headers.Authorization=Bearer xoxb-1234567890-ABCDEFGHIJ)',
      );
      logger.error({ err }, 'transport failure');
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain('xoxb-1234567890-ABCDEFGHIJ');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts xapp tokens', async () => {
    const { logger } = await import('./logger.js');
    const cap = captureStdio();
    try {
      logger.error(
        { detail: 'token=xapp-1-A0BC-12345-deadbeef' },
        'app-token leak',
      );
    } finally {
      cap.restore();
    }
    expect(cap.read()).not.toContain('xapp-1-A0BC-12345-deadbeef');
  });

  it('redacts Anthropic sk-ant keys', async () => {
    const { logger } = await import('./logger.js');
    const cap = captureStdio();
    try {
      logger.warn(
        { config: { apiKey: 'sk-ant-api03-AbcDef_123-xyz' } },
        'config dump',
      );
    } finally {
      cap.restore();
    }
    expect(cap.read()).not.toContain('sk-ant-api03-AbcDef_123-xyz');
  });

  it('redacts bare Bearer header strings', async () => {
    const { logger } = await import('./logger.js');
    const cap = captureStdio();
    try {
      logger.error({ raw: 'Authorization: Bearer abc.def.ghi-jkl' }, 'leak');
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain('Bearer abc.def.ghi-jkl');
    expect(out).toContain('[REDACTED]');
  });

  it('keeps non-credential strings unredacted', async () => {
    const { logger } = await import('./logger.js');
    const cap = captureStdio();
    try {
      logger.info({ jid: 'slack:C0123456789', length: 42 }, 'sent');
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).toContain('slack:C0123456789');
    expect(out).toContain('42');
    expect(out).not.toContain('REDACTED');
  });
});
