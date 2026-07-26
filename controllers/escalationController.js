const prisma = require('../config/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const { sendPushNotification, getTokensByRole } = require('../services/notificationService');
const logger = require('../services/logger');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const { ESCALATION_LIMITS, NO_ACCEPTANCE_LIMITS, HOD_EMAIL_DELAY } = require('../config/escalationLimits');

const getBrevoClient = () => {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
  return new SibApiV3Sdk.TransactionalEmailsApi();
};

const sendBrevoEmail = async (to, subject, htmlContent) => {
  const api = getBrevoClient();
  await api.sendTransacEmail({
    sender: { name: 'UNIFIX', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent,
  });
};

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function cleanLocation(complaint) {
  const raw = `${complaint.building || ''}, ${complaint.roomDetail || ''}`;
  return raw.replace(/\s*—\s*/g, ', ').replace(/\s*\/\s*/g, ' ').replace(/,\s*,/g, ',').replace(/\b(\w+)(,\s*\1)+\b/gi, '$1').replace(/\s+/g, ' ').trim().replace(/^,|,$/g, '');
}

function formatElapsed(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

async function sendEscalationHODEmail(complaint) {
  const acceptedAt = complaint.acceptedAt ? new Date(complaint.acceptedAt) : null;
  const flaggedAt = complaint.flaggedAt ? new Date(complaint.flaggedAt) : null;
  const createdAt = complaint.createdAt ? new Date(complaint.createdAt) : null;
  const elapsed = formatElapsed(Date.now() - (acceptedAt ? acceptedAt.getTime() : createdAt ? createdAt.getTime() : Date.now()));

  await sendBrevoEmail(process.env.HOD_EMAIL, `UNIFIX: Unresolved Complaint, ${capitalize(complaint.category)} Issue at ${cleanLocation(complaint)}`, `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#0f172a;padding:24px 32px;border-radius:12px 12px 0 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;">UNIFIX</p>
          <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;text-transform:uppercase;">Campus Complaint Management, VCET</p></td>
          <td align="right"><div style="background:#dc2626;border-radius:8px;padding:8px 14px;">
            <p style="margin:0;font-size:11px;font-weight:700;color:#ffffff;text-transform:uppercase;">ESCALATED</p>
          </div></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#b91c1c;padding:20px 32px;">
        <p style="margin:0;font-size:16px;font-weight:700;color:#ffffff;">Unresolved Complaint Alert</p>
        <p style="margin:6px 0 0;font-size:13px;color:#fecaca;">Reason: ${complaint.flagReason === 'no_acceptance' ? 'No staff accepted this complaint' : 'Complaint not resolved in time'}${complaint.adminHandling ? ' (Admin was notified and took ownership but did not resolve)' : ''}</p>
      </td></tr>
      <tr><td style="background:#ffffff;padding:28px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:24px;">
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Complaint ID</span>
            <span style="font-size:13px;font-weight:700;color:#16a34a;font-family:monospace;">${complaint.id}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Category</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.category || 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Location</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${cleanLocation(complaint)}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Description</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.description || 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Submitted By</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.submittedByName || 'N/A'} (${complaint.submittedByRole || 'N/A'})</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Submitted At</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${createdAt ? createdAt.toLocaleString('en-IN') : 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Assigned To</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.assignedToName || 'Not assigned'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Admin Handling</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.adminHandling ? 'Yes, Admin took ownership but did not resolve' : 'No'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Time Elapsed</span>
            <span style="font-size:13px;font-weight:700;color:#dc2626;">${elapsed}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Flagged At</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${flaggedAt ? flaggedAt.toLocaleString('en-IN') : 'N/A'}</span>
          </td></tr>
        </table>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;">
          <p style="margin:0;font-size:12px;color:#991b1b;line-height:1.6;">This complaint was not resolved within the required time limit. Please take immediate action.</p>
        </div>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;">
        <p style="margin:0;font-size:11px;color:#94a3b8;">UNIFIX, Vidyavardhini's College of Engineering & Technology</p>
        <p style="margin:4px 0 0;font-size:11px;color:#cbd5e1;">Automated notification. Do not reply.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`);
}

async function sendHODResolutionEmail(complaint, resolvedBy) {
  const createdAt = complaint.createdAt ? new Date(complaint.createdAt) : null;
  const flaggedAt = complaint.flaggedAt ? new Date(complaint.flaggedAt) : null;
  const resolvedAt = complaint.flagResolvedAt ? new Date(complaint.flagResolvedAt) : new Date();

  await sendBrevoEmail(process.env.HOD_EMAIL, `UNIFIX: Complaint Resolved, ${capitalize(complaint.category)} Issue at ${cleanLocation(complaint)}`, `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#0f172a;padding:24px 32px;border-radius:12px 12px 0 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;">UNIFIX</p>
          <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;text-transform:uppercase;">Campus Complaint Management, VCET</p></td>
          <td align="right"><div style="background:#16a34a;border-radius:8px;padding:8px 14px;">
            <p style="margin:0;font-size:11px;font-weight:700;color:#ffffff;text-transform:uppercase;">RESOLVED</p>
          </div></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#15803d;padding:20px 32px;">
        <p style="margin:0;font-size:16px;font-weight:700;color:#ffffff;">Flagged Complaint Has Been Resolved</p>
        <p style="margin:6px 0 0;font-size:13px;color:#bbf7d0;">Resolved by: ${resolvedBy === 'admin' ? 'Admin' : 'Maintenance Staff'}</p>
      </td></tr>
      <tr><td style="background:#ffffff;padding:28px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:24px;">
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Complaint ID</span>
            <span style="font-size:13px;font-weight:700;color:#16a34a;font-family:monospace;">${complaint.id}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Category</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.category || 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Location</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${cleanLocation(complaint)}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Description</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.description || 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Submitted By</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${complaint.submittedByName || 'N/A'} (${complaint.submittedByRole || 'N/A'})</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Submitted At</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${createdAt ? createdAt.toLocaleString('en-IN') : 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Flagged At</span>
            <span style="font-size:13px;font-weight:600;color:#0f172a;">${flaggedAt ? flaggedAt.toLocaleString('en-IN') : 'N/A'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Resolved By</span>
            <span style="font-size:13px;font-weight:700;color:#16a34a;">${resolvedBy === 'admin' ? 'Admin' : 'Maintenance Staff'}</span>
          </td></tr>
          <tr><td style="padding:10px 14px;background:#ffffff;">
            <span style="display:block;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:3px;">Resolved At</span>
            <span style="font-size:13px;font-weight:600;color:#16a34a;">${resolvedAt.toLocaleString('en-IN')}</span>
          </td></tr>
        </table>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;">
          <p style="margin:0;font-size:12px;color:#166534;line-height:1.6;">This flagged complaint has been successfully resolved. No further action is required.</p>
        </div>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;">
        <p style="margin:0;font-size:11px;color:#94a3b8;">UNIFIX, Vidyavardhini's College of Engineering & Technology</p>
        <p style="margin:4px 0 0;font-size:11px;color:#cbd5e1;">Automated notification. Do not reply.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`);
}

async function checkEscalations(req, res) {
  try {
    let flaggedCount = 0;
    let emailsSentCount = 0;
    const now = Date.now();
    const nowDate = new Date(now);

    const adminTokens = await getTokensByRole(['admin']);

    const [assignedComplaints, pendingComplaints] = await Promise.all([
      prisma.complaint.findMany({
        where: { status: { in: ['assigned', 'in_progress'] }, nextCheckAt: { lte: nowDate } },
      }),
      prisma.complaint.findMany({
        where: { status: 'pending', nextCheckAt: { lte: nowDate } },
      }),
    ]);

    const processComplaint = async (complaint, limit) => {
      if (complaint.flagged && complaint.flagResolved && complaint.hodResolutionEmailSent) return;

      const startTime = complaint.acceptedAt ? new Date(complaint.acceptedAt) : complaint.createdAt ? new Date(complaint.createdAt) : null;
      if (!startTime) return;

      const elapsed = now - startTime.getTime();

      if (elapsed > limit && !complaint.flagged) {
        await prisma.complaint.update({
          where: { id: complaint.id },
          data: {
            flagged: true,
            flaggedAt: nowDate,
            flagReason: complaint.acceptedAt ? 'unresolved' : 'no_acceptance',
            flagResolved: false,
            adminHandling: false,
            hodEmailSent: false,
            hodResolutionEmailSent: false,
            nextCheckAt: new Date(now + HOD_EMAIL_DELAY),
          },
        });
        flaggedCount++;

        const { scheduleHodEmail } = require('../services/schedulerService');
        scheduleHodEmail(complaint.id);

        if (adminTokens.length > 0) {
          const reason = complaint.acceptedAt ? 'has not been resolved in time' : 'has not been accepted by any staff';
          await sendPushNotification(adminTokens, 'Complaint Flagged', `${complaint.category} complaint from ${complaint.submittedByName || 'a student'} ${reason}.`, { type: 'escalation', complaintId: complaint.id });
        }
      }

      const refetched = await prisma.complaint.findUnique({ where: { id: complaint.id } });
      if (!refetched) return;

      if (refetched.flagged && !refetched.flagResolved && !refetched.hodEmailSent) {
        const flaggedAt = refetched.flaggedAt ? new Date(refetched.flaggedAt) : null;
        if (flaggedAt && (now - flaggedAt.getTime()) > HOD_EMAIL_DELAY) {
          await prisma.complaint.update({
            where: { id: complaint.id },
            data: { hodEmailSent: true, hodEmailSentAt: nowDate, nextCheckAt: new Date(now + HOD_EMAIL_DELAY) },
          });
          emailsSentCount++;
          await sendEscalationHODEmail(refetched);

          if (refetched.submittedById) {
            const { getTokenForUid } = require('../services/notificationService');
            const tokens = await getTokenForUid(refetched.submittedById);
            if (tokens.length > 0) {
              await sendPushNotification(tokens, 'Complaint Escalated to HOD', 'Your complaint has been escalated to the HOD due to delay in resolution.', { type: 'complaint_escalated', complaintId: complaint.id });
            }
          }
        }
      }

      if (refetched.flagged && refetched.flagResolved && !refetched.hodResolutionEmailSent) {
        await prisma.complaint.update({
          where: { id: complaint.id },
          data: { hodResolutionEmailSent: true, nextCheckAt: new Date(now + 365 * 24 * 60 * 60 * 1000) },
        });
        emailsSentCount++;
        await sendHODResolutionEmail(refetched, refetched.flagResolvedBy);
      }
    };

    for (const complaint of assignedComplaints) {
      const limit = ESCALATION_LIMITS[complaint.category?.toLowerCase()];
      if (!limit) continue;
      await processComplaint(complaint, limit);
    }

    for (const complaint of pendingComplaints) {
      const limit = NO_ACCEPTANCE_LIMITS[complaint.category?.toLowerCase()];
      if (!limit) continue;
      await processComplaint(complaint, limit);
    }

    logger.info('[Escalation] Check complete', { flagged: flaggedCount, emailsSent: emailsSentCount });
    sendSuccess(res, { flagged: flaggedCount, emailsSent: emailsSentCount });
  } catch (error) {
    logger.error('[Escalation] checkEscalations failed', { error: error.message });
    sendError(res, error.message);
  }
}

module.exports = { checkEscalations, sendHODResolutionEmail, sendEscalationHODEmail };