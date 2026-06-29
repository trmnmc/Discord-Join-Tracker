/**
 * Periodic retention job. Deletes raw message rows older than the configured
 * retention window so we never keep chat content indefinitely.
 */
import { AnalyticsDB } from "./db";
import { logger } from "./logger";

const ONE_HOUR_MS = 60 * 60 * 1000;

export function runCleanupOnce(db: AnalyticsDB, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const removed = db.deleteMessagesOlderThan(cutoff);
  if (removed > 0) {
    logger.info(`Cleanup removed ${removed} message rows older than ${retentionDays} days`);
  }
  return removed;
}

/**
 * Start an interval that runs cleanup every hour. Returns the timer so callers
 * can clear it on shutdown. Runs once immediately on start.
 */
export function startCleanupJob(db: AnalyticsDB, retentionDays: number): NodeJS.Timeout {
  runCleanupOnce(db, retentionDays);
  const timer = setInterval(() => {
    try {
      runCleanupOnce(db, retentionDays);
    } catch (err) {
      logger.error("Cleanup job failed", err);
    }
  }, ONE_HOUR_MS);
  // Do not keep the process alive solely for cleanup.
  timer.unref();
  return timer;
}
