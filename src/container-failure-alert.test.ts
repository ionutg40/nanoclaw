import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordContainerFailure,
  recordContainerSuccess,
  formatFailureAlert,
  formatRecoveryMessage,
  CAPYEAR_ALERT_GROUP_JID,
  type FailureStreaks,
} from './container-failure-alert.js';

const OTHER_JID = 'slack:C0000000000';

describe('recordContainerFailure', () => {
  let streaks: FailureStreaks;
  beforeEach(() => {
    streaks = new Map();
  });

  it('does not alert on the first two consecutive failures', () => {
    expect(recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID)).toEqual({
      shouldAlert: false,
      count: 1,
    });
    expect(recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID)).toEqual({
      shouldAlert: false,
      count: 2,
    });
  });

  it('alerts exactly on the 3rd consecutive failure', () => {
    recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    const third = recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    expect(third).toEqual({ shouldAlert: true, count: 3 });
  });

  it('does not re-alert on the 4th, 5th... consecutive failure', () => {
    for (let i = 0; i < 3; i++) recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    const fourth = recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    const fifth = recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    expect(fourth.shouldAlert).toBe(false);
    expect(fifth.shouldAlert).toBe(false);
  });

  it('never alerts for a group other than the CapYear client group', () => {
    for (let i = 0; i < 5; i++) {
      expect(recordContainerFailure(streaks, OTHER_JID).shouldAlert).toBe(false);
    }
  });
});

describe('recordContainerSuccess', () => {
  let streaks: FailureStreaks;
  beforeEach(() => {
    streaks = new Map();
  });

  it('sends no recovery message if the group never alerted', () => {
    recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    expect(recordContainerSuccess(streaks, CAPYEAR_ALERT_GROUP_JID)).toEqual({
      shouldSendRecovery: false,
    });
  });

  it('sends exactly one recovery message after an alerted streak clears', () => {
    for (let i = 0; i < 3; i++) recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    expect(recordContainerSuccess(streaks, CAPYEAR_ALERT_GROUP_JID)).toEqual({
      shouldSendRecovery: true,
    });
    // a second consecutive success (or a lone success) must not re-fire
    expect(recordContainerSuccess(streaks, CAPYEAR_ALERT_GROUP_JID)).toEqual({
      shouldSendRecovery: false,
    });
  });

  it('re-arms the alert after a fresh 3-failure streak post-recovery', () => {
    for (let i = 0; i < 3; i++) recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    recordContainerSuccess(streaks, CAPYEAR_ALERT_GROUP_JID);
    const third = (() => {
      recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
      recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
      return recordContainerFailure(streaks, CAPYEAR_ALERT_GROUP_JID);
    })();
    expect(third.shouldAlert).toBe(true);
  });

  it('is a no-op for a group other than the CapYear client group', () => {
    expect(recordContainerSuccess(streaks, OTHER_JID)).toEqual({
      shouldSendRecovery: false,
    });
  });
});

describe('formatFailureAlert', () => {
  it('extracts the exit code and first stderr line', () => {
    const msg = formatFailureAlert(
      'CapYear Client Channel',
      "Container exited with code 125: Unable to find image 'nanoclaw-agent:latest' locally\ndocker: Error response from daemon: pull access denied",
    );
    expect(msg).toContain('CapYear Client Channel');
    expect(msg).toContain('125');
    expect(msg).toContain("Unable to find image 'nanoclaw-agent:latest' locally");
    expect(msg).not.toContain('pull access denied');
  });

  it('falls back gracefully when the error string has no code', () => {
    const msg = formatFailureAlert('CapYear Client Channel', 'some unexpected error');
    expect(msg).toContain('unknown');
  });
});

describe('formatRecoveryMessage', () => {
  it('names the group', () => {
    expect(formatRecoveryMessage('CapYear Client Channel')).toContain(
      'CapYear Client Channel',
    );
  });
});
