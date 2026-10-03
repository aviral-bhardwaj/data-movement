const { Queue, QueueEvents } = require('bullmq');
const config = require('./config');

const SYNC_QUEUE = 'datamove-syncs';

const connection = { ...config.redis };

const syncQueue = new Queue(SYNC_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

const queueEvents = new QueueEvents(SYNC_QUEUE, { connection });

async function enqueueSync({ jobId, connectionId, triggerType = 'manual', priority = 5 }) {
  return syncQueue.add(
    'sync',
    { jobId, connectionId, triggerType },
    { jobId: String(jobId), priority }
  );
}

// Interval/cron schedules are materialized as BullMQ Job Schedulers.
async function upsertSchedule(connectionId, scheduleType, scheduleValue) {
  await removeSchedule(connectionId);
  if (scheduleType === 'interval' || scheduleType === 'cdc') {
    // cdc drains the replication slot on a short interval (default 30s)
    const ms = parseInterval(scheduleValue || '30s');
    await syncQueue.upsertJobScheduler(
      `conn-${connectionId}`,
      { every: ms },
      { name: 'scheduled-sync', data: { connectionId, triggerType: 'scheduled' } }
    );
  } else if (scheduleType === 'cron') {
    await syncQueue.upsertJobScheduler(
      `conn-${connectionId}`,
      { pattern: scheduleValue },
      { name: 'scheduled-sync', data: { connectionId, triggerType: 'scheduled' } }
    );
  }
}

async function removeSchedule(connectionId) {
  try {
    await syncQueue.removeJobScheduler(`conn-${connectionId}`);
  } catch (_) {
    /* scheduler may not exist */
  }
}

function parseInterval(v) {
  if (!v) return 3600000;
  const m = String(v).match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) return 3600000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Math.max(n * mult, 15000); // floor at 15s
}

module.exports = { syncQueue, queueEvents, enqueueSync, upsertSchedule, removeSchedule, parseInterval, SYNC_QUEUE };
