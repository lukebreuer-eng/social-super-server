import winston from 'winston';
import Transport from 'winston-transport';
import { env } from '../config/env';

const { combine, timestamp, printf, errors } = winston.format;

// Waarom dit bestand zo defensief is: op 4 september 2026 logde een axios-fout
// van de LinkedIn-sync zijn complete request-config (socket, agent, buffers).
// Winston is intern een Transform-stream; klapt de verwerking van één regel,
// dan wordt die stream vernield en logt de app daarna NIETS meer, terwijl hij
// gewoon blijft draaien. De server stond tien dagen blind.
//
// Drie maatregelen, in volgorde van belangrijkheid:
//   1. meta wordt platgeslagen tot één string voordat winston hem aanraakt,
//   2. de console-transport schrijft zelf naar stdout in een try/catch,
//   3. elke fout op logger of transport wordt opgevangen, nooit doorgegooid.
const MAX_META_LENGTH = 2000;
const MAX_DEPTH = 6;

// Een axios-fout sleept zijn volledige request-config mee, inclusief de
// Authorization-header. Zonder deze redactie staan access- en refresh-tokens
// leesbaar in de containerlogs.
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[-_]?key|assertion)/i;

// Velden die alleen maar ruis zijn en waar de circulaire verwijzingen in zitten.
const RUIS_KEY = /^(socket|agent|_httpMessage|connection|req|res|request|response|config|parser|client|sess)$/;

function safeStringify(meta: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  const diepte = new WeakMap<object, number>();
  try {
    const json = JSON.stringify(meta, function (key, value) {
      if (SENSITIVE_KEY.test(key) && typeof value === 'string') return '[geredigeerd]';
      if (RUIS_KEY.test(key)) return '[weggelaten]';
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return '[functie]';
      if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circulair]';
        seen.add(value);
        const ouder = this as unknown as object;
        const d = (diepte.get(ouder) ?? 0) + 1;
        if (d > MAX_DEPTH) return '[te diep]';
        diepte.set(value, d);
      }
      return value;
    });
    if (!json) return '';
    return json.length > MAX_META_LENGTH ? `${json.slice(0, MAX_META_LENGTH)}...[afgekapt]` : json;
  } catch {
    return '[meta niet serialiseerbaar]';
  }
}

// Slaat alle extra velden plat tot één string, zodat de rest van de winston-
// keten (timestamp, printf, transports) nooit meer een diep object ziet.
// Let op: het info-object wordt bewust gemuteerd. Een format dat een nieuw
// object teruggeeft gooit winstons interne level-symbool weg, en dan filtert
// de transport de regel er zonder enige melding uit.
const platteMeta = winston.format((info) => {
  try {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(info)) {
      if (key === 'level' || key === 'message' || key === 'timestamp' || key === 'stack') continue;
      rest[key] = (info as Record<string, unknown>)[key];
      delete (info as Record<string, unknown>)[key];
    }
    (info as Record<string, unknown>).meta = Object.keys(rest).length > 0 ? safeStringify(rest) : '';
  } catch {
    (info as Record<string, unknown>).meta = '[meta onverwerkbaar]';
  }
  return info;
});

const logFormat = printf((info) => {
  try {
    const { level, message, timestamp: ts, stack, meta } = info as Record<string, unknown>;
    let msg = `${ts} [${level}]: ${stack || message}`;
    if (meta) msg += ` ${meta}`;
    return msg;
  } catch {
    return `${new Date().toISOString()} [error]: [logregel onverwerkbaar]`;
  }
});

// Eigen console-transport: schrijft rechtstreeks naar stdout binnen een
// try/catch. Een kapotte of volle stdout (EPIPE) laat de logger dan met rust
// in plaats van hem definitief om zeep te helpen.
class VeiligeConsole extends Transport {
  log(info: Record<string, unknown>, next: () => void): void {
    try {
      const regel = (info[Symbol.for('message') as unknown as string] as string) ?? String(info.message ?? '');
      process.stdout.write(`${regel}\n`);
    } catch {
      // bewust stil: logging mag nooit de reden zijn dat de app stukgaat
    }
    next();
  }
}

const consoleTransport = new VeiligeConsole();

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    platteMeta(),
    logFormat
  ),
  defaultMeta: { service: 'social-engine' },
  transports: [consoleTransport],
  exitOnError: false,
});

// Zonder deze listeners gooit een transport-fout een onafgevangen 'error'-event
// op de logger, en dat is precies hoe de logstream eerder is gesneuveld.
consoleTransport.on('error', () => { /* genegeerd, zie hierboven */ });
logger.on('error', () => { /* genegeerd, zie hierboven */ });
process.stdout.on('error', () => { /* EPIPE bij herstartende logdriver */ });

// Stream for Morgan HTTP logging if needed
export const logStream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};
