const { Worker } = require('bullmq');
const config = require('../core/config');
const logger = require('../core/logger');
const migrate = require('../core/migrate');
const { runSync } = require('../engine/runner');
const { SYNC_QUEUE } = require('../core/queue');

// Worker service: pulls sync jobs off the BullMQ queue and executes them.
// Concurrency is configurable; jobs retry with exponential backoff (queue.js).
async function main() {
  await migrate();
  const worker = new Worker(
    SYNC_QUEUE,
    async (job) => {
      const { jobId, connectionId, triggerType } = job.data;
      logger.info('picked up sync job', { queueJob: job.id, jobId, connectionId });
      // scheduled jobs arrive without a sync_jobs row — create it inside runSync
      const result = await runSync({ jobId, connectionId, triggerType: triggerType || 'scheduled', bullJob: job });
      if (result.status === 'failed') throw new Error(result.error || 'sync failed'); // trigger BullMQ retry
      return result;
    },
    {
      connection: { ...config.redis },
      concurrency: config.worker.concurrency,
      maxStalledCount: 2,
    }
  );

  worker.on('completed', (job, result) => logger.info('sync completed', { job: job.id, status: result?.status }));
  worker.on('failed', (job, err) => logger.error('sync failed', { job: job?.id, err: err.message, attempts: job?.attemptsMade }));
  worker.on('error', (err) => logger.error('worker error', { err: err.message }));

  logger.info(`worker ${config.worker.id} started`, { concurrency: config.worker.concurrency });
}

main().catch((e) => { logger.error('worker failed', { err: e.message }); process.exit(1); });
