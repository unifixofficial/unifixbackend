const { Queue } = require('bullmq');
const redis = require('../config/redis');

const escalationQueue = new Queue('escalation', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

async function scheduleEscalation(complaintId, category, startTime) {
  const ESCALATION_LIMITS = {
    cleaning: 1 * 60 * 60 * 1000,
    housekeeping: 1 * 60 * 60 * 1000,
    washroom: 1 * 60 * 60 * 1000,
    electrical: 24 * 60 * 60 * 1000,
    plumbing: 24 * 60 * 60 * 1000,
    civil: 24 * 60 * 60 * 1000,
    carpentry: 24 * 60 * 60 * 1000,
    technician: 2 * 60 * 60 * 1000,
    'it / technical': 2 * 60 * 60 * 1000,
    lab: 2 * 60 * 60 * 1000,
    safety: 2 * 60 * 60 * 1000,
    others: 2 * 60 * 60 * 1000,
  };

  const limit = ESCALATION_LIMITS[category?.toLowerCase()];
  if (!limit) return;

  const elapsed = Date.now() - startTime;
  const remaining = Math.max(limit - elapsed, 0);

  const uniqueJobId = `escalate-${complaintId}-${Date.now()}`;

  await escalationQueue.add(
    'flag-complaint',
    { complaintId, category },
    { delay: remaining, jobId: uniqueJobId, removeOnComplete: true }
  );
}

async function scheduleHodEmail(complaintId) {
  const HOD_DELAY = 20 * 60 * 1000;
  await escalationQueue.add(
    'hod-email',
    { complaintId },
    { delay: HOD_DELAY, jobId: `hod-${complaintId}-${Date.now()}`, removeOnComplete: true }
  );
}

async function cancelEscalation(complaintId) {
  try {
    const delayed = await escalationQueue.getDelayed();
    for (const job of delayed) {
      if (job.data.complaintId === complaintId) {
        await job.remove();
      }
    }
  } catch (err) {
    console.error(`[Queue] Cancel failed for ${complaintId}:`, err.message);
  }
}

module.exports = { escalationQueue, scheduleEscalation, scheduleHodEmail, cancelEscalation };