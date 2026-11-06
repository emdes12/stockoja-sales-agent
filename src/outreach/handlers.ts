import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import { autoDraft } from './messages.js';
import { maybeAutoApprove } from './autonomy.js';
import { draftOutreach } from '../ai/write.js';

const PAUSE_AI = new Set(['AI_UNAVAILABLE', 'AI_RATE_LIMITED', 'AI_LIMIT', 'AI_BUDGET', 'AI_NOT_CONFIGURED']);

export const TASK_AUTO_DRAFT = 'outreach.auto_draft';

export const outreachHandlers: Record<string, TaskHandler> = {
  [TASK_AUTO_DRAFT]: {
    // Drafting is idempotent (one live message per lead/channel/step) and only creates drafts for you to review.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, settings, log }) {
      let aiStopped: string | null = null;
      const result = await autoDraft(db, settings, {
        // Written by AI for each lead when AI drafting is on; the template whenever AI isn't available. Once Gemini
        // is unavailable (after its retries and backup models) or over budget, the rest of this run uses templates.
        draftIntro: (leadId, channel) =>
          draftOutreach(db, leadId, channel, settings, {
            createdBy: 'agent',
            useAi: !aiStopped,
            // A busy Gemini (after retries and backups) or a reached limit pauses AI for this run; a single odd answer doesn't.
            onAiError: (err) => {
              if (PAUSE_AI.has(err.code)) aiStopped = err.message;
            },
          }),
      });
      if (aiStopped) log.warn(`AI drafting paused for the rest of this run, templates used instead: ${aiStopped}`);
      let autoApproved = 0;
      for (const id of result.messageIds) if (await maybeAutoApprove(db, id, settings)) autoApproved++;
      if (result.created || Object.keys(result.skipped).length) {
        const skipped = Object.entries(result.skipped).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
        log.info(
          `Drafted ${result.created} message(s)${autoApproved ? `, ${autoApproved} approved automatically (Controlled Autonomous Mode)` : ' for approval'}` +
            `${skipped ? `; skipped ${skipped}` : ''}; ${result.remainingToday} left today`,
        );
      }
      return { ...result, autoApproved };
    },
  },
};

export const outreachRecurring: RecurringJob[] = [
  {
    type: TASK_AUTO_DRAFT,
    everyMinutes: 30,
    enabled: (s) => s.autoDraft && s.mode !== 'research' && !!s.senderName && s.dailyDraftLimit > 0,
  },
];
