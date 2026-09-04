import winston from 'winston';
import { env } from '../config/env';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Meta veilig serialiseren. Een gewone JSON.stringify klapt op circulaire
// structuren (een axios-fout sleept een socket mee die naar zichzelf verwijst).
// Die TypeError brak de winston-stream, waarna de app helemaal niets meer logde
// en jobs die een fout logden alsnog faalden. Vandaar de replacer + de try.
const MAX_META_LENGTH = 2000;

function safeStringify(meta: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(meta, (_key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circulair]';
        seen.add(value);
      }
      return value;
    });
    if (!json) return '';
    return json.length > MAX_META_LENGTH ? `${json.slice(0, MAX_META_LENGTH)}...[afgekapt]` : json;
  } catch {
    return '[meta niet serialiseerbaar]';
  }
}

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let msg = `${timestamp} [${level}]: ${stack || message}`;
  if (Object.keys(meta).length > 0) {
    const serialized = safeStringify(meta as Record<string, unknown>);
    if (serialized) msg += ` ${serialized}`;
  }
  return msg;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  defaultMeta: { service: 'social-engine' },
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Stream for Morgan HTTP logging if needed
export const logStream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};
