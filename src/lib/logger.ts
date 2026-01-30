import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { logsDir } from '../config/paths.js';
import fs from 'fs-extra';

fs.ensureDirSync(logsDir);

const transport = new DailyRotateFile({
  dirname: logsDir,
  filename: 'sparrow-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  zippedArchive: false,
  level: 'info',
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      return `${timestamp} [${level}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [new winston.transports.Console({ level: 'debug' }), transport],
});
