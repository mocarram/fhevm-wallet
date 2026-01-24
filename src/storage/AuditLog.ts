/**
 * Audit logging for wallet operations
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const AUDIT_LOG_FILE = join(DATA_DIR, 'audit.log');

export type AuditEvent =
  | 'WALLET_CREATED'
  | 'WALLET_IMPORTED'
  | 'WALLET_EXPORTED'
  | 'WALLET_REMOVED'
  | 'TRANSFER'
  | 'TOKEN_ADDED'
  | 'TOKEN_REMOVED';

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Format details as key=value pairs
 */
function formatDetails(details: Record<string, string>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
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

  appendFileSync(AUDIT_LOG_FILE, logLine);
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
