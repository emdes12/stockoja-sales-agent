import type { Db, Queryable } from '../db/pool.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import { env } from '../config.js';
import { getState, setState } from '../settings.js';
import { HoldForReviewError } from '../queue/queue.js';
import { socialHandle } from '../outreach/channels.js';
import { autoAnswer, recordReply } from '../inbox/process.js';
import { upsertContact } from '../inbox/contacts.js';
import { maybeAutoApprove } from '../outreach/autonomy.js';
import { explainMetaError, graph, graphNext, igUserId, MetaApiError, metaConfigProblems } from './graph.js';

/**
 * Reads messages people sent to StockỌja's Facebook Page and Instagram account, read-only, by asking Meta for
 * recent conversations (no webhook, so nothing on this laptop has to be reachable from the internet).
 *
 * - A message from someone tied to a lead (an Instagram username on the lead, or a person you linked before)
 *   is recorded as that lead's reply, labelled, and answered with a draft like an email reply.
 * - Anyone else is kept in the inbox under their contact (not a lead yet): you can answer, link them to a lead,
 *   add them as a new lead, or ignore them.
 * Each message is stored once (by Meta's message id), so checking again is harmless.
 */

export const TASK_CHECK_META = 'meta.check_inbox';
export type MetaPlatform = 'instagram' | 'facebook';

interface GraphMessage {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; username?: string; name?: string };
  attachments?: unknown;
}
interface GraphConversation {
  id: string;
  updated_time: string;
  messages?: { data: GraphMessage[] };
}
interface Page<T> {
  data: T[];
  paging?: { next?: string };
}

export interface MetaCheckResult {
  conversations: number;
  replies: number;
  unmatched: number;
  duplicates: number;
  drafted: number;
  autoApproved: number;
}

/** Most conversation pages read per platform per check; the rest wait for the next one. */
const MAX_PAGES = 8;

export const externalId = (platform: MetaPlatform, mid: string) => `${platform}:${mid}`;

/** A lead whose Instagram profile is this username (one lead only; two would be ambiguous). */
export async function leadForInstagram(db: Queryable, username: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number; ig: string }>(
    `SELECT id, socials->>'instagram' AS ig FROM leads WHERE socials ? 'instagram' AND position($1 in lower(socials->>'instagram')) > 0`,
    [username.toLowerCase()],
  );
  const hits = rows.filter((r) => socialHandle('instagram', r.ig) === username.toLowerCase());
  return hits.length === 1 ? hits[0]!.id : null;
}

export async function checkMetaInbox(db: Db, settings: Settings, opts: { signal?: AbortSignal } = {}): Promise<MetaCheckResult> {
  const result: MetaCheckResult = { conversations: 0, replies: 0, unmatched: 0, duplicates: 0, drafted: 0, autoApproved: 0 };
  const ownIds = new Set([env.META_PAGE_ID]);
  if (settings.metaInboxPlatforms.includes('instagram')) ownIds.add(await igUserId(db));

  for (const platform of settings.metaInboxPlatforms.filter((p) => settings.inboxAccess[p])) {
    const stateKey = `meta.cursor.${platform}`;
    const saved = await getState<{ since: string }>(db, stateKey);
    const since = saved ? new Date(saved.since) : new Date(Date.now() - settings.metaInboxLookbackDays * 86_400_000);
    let newest = since;
    let page: Page<GraphConversation> | null = await graph<Page<GraphConversation>>(db, `${env.META_PAGE_ID}/conversations`, {
      params: {
        platform: platform === 'facebook' ? 'messenger' : 'instagram',
        fields: 'id,updated_time,messages.limit(25){id,message,created_time,from,attachments}',
        limit: 25,
      },
      signal: opts.signal,
      kind: `${platform}_inbox`,
    });
    let pages = 0;
    let older = false;
    while (page && !older && !opts.signal?.aborted) {
      for (const conv of page.data) {
        const updated = new Date(conv.updated_time);
        // Conversations come newest first: stop at the first one with nothing new.
        if (updated <= since) {
          older = true;
          break;
        }
        result.conversations++;
        if (updated > newest) newest = updated;
        // Oldest first, so a lead's replies are recorded in the order they were written.
        const msgs = [...(conv.messages?.data ?? [])].reverse();
        for (const m of msgs) {
          const at = new Date(m.created_time);
          if (!m.from || ownIds.has(m.from.id) || at <= since) continue;
          await handleMessage(platform, conv.id, m, at);
        }
      }
      pages++;
      page = !older && page.paging?.next && pages < MAX_PAGES ? await graphNext<Page<GraphConversation>>(db, page.paging.next, opts.signal) : null;
    }
    await setState(db, stateKey, { since: newest.toISOString() });
  }

  async function handleMessage(platform: MetaPlatform, threadId: string, m: GraphMessage, at: Date) {
    const from = m.from!;
    const text = m.message?.trim() || (m.attachments ? '(A photo, voice note or file: open the chat to see it.)' : '(no text)');
    const contact = await upsertContact(db, platform, from.id, { username: from.username ?? null, name: from.name ?? null, threadId, at });
    let leadId = contact.lead_id;
    if (!leadId && platform === 'instagram' && from.username) {
      leadId = await leadForInstagram(db, from.username);
      if (leadId) await db.query(`UPDATE social_contacts SET lead_id = $2, updated_at = now() WHERE id = $1`, [contact.id, leadId]);
    }
    const who = from.username ? `@${from.username.toLowerCase()}` : (from.name ?? 'Messenger user');
    const mid = externalId(platform, m.id);
    const recorded = await recordReply(db, leadId, {
      channel: platform, from: who, subject: '', text, date: at, messageId: mid, source: 'meta', socialContactId: contact.id,
    });
    if (!recorded) {
      result.duplicates++;
      return;
    }
    if (leadId) result.replies++;
    else result.unmatched++;
    const answer = await autoAnswer(db, recorded.msg, settings);
    if (answer && 'drafted' in answer) {
      result.drafted++;
      if (await maybeAutoApprove(db, answer.drafted.id, settings)) result.autoApproved++;
    }
  }

  await setState(db, 'meta.lastCheck', { at: new Date().toISOString(), ...result });
  return result;
}

export const metaInboxHandlers: Record<string, TaskHandler> = {
  [TASK_CHECK_META]: {
    // Read-only and de-duplicated by message id: safe to repeat.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, signal, settings, log }) {
      if (!settings.metaInboxEnabled) return { skipped: 'Instagram/Facebook inbox is off' };
      const problems = metaConfigProblems();
      if (problems.length) throw new HoldForReviewError(`Meta app is not set up: ${problems.map((p) => p.message).join(' ')}`);
      try {
        const r = await checkMetaInbox(db, settings, { signal });
        if (r.replies || r.unmatched) log.info(`Instagram/Facebook: ${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'}, ${r.drafted} draft(s), ${r.unmatched} to match by hand`);
        return r;
      } catch (err) {
        throw err instanceof MetaApiError ? explainMetaError(err) : err;
      }
    },
  },
};

export const metaInboxRecurring: RecurringJob[] = [
  {
    type: TASK_CHECK_META,
    everyMinutes: (s) => s.metaInboxCheckMinutes,
    enabled: (s) => s.metaInboxEnabled && s.metaInboxPlatforms.length > 0 && metaConfigProblems().length === 0,
  },
];
