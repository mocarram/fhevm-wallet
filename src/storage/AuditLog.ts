/**
 * Audit logging for wallet operations
 */

import { existsSync, readFileSync } from 'fs';
import { appendSecureFile } from './secureFs.js';
import { redactSecrets } from '../utils/redact.js';
import { stripUnsafeChars } from '../utils/text.js';
import { join } from 'path';
import { DATA_DIR, ensureDataDir } from './paths.js';

const AUDIT_LOG_FILE = join(DATA_DIR, 'audit.log');

export type AuditEvent =
  | 'WALLET_CREATED'
  | 'WALLET_IMPORTED'
  | 'WALLET_EXPORTED'
  | 'WALLET_REMOVED'
  | 'TRANSFER_SIGNED'
  | 'TRANSFER_BROADCAST'
  | 'TRANSFER'
  | 'TOKEN_ADDED'
  | 'TOKEN_REMOVED'
  | 'OPERATOR_SET';

/**
 * Format details as key=value pairs
 */
function formatDetails(details: Record<string, string>): string {
  // Values can come from user input, contracts or error text: never let a secret reach
  // the log, and drop line breaks and control characters so one value cannot forge an
  // extra log line or hide text with terminal escapes or bidi tricks.
  return Object.entries(details)
    .map(([key, value]) => `${key}=${stripUnsafeChars(redactSecrets(value))}`)
    .join(' ');
}

/**
 * Log an audit event
 */
export function logEvent(event: AuditEvent, details: Record<string, string>): void {
  ensureDataDir();

  const timestamp = new Date().toISOString();
  const detailsStr = formatDetails(details);
  const logLine = `[${timestamp}] ${event} ${detailsStr}\n`;

  appendSecureFile(AUDIT_LOG_FILE, logLine);
}

/**
 * Get audit log entries
 * @param limit - Maximum number of entries to return (from most recent). If not specified, returns all.
 */
export function getAuditLog(limit?: number): string[] {
  ensureDataDir();

  if (!existsSync(AUDIT_LOG_FILE)) {
    return [];
  }

  const content = readFileSync(AUDIT_LOG_FILE, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');

  if (limit !== undefined && limit > 0) {
    return lines.slice(-limit);
  }

  return lines;
}
