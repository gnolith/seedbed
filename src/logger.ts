import type { SeedbedConfig } from './config.js';

export interface Logger {
  error(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  debug(message: string, details?: unknown): void;
}

const ranks = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

export function createLogger(level: SeedbedConfig['logLevel'], stderr: NodeJS.WritableStream = process.stderr): Logger {
  const write = (kind: keyof Omit<Logger, never>, message: string, details?: unknown) => {
    if (ranks[level] < ranks[kind]) return;
    stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: kind, message, ...(details === undefined ? {} : { details }) })}\n`);
  };
  return {
    error: (message, details) => write('error', message, details),
    warn: (message, details) => write('warn', message, details),
    info: (message, details) => write('info', message, details),
    debug: (message, details) => write('debug', message, details),
  };
}

