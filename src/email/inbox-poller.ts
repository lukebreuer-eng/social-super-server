import crypto from 'crypto';
import { createItem, readItems, updateItem } from '@directus/sdk';
import { directus } from '../config/directus';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  ParsedInboxMessage,
  appendToSentFolder,
  fetchRecentMessages,
  getIjsImapConfig,
} from './imap-client';
import { buildRfc822, getIjsSmtpConfig, sendReply } from './smtp-sender';
import { generateEmailReply } from '../ai-engine/email-agent';

interface ThreadRecord {
  id: number;
  thread_key: string;
  status: string;
  message_count: number;
}

export async function isAgentEnabled(): Promise<boolean> {
  return env.IJS_EMAIL_AGENT_ENABLED === 'true';
}

/**
 * Eén poll-cyclus voor IJs:
 * 1. Haal recente mails op (zonder Seen-flag te zetten)
 * 2. Dedup op Message-ID
 * 3. Per nieuwe mail: thread vinden/maken, opslaan, AI-agent triggeren
 */
export async function pollIjsInbox(): Promise<{ fetched: number; saved: number; replied: number; autoSent: number }> {
  const imapCfg = getIjsImapConfig();
  if (!imapCfg) {
    logger.warn('IJS inbox poll skipped: IJS_INBOX_PASSWORD not set');
    return { fetched: 0, saved: 0, replied: 0, autoSent: 0 };
  }

  const sinceHours = parseInt(env.IJS_POLL_LOOKBACK_HOURS, 10);
  const bedrijfId = parseInt(env.IJS_EMAIL_BEDRIJF_ID, 10);
  const ownAddress = env.IJS_INBOX_USER.toLowerCase();

  logger.info(`Polling IJS inbox (lookback ${sinceHours}h)`);

  const messages = await fetchRecentMessages(imapCfg, sinceHours);
  logger.info(`Fetched ${messages.length} recent messages from IJS inbox`);

  let saved = 0;
  let replied = 0;
  let autoSent = 0;

  for (const msg of messages) {
    // Skip messages sent by ourselves (loop protection)
    if (msg.from.email === ownAddress) continue;
    if (msg.to.includes(ownAddress) === false && msg.cc.includes(ownAddress) === false) {
      // mail die niet aan ons gericht is (bv. via subadres) negeren
      continue;
    }

    try {
      const existing = await findMessageByMessageId(msg.messageId);
      if (existing) continue;

      const thread = await findOrCreateThread(bedrijfId, msg);
      await storeInboundMessage(thread.id, msg);
      saved++;

      // alleen reply genereren voor threads die niet al door mens beheerd zijn
      if (['resolved', 'archived', 'spam'].includes(thread.status)) {
        await touchThread(thread.id, msg);
        continue;
      }

      const result = await handleAgentReply(bedrijfId, thread.id, msg);
      if (result.replied) replied++;
      if (result.autoSent) autoSent++;

      await touchThread(thread.id, msg);
    } catch (err) {
      logger.error(`Failed to process inbound message ${msg.messageId}:`, err);
    }
  }

  return { fetched: messages.length, saved, replied, autoSent };
}

async function findMessageByMessageId(messageId: string): Promise<{ id: number } | null> {
  if (!messageId) return null;
  const rows = await directus.request(
    readItems('Email_Messages', {
      filter: { message_id: { _eq: messageId } } as any,
      limit: 1,
      fields: ['id'] as any,
    }),
  ) as any[];
  return rows[0] || null;
}

async function findOrCreateThread(bedrijfId: number, msg: ParsedInboxMessage): Promise<ThreadRecord> {
  const subjectKey = normalizeSubject(msg.subject);
  const threadKey = crypto
    .createHash('sha1')
    .update(`${bedrijfId}|${msg.from.email}|${subjectKey}`)
    .digest('hex')
    .slice(0, 32);

  const existing = await directus.request(
    readItems('Email_Threads', {
      filter: { thread_key: { _eq: threadKey } } as any,
      limit: 1,
      fields: ['id', 'thread_key', 'status', 'message_count'] as any,
    }),
  ) as any[];

  if (existing[0]) return existing[0] as ThreadRecord;

  // Try matching by In-Reply-To header → if previous outbound's message_id
  if (msg.inReplyTo) {
    const linked = await directus.request(
      readItems('Email_Messages', {
        filter: { message_id: { _eq: msg.inReplyTo } } as any,
        limit: 1,
        fields: ['thread'] as any,
      }),
    ) as any[];
    if (linked[0]?.thread) {
      const rows = await directus.request(
        readItems('Email_Threads', {
          filter: { id: { _eq: linked[0].thread } } as any,
          limit: 1,
          fields: ['id', 'thread_key', 'status', 'message_count'] as any,
        }),
      ) as any[];
      if (rows[0]) return rows[0] as ThreadRecord;
    }
  }

  const created = await directus.request(
    createItem('Email_Threads', {
      bedrijf: bedrijfId,
      from_email: msg.from.email,
      from_name: msg.from.name,
      subject: msg.subject,
      status: 'new',
      message_count: 0,
      has_pending_draft: false,
      first_received_at: msg.receivedAt.toISOString(),
      last_message_at: msg.receivedAt.toISOString(),
      thread_key: threadKey,
    }),
  ) as any;

  return {
    id: created.id,
    thread_key: threadKey,
    status: 'new',
    message_count: 0,
  };
}

async function storeInboundMessage(threadId: number, msg: ParsedInboxMessage): Promise<void> {
  await directus.request(
    createItem('Email_Messages', {
      thread: threadId,
      direction: 'inbound',
      status: 'received',
      from_email: msg.from.email,
      from_name: msg.from.name,
      to_emails: msg.to,
      cc_emails: msg.cc,
      subject: msg.subject,
      body_plain: msg.textBody.slice(0, 60000),
      body_html: msg.htmlBody.slice(0, 200000),
      message_id: msg.messageId || null,
      in_reply_to: msg.inReplyTo,
      imap_uid: msg.uid,
      received_at: msg.receivedAt.toISOString(),
      attachments: msg.attachments,
    }),
  );
}

async function handleAgentReply(
  bedrijfId: number,
  threadId: number,
  msg: ParsedInboxMessage,
): Promise<{ replied: boolean; autoSent: boolean }> {
  const history = await fetchThreadHistory(threadId);

  let draft;
  try {
    draft = await generateEmailReply(bedrijfId, {
      fromEmail: msg.from.email,
      fromName: msg.from.name,
      subject: msg.subject,
      bodyPlain: msg.textBody || stripHtml(msg.htmlBody),
      receivedAt: msg.receivedAt,
      threadHistory: history,
    });
  } catch (err) {
    logger.error(`AI reply generation failed for thread ${threadId}:`, err);
    await directus.request(updateItem('Email_Threads', threadId, { status: 'awaiting_review' }));
    return { replied: false, autoSent: false };
  }

  if (draft.category === 'spam') {
    await directus.request(updateItem('Email_Threads', threadId, {
      status: 'spam',
      ai_category: 'spam',
      ai_summary: draft.summary,
    }));
    return { replied: false, autoSent: false };
  }

  // Save reasoning + category on thread
  await directus.request(updateItem('Email_Threads', threadId, {
    ai_category: draft.category,
    ai_priority: draft.priority,
    ai_summary: draft.summary,
  }));

  if (!draft.shouldAutoSend) {
    const draftMessageId = generateMessageId();
    await directus.request(
      createItem('Email_Messages', {
        thread: threadId,
        direction: 'draft',
        status: 'draft',
        from_email: env.IJS_INBOX_USER,
        from_name: env.IJS_FROM_NAME,
        to_emails: [msg.from.email],
        subject: draft.subject,
        body_plain: draft.bodyPlain,
        body_html: draft.bodyHtml,
        message_id: draftMessageId,
        in_reply_to: msg.messageId || null,
        ai_generated: true,
        ai_confidence: draft.confidence,
        ai_reasoning: draft.reasoning,
      }),
    );
    await directus.request(updateItem('Email_Threads', threadId, {
      status: 'awaiting_review',
      has_pending_draft: true,
    }));
    return { replied: true, autoSent: false };
  }

  // Auto-send path
  const sent = await sendAndArchive({
    threadId,
    toEmail: msg.from.email,
    subject: draft.subject,
    bodyPlain: draft.bodyPlain,
    bodyHtml: draft.bodyHtml,
    inReplyTo: msg.messageId || undefined,
    references: msg.messageId ? [msg.messageId] : undefined,
    aiGenerated: true,
    aiConfidence: draft.confidence,
    aiReasoning: draft.reasoning,
  });

  if (sent.ok) {
    await directus.request(updateItem('Email_Threads', threadId, {
      status: 'auto_replied',
      has_pending_draft: false,
    }));
    return { replied: true, autoSent: true };
  } else {
    // val terug op draft als verzenden mislukt
    await directus.request(updateItem('Email_Threads', threadId, {
      status: 'awaiting_review',
      has_pending_draft: true,
    }));
    return { replied: true, autoSent: false };
  }
}

interface SendArchiveInput {
  threadId: number;
  toEmail: string;
  cc?: string[];
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
  inReplyTo?: string;
  references?: string[];
  aiGenerated: boolean;
  aiConfidence?: number;
  aiReasoning?: string;
  sentByUserId?: string;
  draftMessageDbId?: number;
  editedByHuman?: boolean;
}

export async function sendAndArchive(input: SendArchiveInput): Promise<{ ok: boolean; error?: string; messageDbId?: number }> {
  const smtpCfg = getIjsSmtpConfig();
  const imapCfg = getIjsImapConfig();
  if (!smtpCfg || !imapCfg) {
    return { ok: false, error: 'IJS_INBOX_PASSWORD not configured' };
  }

  try {
    const send = await sendReply(smtpCfg, {
      to: input.toEmail,
      cc: input.cc,
      subject: input.subject,
      textBody: input.bodyPlain,
      htmlBody: input.bodyHtml,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    // Bouw RFC822 voor IMAP APPEND (Outlook ziet de outgoing)
    try {
      const rfc822 = await buildRfc822(smtpCfg, {
        to: input.toEmail,
        cc: input.cc,
        subject: input.subject,
        textBody: input.bodyPlain,
        htmlBody: input.bodyHtml,
        inReplyTo: input.inReplyTo,
        references: input.references,
      }, send.messageId);
      await appendToSentFolder(imapCfg, rfc822);
    } catch (appendErr) {
      logger.warn('Could not append outbound mail to Sent folder:', appendErr);
    }

    // Schrijf het verstuurde bericht naar Directus (of update bestaande draft)
    let messageDbId: number;
    if (input.draftMessageDbId) {
      const updated = await directus.request(updateItem('Email_Messages', input.draftMessageDbId, {
        direction: 'outbound',
        status: input.aiGenerated && !input.editedByHuman ? 'auto_sent' : 'sent',
        message_id: send.messageId,
        sent_at: new Date().toISOString(),
        sent_by: input.sentByUserId || null,
        edited_by_human: !!input.editedByHuman,
      })) as any;
      messageDbId = updated.id;
    } else {
      const created = await directus.request(
        createItem('Email_Messages', {
          thread: input.threadId,
          direction: 'outbound',
          status: input.aiGenerated && !input.editedByHuman ? 'auto_sent' : 'sent',
          from_email: smtpCfg.fromEmail,
          from_name: smtpCfg.fromName,
          to_emails: [input.toEmail],
          cc_emails: input.cc || [],
          subject: input.subject,
          body_plain: input.bodyPlain,
          body_html: input.bodyHtml,
          message_id: send.messageId,
          in_reply_to: input.inReplyTo || null,
          ai_generated: input.aiGenerated,
          ai_confidence: input.aiConfidence ?? null,
          ai_reasoning: input.aiReasoning || null,
          edited_by_human: !!input.editedByHuman,
          sent_by: input.sentByUserId || null,
          sent_at: new Date().toISOString(),
          send_attempts: 1,
        }),
      ) as any;
      messageDbId = created.id;
    }

    return { ok: true, messageDbId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to send reply for thread ${input.threadId}:`, errMsg);
    return { ok: false, error: errMsg };
  }
}

async function fetchThreadHistory(threadId: number): Promise<Array<{ direction: 'inbound' | 'outbound'; subject: string; body: string; at: string }>> {
  const rows = await directus.request(
    readItems('Email_Messages', {
      filter: {
        thread: { _eq: threadId },
        direction: { _in: ['inbound', 'outbound'] },
      } as any,
      sort: ['date_created'] as any,
      limit: 20,
      fields: ['direction', 'subject', 'body_plain', 'date_created'] as any,
    }),
  ) as any[];

  return rows.map((r) => ({
    direction: r.direction,
    subject: r.subject || '',
    body: (r.body_plain || '').slice(0, 1000),
    at: r.date_created || '',
  }));
}

async function touchThread(threadId: number, msg: ParsedInboxMessage): Promise<void> {
  // Update message_count via a refetch — keeps logic simple
  const rows = await directus.request(
    readItems('Email_Messages', {
      filter: { thread: { _eq: threadId } } as any,
      aggregate: { count: '*' } as any,
    } as any),
  ) as any[];
  const count = parseInt(rows[0]?.count ?? '0', 10);

  // Houd het thread-onderwerp gelijk aan de laatste inbound subject (zonder "Re:" prefix).
  // Zo zien Luke en Levi direct waar het laatste bericht over gaat, ook bij forwards
  // of follow-up vragen met een gewijzigd onderwerp.
  const cleanSubject = (msg.subject || '').replace(/^(re:|fw:|fwd:|aw:)\s*/gi, '').trim();

  await directus.request(
    updateItem('Email_Threads', threadId, {
      message_count: count,
      last_message_at: msg.receivedAt.toISOString(),
      ...(cleanSubject ? { subject: cleanSubject } : {}),
    }),
  );
}

function normalizeSubject(subject: string): string {
  return (subject || '')
    .replace(/^(re:|fw:|fwd:|aw:)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function generateMessageId(): string {
  const rand = crypto.randomBytes(8).toString('hex');
  return `draft-${Date.now()}-${rand}@ipaudio.nl`;
}

function stripHtml(html: string): string {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
