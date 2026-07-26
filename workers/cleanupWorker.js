const { Worker } = require('bullmq');
const redis = require('../config/redis');
const prisma = require('../config/prisma');
const logger = require('../services/logger');

const THREE_MONTHS_MS = 3 * 30 * 24 * 60 * 60 * 1000;

const worker = new Worker(
  'cleanup',
  async (job) => {
    if (job.name !== 'daily-cleanup') return;

    const threeMonthsAgo = new Date(Date.now() - THREE_MONTHS_MS);

    const [deletedReports, deletedFoundItems] = await Promise.all([
      prisma.lostReport.deleteMany({
        where: { postedAt: { lt: threeMonthsAgo } },
      }),
      prisma.lostFound.deleteMany({
        where: { createdAt: { lt: threeMonthsAgo }, status: 'handed_over' },
      }),
    ]);

    logger.info('[Cleanup] Daily cleanup complete', {
      deletedLostReports: deletedReports.count,
      deletedFoundItems: deletedFoundItems.count,
    });
  },
  { connection: redis, concurrency: 1 }
);

worker.on('completed', (job) => logger.info(`[Cleanup] Job ${job.id} completed`));
worker.on('failed', (job, err) => {
  logger.error(`[Cleanup] Job ${job.id} failed: ${err.message}`);
  const Sentry = require('@sentry/node');
  Sentry.captureException(err, { extra: { jobId: job.id, jobName: job.name } });
});

module.exports = worker;