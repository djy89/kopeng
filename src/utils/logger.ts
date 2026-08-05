import winston from 'winston';
import path from 'path';
import fs from 'fs';
import config from '../config/config.js';

// Test runs write to logs/test/, not logs/. The service's stderr is captured into
// logs/error.log by the process supervisor, so a test suite logging there mixes
// fixture failures ("Dream 1 failed: boom", "promotion exploded") into the file an
// operator reads during a real incident — they are indistinguishable from
// production errors at 3am. Vitest sets VITEST; NODE_ENV covers other runners.
const isTestRun = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const logsDir = path.resolve(isTestRun ? path.join(config.logging.path, 'test') : config.logging.path);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'kopeng' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} [${level}]: ${message}`;
        })
      ),
    }),
  ],
});

export default logger;
