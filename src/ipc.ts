import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { InlineKeyboard, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMessageWithKeyboard?: (
    jid: string,
    text: string,
    keyboard: InlineKeyboard,
  ) => Promise<{ messageId: string }>;
  editMessage?: (
    jid: string,
    messageId: string,
    text: string,
    keyboard?: InlineKeyboard | null,
  ) => Promise<void>;
  deleteMessage?: (jid: string, messageId: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          // Sort for stable order: filenames are `${Date.now()}-${rand}.json`,
          // so lexicographic sort matches send order. readdirSync returns
          // filesystem dirent order (not sorted on ext4) — without this, an
          // edit_message can be processed before the corresponding
          // send_message_with_keyboard if both arrive within the same poll
          // tick, ack'd against the wrong message id.
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const targetGroup = registeredGroups[data.chatJid];
              const isAuthorized =
                !!data.chatJid &&
                (isMain || (targetGroup && targetGroup.folder === sourceGroup));

              if (data.type === 'message' && data.chatJid && data.text) {
                if (isAuthorized) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'message_with_keyboard' &&
                data.chatJid &&
                data.text &&
                Array.isArray(data.keyboard)
              ) {
                if (!isAuthorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC keyboard message blocked',
                  );
                } else if (!deps.sendMessageWithKeyboard) {
                  logger.warn(
                    { chatJid: data.chatJid },
                    'Keyboard send requested but channel does not support it',
                  );
                } else {
                  const res = await deps.sendMessageWithKeyboard(
                    data.chatJid,
                    data.text,
                    data.keyboard as InlineKeyboard,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      messageId: res.messageId,
                    },
                    'IPC keyboard message sent',
                  );
                  // Write ack so agent can correlate message_id for future edits.
                  const ackDir = path.join(ipcBaseDir, sourceGroup, 'acks');
                  fs.mkdirSync(ackDir, { recursive: true });
                  fs.writeFileSync(
                    path.join(ackDir, `${file}.ack`),
                    JSON.stringify({
                      correlation_id: data.correlation_id || null,
                      messageId: res.messageId,
                      chatJid: data.chatJid,
                    }),
                  );
                }
              } else if (
                data.type === 'delete_message' &&
                data.chatJid &&
                typeof data.messageId === 'string'
              ) {
                if (!isAuthorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC delete_message blocked',
                  );
                } else if (!deps.deleteMessage) {
                  logger.warn(
                    { chatJid: data.chatJid },
                    'delete_message requested but channel does not support it',
                  );
                } else {
                  await deps.deleteMessage(data.chatJid, data.messageId);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      messageId: data.messageId,
                    },
                    'IPC message deleted',
                  );
                }
              } else if (
                data.type === 'edit_message' &&
                data.chatJid &&
                typeof data.messageId === 'string' &&
                typeof data.text === 'string'
              ) {
                if (!isAuthorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC edit_message blocked',
                  );
                } else if (!deps.editMessage) {
                  logger.warn(
                    { chatJid: data.chatJid },
                    'edit_message requested but channel does not support it',
                  );
                } else {
                  // keyboard can be array / null / undefined — pass-through
                  const kb =
                    data.keyboard === null
                      ? null
                      : Array.isArray(data.keyboard)
                        ? (data.keyboard as InlineKeyboard)
                        : undefined;
                  await deps.editMessage(
                    data.chatJid,
                    data.messageId,
                    data.text,
                    kb,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      messageId: data.messageId,
                    },
                    'IPC message edited',
                  );
                }
              }
              // Tolerate ENOENT here: another reader (or manual cleanup)
              // may have already removed the file. Without this, the
              // throw cascades out of the for-loop and skips remaining
              // files in this tick; they'll be processed next tick, but
              // it's noisier and slower than necessary.
              try {
                fs.unlinkSync(filePath);
              } catch (unlinkErr) {
                if ((unlinkErr as { code?: string })?.code !== 'ENOENT')
                  throw unlinkErr;
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch (renameErr) {
                // ENOENT here means the file was already cleaned up by
                // another process; nothing left to quarantine.
                if ((renameErr as { code?: string })?.code !== 'ENOENT')
                  throw renameErr;
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              try {
                fs.unlinkSync(filePath);
              } catch (unlinkErr) {
                if ((unlinkErr as { code?: string })?.code !== 'ENOENT')
                  throw unlinkErr;
              }
            } catch (err) {
              // Classify so operators can tell parse-fail (file is malformed,
              // retry won't help → quarantine) from runtime-fail (DB write
              // may have already succeeded, requeueing would double-apply).
              // We still quarantine in both cases to bound retry, but the
              // distinct log message lets ops decide whether to manually
              // restore from errors/ (Reliability #4 mitigation; full
              // idempotent retry needs schema work, deferred).
              const isParseError = err instanceof SyntaxError;
              logger.error(
                {
                  file,
                  sourceGroup,
                  err,
                  classification: isParseError ? 'parse_error' : 'runtime_error',
                  hint: isParseError
                    ? 'File malformed; safe to delete'
                    : 'May have partially applied; check DB state before manual restore',
                },
                'Error processing IPC task — quarantining',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch (renameErr) {
                if ((renameErr as { code?: string })?.code !== 'ENOENT')
                  throw renameErr;
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        // Refuse silent folder swap on re-registration: if a JID already
        // owns one folder and a new register_group call points at a
        // different folder, the on-disk group dir would change while
        // isMain is preserved — a half-initialized group with empty
        // CLAUDE.md / no skills routes the next message to a broken
        // state. Folder migration must be a deliberate operation
        // (deregister + register), not an accidental field tweak
        // (Reliability #7 fix).
        if (existingGroup && existingGroup.folder !== data.folder) {
          logger.warn(
            {
              jid: data.jid,
              existingFolder: existingGroup.folder,
              attemptedFolder: data.folder,
            },
            'register_group attempted to change folder for existing JID — refusing. Use deregister+register for migration.',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
