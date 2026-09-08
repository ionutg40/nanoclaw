/**
 * T11.7: alert when the CapYear interactive container cannot start.
 *
 * Origin: the container was dead 2026-09-07 14:07 to 2026-09-08 19:37 UTC
 * (24x "Container exited with code 125", `nanoclaw-agent:latest` image
 * missing) with zero alerts — heartbeats/drains/auto-ingest are host-side
 * timers on a different codepath (grade_verifier) and never observe the
 * interactive container's own exit code. This module is the missing signal
 * for THIS codepath: N consecutive container spawn failures for the CapYear
 * client group fire one DM, and a subsequent success fires one recovery DM.
 */

export const CAPYEAR_ALERT_GROUP_JID = 'slack:C0AU7PHUJBX';
export const CAPYEAR_ALERT_DM_JID = 'slack:D0B2HE46UG2';
export const CONTAINER_FAILURE_ALERT_THRESHOLD = 3;

export interface FailureStreakState {
  count: number;
  alerted: boolean;
}

export type FailureStreaks = Map<string, FailureStreakState>;

export function recordContainerFailure(
  streaks: FailureStreaks,
  groupJid: string,
): { shouldAlert: boolean; count: number } {
  if (groupJid !== CAPYEAR_ALERT_GROUP_JID) return { shouldAlert: false, count: 0 };
  const state = streaks.get(groupJid) || { count: 0, alerted: false };
  state.count++;
  streaks.set(groupJid, state);
  const shouldAlert =
    state.count === CONTAINER_FAILURE_ALERT_THRESHOLD && !state.alerted;
  if (shouldAlert) state.alerted = true;
  return { shouldAlert, count: state.count };
}

export function recordContainerSuccess(
  streaks: FailureStreaks,
  groupJid: string,
): { shouldSendRecovery: boolean } {
  if (groupJid !== CAPYEAR_ALERT_GROUP_JID) return { shouldSendRecovery: false };
  const state = streaks.get(groupJid);
  const wasAlerted = state?.alerted === true;
  streaks.set(groupJid, { count: 0, alerted: false });
  return { shouldSendRecovery: wasAlerted };
}

/** Pull exit code + first non-empty stderr line out of container-runner's
 * `Container exited with code ${code}: ${stderr.slice(-200)}` error string. */
export function formatFailureAlert(groupName: string, error: string): string {
  const codeMatch = error.match(/code (\d+)/);
  const code = codeMatch ? codeMatch[1] : 'unknown';
  const afterColon = error.includes(': ')
    ? error.slice(error.indexOf(': ') + 2)
    : '';
  const firstLine =
    afterColon
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) || afterColon.trim();
  return (
    `Container for "${groupName}" has failed to start ${CONTAINER_FAILURE_ALERT_THRESHOLD} ` +
    `times in a row. Exit code: ${code}. First stderr line: ${firstLine.slice(0, 300)}`
  );
}

export function formatRecoveryMessage(groupName: string): string {
  return `Container for "${groupName}" started successfully again after failing to start.`;
}
