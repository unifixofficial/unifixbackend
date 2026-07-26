const { Worker } = require('bullmq');
const redis = require('../config/redis');
const prisma = require('../config/prisma');
const logger = require('../services/logger');
const { sendPushNotification, getTokensByRole } = require('../services/notificationService');

const worker = new Worker(
  'escalation',
  async (job) => {
    logger.info(`[Worker] Job received: ${job.name} for ${job.data.complaintId}`);
    const { complaintId } = job.data;

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });

    if (!complaint) {
      logger.warn(`[Worker] Complaint ${complaintId} not found, skipping`);
      return;
    }

    if (complaint.status === 'completed' || complaint.status === 'rejected' || complaint.flagResolved) {
      logger.info(`[Worker] Complaint ${complaintId} already resolved, skipping`);
      return;
    }

    if (job.name === 'flag-complaint' && !complaint.flagged) {
      const adminTokens = await getTokensByRole(['admin']);

      await prisma.complaint.update({
        where: { id: complaintId },
        data: {
          flagged: true,
          flaggedAt: new Date(),
          flagReason: complaint.acceptedAt ? 'unresolved' : 'no_acceptance',
          flagResolved: false,
          adminHandling: false,
          hodEmailSent: false,
          hodResolutionEmailSent: false,
        },
      });

      if (adminTokens.length > 0) {
        await sendPushNotification(adminTokens, 'Complaint Flagged', `${complaint.category} complaint from ${complaint.submittedByName || 'a student'} exceeded time limit.`, { type: 'escalation', complaintId });
      }

      const { scheduleHodEmail } = require('../services/schedulerService');
      await scheduleHodEmail(complaintId);

      logger.info(`[Worker] Flagged complaint ${complaintId}`);
    }

    if (job.name === 'hod-email') {
      const refetched = await prisma.complaint.findUnique({ where: { id: complaintId } });
      if (refetched && refetched.flagged && !refetched.hodEmailSent) {
        const { sendEscalationHODEmail } = require('../controllers/escalationController');
        await sendEscalationHODEmail(refetched);

        await prisma.complaint.update({
          where: { id: complaintId },
          data: { hodEmailSent: true, hodEmailSentAt: new Date() },
        });

        logger.info(`[Worker] HOD email sent for complaint ${complaintId}`);
      }
    }
  },
  { connection: redis, concurrency: 5 }
);

worker.on('completed', (job) => logger.info(`[Worker] Job ${job.id} completed`));
worker.on('failed', (job, err) => {
  logger.error(`[Worker] Job ${job.id} failed: ${err.message}`);
  const Sentry = require('@sentry/node');
  Sentry.captureException(err, { extra: { jobId: job.id, jobName: job.name, data: job.data } });
});
worker.on('error', (err) => logger.error(`[Worker] Worker error: ${err.message}`));
worker.on('active', (job) => logger.info(`[Worker] Job active: ${job.id} - ${job.name}`));

module.exports = worker;