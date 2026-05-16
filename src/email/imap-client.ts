import { ImapFlow, FetchMessageObject } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface InboxAccountConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
  inboxMailbox: string;
  sentMailbox: string;
}

export interface ParsedInboxMessage {
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  from: { email: string; name: string };
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  receivedAt: Date;
  size: number;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

export function getIjsImapConfig(): InboxAccountConfig | null {
  if (!env.IJS_INBOX_PASSWORD) return null;
  return {
    user: env.IJS_INBOX_USER,
    password: env.IJS_INBOX_PASSWORD,
    host: env.IJS_IMAP_HOST,
    port: parseInt(env.IJS_IMAP_PORT, 10),
    secure: env.IJS_IMAP_TLS === 'true',
    inboxMailbox: env.IJS_IMAP_INBOX_MAILBOX,
    sentMailbox: env.IJS_IMAP_SENT_MAILBOX,
  };
}

function buildClient(cfg: InboxAccountConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
}

/**
 * Haal recente berichten op uit INBOX zonder ze als "Seen" te markeren.
 * Outlook blijft ze dus als ongelezen tonen tot de gebruiker ze opent.
 */
export async function fetchRecentMessages(
  cfg: InboxAccountConfig,
  sinceHours: number,
): Promise<ParsedInboxMessage[]> {
  const client = buildClient(cfg);
  await client.connect();

  const results: ParsedInboxMessage[] = [];
  try {
    const lock = await client.getMailboxLock(cfg.inboxMailbox);
    try {
      const since = new Date(Date.now() - sinceHours * 3600 * 1000);
      const uids = await client.search({ since }, { uid: true });

      if (!uids || uids.length === 0) return results;

      for await (const msg of client.fetch(
        uids,
        { source: true, envelope: true, uid: true, size: true },
        { uid: true, changedSince: undefined as any },
      )) {
        const parsed = await parseFetched(msg);
        if (parsed) results.push(parsed);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return results;
}

async function parseFetched(msg: FetchMessageObject): Promise<ParsedInboxMessage | null> {
  if (!msg.source) return null;
  const parsed: ParsedMail = await simpleParser(msg.source);

  const fromAddr = parsed.from?.value?.[0];
  const toArr = Array.isArray(parsed.to)
    ? parsed.to.flatMap((a) => a.value || [])
    : parsed.to?.value || [];
  const ccArr = Array.isArray(parsed.cc)
    ? parsed.cc.flatMap((a) => a.value || [])
    : parsed.cc?.value || [];

  return {
    uid: msg.uid,
    messageId: (parsed.messageId || '').replace(/^<|>$/g, ''),
    inReplyTo: parsed.inReplyTo ? parsed.inReplyTo.replace(/^<|>$/g, '') : null,
    from: {
      email: (fromAddr?.address || '').toLowerCase(),
      name: fromAddr?.name || '',
    },
    to: toArr.map((a) => (a.address || '').toLowerCase()).filter(Boolean),
    cc: ccArr.map((a) => (a.address || '').toLowerCase()).filter(Boolean),
    subject: parsed.subject || '(geen onderwerp)',
    textBody: parsed.text || '',
    htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
    receivedAt: parsed.date || new Date(),
    size: msg.size || 0,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || 0,
    })),
  };
}

/**
 * Zet een verzonden bericht in de "Sent Items" / "Verzonden" map zodat
 * Outlook de uitgaande mail ook ziet in de mailbox van de gebruiker.
 */
export async function appendToSentFolder(
  cfg: InboxAccountConfig,
  rawRfc822: Buffer | string,
): Promise<void> {
  const client = buildClient(cfg);
  await client.connect();
  try {
    const candidateMailboxes = [
      cfg.sentMailbox,
      'Sent',
      'Sent Items',
      'Verzonden items',
      'Verzonden',
      'INBOX.Sent',
    ];
    let appended = false;
    for (const box of candidateMailboxes) {
      try {
        await client.append(box, rawRfc822, ['\\Seen']);
        appended = true;
        logger.info(`Outbound mail appended to mailbox "${box}"`);
        break;
      } catch {
        // try next
      }
    }
    if (!appended) {
      logger.warn('Could not append outbound mail to any Sent mailbox — Outlook will not see it');
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function testImapConnection(cfg: InboxAccountConfig): Promise<{ ok: boolean; error?: string; mailboxes?: string[] }> {
  const client = buildClient(cfg);
  try {
    await client.connect();
    const list = await client.list();
    const mailboxes = list.map((m) => m.path);
    await client.logout();
    return { ok: true, mailboxes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
