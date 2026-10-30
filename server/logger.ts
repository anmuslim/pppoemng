/**
 * Logger ringan tanpa dependensi.
 * - Level: error < warn < info < debug (atur lewat LOG_LEVEL, default "info")
 * - Format: teks (default) atau JSON per baris (LOG_FORMAT=json) agar mudah dibaca PM2/journald
 * - Nilai sensitif (password, token, secret, dll.) otomatis disamarkan
 */
type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|apikey|api_key|encryptionkey/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[...]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[DISAMARKAN]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, message: string, meta?: unknown) {
  if (LEVELS[level] > currentLevel()) return;
  const ts = new Date().toISOString();
  const safeMeta = meta === undefined ? undefined : redact(meta);

  let line: string;
  if ((process.env.LOG_FORMAT || '').toLowerCase() === 'json') {
    line = JSON.stringify({ ts, level, msg: message, ...(safeMeta !== undefined ? { meta: safeMeta } : {}) });
  } else {
    const suffix =
      safeMeta === undefined ? '' : ` ${typeof safeMeta === 'string' ? safeMeta : JSON.stringify(safeMeta)}`;
    line = `${ts} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
  }

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
};
