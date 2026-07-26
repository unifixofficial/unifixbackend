const argon2 = require('argon2');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { signAccessToken, signRefreshToken, getRefreshExpiry } = require('../utils/jwt');
const { sendRejectionEmail, sendIdCardRejectionEmail } = require('../services/emailService');
const { sendSuccess, sendError } = require('../utils/response');
const { createAuditLog } = require('../services/auditLogService');
const logger = require('../services/logger');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return sendError(res, 'Email and password required', 400);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== 'admin') return sendError(res, 'Invalid admin credentials', 401);
    if (user.accountStatus !== 'active') return sendError(res, 'Account suspended', 403);

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return sendError(res, 'Invalid admin credentials', 401);

    const tokenPayload = { uid: user.id, role: user.role, tokenVersion: user.tokenVersion };
    const token = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken({ uid: user.id });

    await prisma.$transaction([
      prisma.refreshToken.create({
        data: { userId: user.id, token: refreshToken, expiresAt: getRefreshExpiry() },
      }),
      prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } }),
    ]);

    sendSuccess(res, { token, refreshToken });
  } catch (error) {
    logger.error('[Admin] login failed', { error: error.message });
    sendError(res, error.message);
  }
};

const getPendingStaff = async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { role: 'staff', verificationStatus: 'pending' },
    });
    sendSuccess(res, { staff });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllStaff = async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { role: 'staff' },
      orderBy: { createdAt: 'desc' },
    });

    const hashInput = staff.map(s => `${s.id}:${s.verificationStatus}:${s.updatedAt?.getTime() ?? 0}`).join('|');
    const hash = crypto.createHash('md5').update(hashInput).digest('hex');

    const clientHash = req.headers['x-data-hash'];
    if (clientHash && clientHash === hash) {
      return res.status(200).json({ upToDate: true, hash });
    }

    sendSuccess(res, { staff, hash });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getStaffById = async (req, res) => {
  try {
    const { uid } = req.params;
    const staff = await prisma.user.findUnique({ where: { id: uid } });
    if (!staff) return sendError(res, 'Staff not found', 404);
    sendSuccess(res, { staff: { id: staff.id, ...staff } });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveStaff = async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return sendError(res, 'UID required', 400);
    const staff = await prisma.user.findUnique({ where: { id: uid } });
    if (!staff) return sendError(res, 'Staff not found', 404);

    await prisma.user.update({
      where: { id: uid },
      data: { verificationStatus: 'approved', rejectionMessage: null, approvedAt: new Date() },
    });

    await createAuditLog({ action: 'staff_approved', performedBy: req.admin?.uid, performedByRole: 'admin', targetId: uid, targetType: 'user' });
    logger.info('[Admin] Staff approved', { uid });
    sendSuccess(res, { message: 'Staff approved successfully' });
  } catch (error) {
    logger.error('[Admin] approveStaff failed', { error: error.message });
    sendError(res, error.message);
  }
};

const rejectStaff = async (req, res) => {
  try {
    const { uid, rejectionMessage } = req.body;
    if (!uid || !rejectionMessage) return sendError(res, 'UID and rejection message required', 400);

    const staff = await prisma.user.findUnique({ where: { id: uid } });
    if (!staff) return sendError(res, 'Staff not found', 404);

    await prisma.user.update({
      where: { id: uid },
      data: { verificationStatus: 'rejected', rejectionMessage: rejectionMessage.trim(), profileCompleted: false, rejectedAt: new Date() },
    });

    try { await sendRejectionEmail(staff.email, staff.fullName, rejectionMessage.trim()); } catch {}

    await createAuditLog({ action: 'staff_rejected', performedBy: req.admin?.uid, performedByRole: 'admin', targetId: uid, targetType: 'user', metadata: { rejectionMessage: rejectionMessage.trim() } });
    logger.info('[Admin] Staff rejected', { uid });
    sendSuccess(res, { message: 'Staff rejected and notified' });
  } catch (error) {
    logger.error('[Admin] rejectStaff failed', { error: error.message });
    sendError(res, error.message);
  }
};

const getStats = async (req, res) => {
  try {
    const [pending, approved, rejected, students, teachers, complaints, idCards, deletions, security] = await Promise.all([
      prisma.user.count({ where: { role: 'staff', verificationStatus: 'pending' } }),
      prisma.user.count({ where: { role: 'staff', verificationStatus: 'approved' } }),
      prisma.user.count({ where: { role: 'staff', verificationStatus: 'rejected' } }),
      prisma.user.count({ where: { role: 'student' } }),
      prisma.user.count({ where: { role: 'teacher' } }),
      prisma.complaint.groupBy({ by: ['status'], _count: { status: true } }),
      prisma.idCardRequest.count({ where: { status: 'pending' } }),
      prisma.deletionRequest.count({ where: { status: 'pending' } }),
      prisma.securityIssue.count({ where: { status: 'open' } }),
    ]);

    const complaintStats = { total: 0, pending: 0, assigned: 0, in_progress: 0, completed: 0, rejected: 0 };
    complaints.forEach(g => {
      complaintStats[g.status] = g._count.status;
      complaintStats.total += g._count.status;
    });

    sendSuccess(res, {
      stats: {
        pending, approved, rejected,
        total: pending + approved + rejected,
        students, teachers,
        complaints: complaintStats,
        pendingIdCardRequests: idCards,
        pendingDeletionRequests: deletions,
        openSecurityIssues: security,
      },
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllComplaints = async (req, res) => {
  try {
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;
    const complaints = await prisma.complaint.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { updatedAt: 'desc' },
    });
    sendSuccess(res, { complaints });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, fullName: true, email: true, phone: true, role: true,
        gender: true, profileCompleted: true, verificationStatus: true,
        rejectionMessage: true, year: true, branch: true, rollNumber: true,
        studentIdCardUrl: true, studentIdCardName: true, department: true,
        teacherIdCardUrl: true, teacherIdCardName: true, employeeId: true,
        designation: true, avgRating: true, ratingCount: true,
        createdAt: true, lastLogin: true, accountStatus: true,
      },
    });
    sendSuccess(res, { users });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getUserIdCard = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { role: true, fullName: true, studentIdCardUrl: true, studentIdCardName: true, teacherIdCardUrl: true, teacherIdCardName: true },
    });
    if (!user) return sendError(res, 'User not found', 404);
    sendSuccess(res, { idCard: user });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getIdCardRequests = async (req, res) => {
  try {
    const requests = await prisma.idCardRequest.findMany({ orderBy: { requestedAt: 'desc' } });
    sendSuccess(res, { requests });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveIdCard = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);

    const request = await prisma.idCardRequest.findUnique({ where: { id: requestId } });
    if (!request) return sendError(res, 'Request not found', 404);
    if (request.status !== 'pending') return sendError(res, 'Request already processed', 400);

    const updateField = request.role === 'student' ? 'studentIdCardUrl' : 'teacherIdCardUrl';
    const updateNameField = request.role === 'student' ? 'studentIdCardName' : 'teacherIdCardName';

    await prisma.$transaction([
      prisma.user.update({
        where: { id: request.userId },
        data: { [updateField]: request.newIdCardUrl, [updateNameField]: request.newIdCardName || null, idCardUpdatedAt: new Date() },
      }),
      prisma.idCardRequest.update({
        where: { id: requestId },
        data: { status: 'approved', processedAt: new Date() },
      }),
    ]);

    sendSuccess(res, { message: 'ID card approved and updated successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const rejectIdCard = async (req, res) => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);

    const request = await prisma.idCardRequest.findUnique({ where: { id: requestId } });
    if (!request) return sendError(res, 'Request not found', 404);
    if (request.status !== 'pending') return sendError(res, 'Request already processed', 400);

    await prisma.idCardRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', rejectionReason: reason || 'Not specified', processedAt: new Date() },
    });

    try { await sendIdCardRejectionEmail(request.email, request.fullName, reason || 'Not specified'); } catch {}
    sendSuccess(res, { message: 'ID card request rejected' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getDeletionRequests = async (req, res) => {
  try {
    const [staffRequests, userDeletions] = await Promise.all([
      prisma.deletionRequest.findMany({ orderBy: { requestedAt: 'desc' } }),
      prisma.deletionLog.findMany({ orderBy: { deletedAt: 'desc' }, take: 50 }),
    ]);
    sendSuccess(res, { staffRequests, userDeletions });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveDeletion = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);

    const request = await prisma.deletionRequest.findUnique({ where: { id: requestId } });
    if (!request) return sendError(res, 'Request not found', 404);
    if (request.status !== 'pending') return sendError(res, 'Request already processed', 400);

    await prisma.$transaction([
      prisma.deletionRequest.update({ where: { id: requestId }, data: { status: 'approved', processedAt: new Date() } }),
      prisma.deletionLog.create({
        data: { uid: request.userId, email: request.email, fullName: request.fullName, role: request.role, designation: request.designation || null, deletedBy: 'admin' },
      }),
      prisma.user.update({ where: { id: request.userId }, data: { accountStatus: 'deleted' } }),
    ]);

    sendSuccess(res, { message: 'Staff account deleted successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const rejectDeletion = async (req, res) => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);

    const request = await prisma.deletionRequest.findUnique({ where: { id: requestId } });
    if (!request) return sendError(res, 'Request not found', 404);
    if (request.status !== 'pending') return sendError(res, 'Request already processed', 400);

    await prisma.deletionRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', rejectionReason: reason || 'Not specified', processedAt: new Date() },
    });

    sendSuccess(res, { message: 'Deletion request rejected' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getSecurityIssues = async (req, res) => {
  try {
    const issues = await prisma.securityIssue.findMany({ orderBy: { reportedAt: 'desc' } });
    sendSuccess(res, { issues });
  } catch (error) {
    sendError(res, error.message);
  }
};

const resolveSecurityIssue = async (req, res) => {
  try {
    const { issueId, resolution } = req.body;
    if (!issueId) return sendError(res, 'Issue ID required', 400);

    const issue = await prisma.securityIssue.findUnique({ where: { id: issueId } });
    if (!issue) return sendError(res, 'Issue not found', 404);

    await prisma.securityIssue.update({
      where: { id: issueId },
      data: { status: 'resolved', resolution: resolution || 'Resolved by admin', resolvedAt: new Date() },
    });

    sendSuccess(res, { message: 'Security issue resolved' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllLostFound = async (req, res) => {
  try {
    const items = await prisma.lostFound.findMany({ orderBy: { createdAt: 'desc' } });
    sendSuccess(res, { items });
  } catch (error) {
    sendError(res, error.message);
  }
};

const iwillhandle = async (req, res) => {
  try {
    const { complaintId } = req.body;
    if (!complaintId) return sendError(res, 'Complaint ID required', 400);

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found', 404);

    const { cancelEscalation } = require('../services/schedulerService');
    cancelEscalation(complaintId);

    await prisma.complaint.update({
      where: { id: complaintId },
      data: { adminHandling: true, adminHandledAt: new Date() },
    });

    if (complaint.submittedById) {
      const { sendPushNotification, getTokenForUid } = require('../services/notificationService');
      const tokens = await getTokenForUid(complaint.submittedById);
      if (tokens.length > 0) {
        await sendPushNotification(tokens, 'Admin is handling your complaint', 'The admin has taken ownership of your complaint.', {
          type: 'complaint_accepted',
          complaintId,
        });
      }
    }

    await createAuditLog({ action: 'admin_iwillhandle', performedBy: req.admin?.uid, performedByRole: 'admin', targetId: complaintId, targetType: 'complaint' });
    logger.info('[Admin] iwillhandle', { complaintId });
    sendSuccess(res, { message: 'Marked as admin handling' });
  } catch (error) {
    logger.error('[Admin] iwillhandle failed', { error: error.message });
    sendError(res, error.message);
  }
};

const markFlagResolved = async (req, res) => {
  try {
    const { complaintId } = req.body;
    if (!complaintId) return sendError(res, 'Complaint ID required', 400);

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found', 404);

    const resolvedAt = new Date();
    await prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: 'completed',
        flagResolved: true,
        flagResolvedBy: 'admin',
        flagResolvedAt: resolvedAt,
        completedAt: resolvedAt,
        hodResolutionEmailSent: true,
        ratingDisabled: true,
      },
    });

    if (complaint.submittedById) {
      const { sendPushNotification, getTokenForUid } = require('../services/notificationService');
      const tokens = await getTokenForUid(complaint.submittedById);
      if (tokens.length > 0) {
        await sendPushNotification(tokens, 'Complaint Resolved', 'Your complaint has been resolved by the admin.', {
          type: 'complaint_completed',
          complaintId,
        });
      }
    }

    try {
      const { sendHODResolutionEmail } = require('./escalationController');
      await sendHODResolutionEmail({ ...complaint, id: complaintId, flagResolvedAt: resolvedAt, flagResolvedBy: 'admin' }, 'admin');
    } catch (emailErr) {
      console.error('HOD resolution email failed:', emailErr.message);
    }

    await createAuditLog({ action: 'admin_resolved_complaint', performedBy: req.admin?.uid, performedByRole: 'admin', targetId: complaintId, targetType: 'complaint' });
    logger.info('[Admin] markFlagResolved', { complaintId });
    sendSuccess(res, { message: 'Complaint marked as resolved' });
  } catch (error) {
    logger.error('[Admin] markFlagResolved failed', { error: error.message });
    sendError(res, error.message);
  }
};

module.exports = {
  login,
  getPendingStaff,
  getAllStaff,
  getStaffById,
  approveStaff,
  rejectStaff,
  getStats,
  getAllComplaints,
  getAllUsers,
  getUserIdCard,
  getIdCardRequests,
  approveIdCard,
  rejectIdCard,
  getDeletionRequests,
  approveDeletion,
  rejectDeletion,
  getSecurityIssues,
  resolveSecurityIssue,
  getAllLostFound,
  iwillhandle,
  markFlagResolved,
};