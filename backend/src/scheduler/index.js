const config = require('../core/config');
const logger = require('../core/logger');
const db = require('../core/db');
const migrate = require('../core/migrate');
const { upsertSchedule, removeSchedule, syncQueue } = require('../core/queue');

// Scheduler service: reconciles DB connection schedules -> BullMQ job schedulers.
// BullMQ stores repeatable jobs in Redis so scheduling survives restarts and is
// shared by all workers (priority + delayed + retry handled by the queue).
async function reconcile() {
  const conns = await db.many(
    `SELECT id, schedule_type, schedule_value, status FROM connections`
  );
  const schedulers = await syncQueue.getJobSchedulers().catch(() => []);
  const have = new Map(schedulers.map((s) => [s.id || s.key, s]));

  for (const c of conns) {
    const key = `conn-${c.id}`;
    const schedulable = c.status === 'active' && ['interval', 'cron', 'cdc'].includes(c.schedule_type);
    if (schedulable && !have.has(key)) {
      await upsertSchedule(c.id, c.schedule_type, c.schedule_value);
      logger.info('registered schedule', { connection: c.id, type: c.schedule_type, value: c.schedule_value });
    } else if (!schedulable && have.has(key)) {
      await removeSchedule(c.id);
      logger.info('removed schedule', { connection: c.id });
    }
  }
}

async function main() {
  await migrate();
  logger.info('scheduler started', { tickSeconds: config.schedulerTickSeconds });
  await reconcile();
  setInterval(() => reconcile().catch((e) => logger.error('reconcile failed', { err: e.message })),
    config.schedulerTickSeconds * 1000);
}

main().catch((e) => { logger.error('scheduler failed', { err: e.message }); process.exit(1); });
