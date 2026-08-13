const prisma = require('../config/prisma');
const { toZonedTime, fromZonedTime } = require('date-fns-tz');
const { sendPushNotification, getTokensByDesignation, getTokenForUid } = require('../services/notificationService');
const { scheduleEscalation, cancelEscalation } = require('../services/schedulerService');
const { createAuditLog } = require('../services/auditLogService');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../services/logger');



const getComplaintSettings = async () => {
  let settings = await prisma.complaintSettings.findUnique({ where: { id: 'singleton' } });
  if (!settings) {
    settings = await prisma.complaintSettings.create({ data: { id: 'singleton' } });
  }
  return settings;
};

const isComplaintOpen = (settings) => {
  if (!settings.isEnabled) return { open: false, reason: 'disabled' };
  const tz = settings.timezone || 'Asia/Kolkata';
  const now = toZonedTime(new Date(), tz);
  const day = now.getDay();
  const dayMap = [
    settings.sundayEnabled,
    settings.mondayEnabled,
    settings.tuesdayEnabled,
    settings.wednesdayEnabled,
    settings.thursdayEnabled,
    settings.fridayEnabled,
    settings.saturdayEnabled,
  ];
  if (!dayMap[day]) return { open: false, reason: 'day' };
  const hh = now.getHours();
  const mm = now.getMinutes();
  const currentMinutes = hh * 60 + mm;
  const [openH, openM] = settings.openingTime.split(':').map(Number);
  const [closeH, closeM] = settings.closingTime.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  if (currentMinutes < openMinutes || currentMinutes >= closeMinutes) return { open: false, reason: 'time' };
  return { open: true };
};

const buildClosedMessage = (settings) => {
  if (settings.closedMessage) return settings.closedMessage;
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayMap = [settings.sundayEnabled, settings.mondayEnabled, settings.tuesdayEnabled, settings.wednesdayEnabled, settings.thursdayEnabled, settings.fridayEnabled, settings.saturdayEnabled];
  const enabledDays = days.filter((_, i) => dayMap[i]);
  const dayStr = enabledDays.length > 0 ? enabledDays.join(', ') : 'No days configured';
  return `Complaint submissions are currently closed. Available: ${dayStr}, ${settings.openingTime} - ${settings.closingTime} (${settings.timezone}).`;
};

const getSettings = async (req, res) => {
  try {
    const settings = await getComplaintSettings();
    const dayMap = {
      monday: settings.mondayEnabled,
      tuesday: settings.tuesdayEnabled,
      wednesday: settings.wednesdayEnabled,
      thursday: settings.thursdayEnabled,
      friday: settings.fridayEnabled,
      saturday: settings.saturdayEnabled,
      sunday: settings.sundayEnabled,
    };
    sendSuccess(res, {
      enabled: settings.isEnabled,
      timezone: settings.timezone,
      openingTime: settings.openingTime,
      closingTime: settings.closingTime,
      workingDays: dayMap,
      closedMessage: settings.closedMessage || null,
      isCurrentlyOpen: isComplaintOpen(settings).open,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const updateSettings = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { isEnabled, timezone, openingTime, closingTime, workingDays, closedMessage } = req.body;
    const existing = await getComplaintSettings();
    const updateData = {};
    if (isEnabled !== undefined) updateData.isEnabled = Boolean(isEnabled);
    if (timezone !== undefined) updateData.timezone = timezone;
    if (openingTime !== undefined) updateData.openingTime = openingTime;
    if (closingTime !== undefined) updateData.closingTime = closingTime;
    if (closedMessage !== undefined) updateData.closedMessage = closedMessage || null;
    if (workingDays && typeof workingDays === 'object') {
      if (workingDays.monday !== undefined) updateData.mondayEnabled = Boolean(workingDays.monday);
      if (workingDays.tuesday !== undefined) updateData.tuesdayEnabled = Boolean(workingDays.tuesday);
      if (workingDays.wednesday !== undefined) updateData.wednesdayEnabled = Boolean(workingDays.wednesday);
      if (workingDays.thursday !== undefined) updateData.thursdayEnabled = Boolean(workingDays.thursday);
      if (workingDays.friday !== undefined) updateData.fridayEnabled = Boolean(workingDays.friday);
      if (workingDays.saturday !== undefined) updateData.saturdayEnabled = Boolean(workingDays.saturday);
      if (workingDays.sunday !== undefined) updateData.sundayEnabled = Boolean(workingDays.sunday);
    }
    if (uid) updateData.updatedById = uid;
    const updated = await prisma.complaintSettings.update({ where: { id: 'singleton' }, data: updateData });
    await createAuditLog({
      action: 'complaint_settings_updated',
      performedBy: uid,
      performedByRole: 'admin',
      targetId: 'singleton',
      targetType: 'complaint_settings',
      metadata: { previous: existing, updated: updateData },
    });
    const dayMap = {
      monday: updated.mondayEnabled,
      tuesday: updated.tuesdayEnabled,
      wednesday: updated.wednesdayEnabled,
      thursday: updated.thursdayEnabled,
      friday: updated.fridayEnabled,
      saturday: updated.saturdayEnabled,
      sunday: updated.sundayEnabled,
    };
    sendSuccess(res, {
      enabled: updated.isEnabled,
      timezone: updated.timezone,
      openingTime: updated.openingTime,
      closingTime: updated.closingTime,
      workingDays: dayMap,
      closedMessage: updated.closedMessage || null,
      isCurrentlyOpen: isComplaintOpen(updated).open,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const generateTicketId = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `UNF-${timestamp}-${random}`;
};

const getSeconds = (ts) => {
  if (!ts) return null;
  if (ts instanceof Date) return ts.getTime() / 1000;
  if (typeof ts === 'number') return ts;
  return null;
};

const notifyReporter = async (reporterUid, title, body, data) => {
  const tokens = await getTokenForUid(reporterUid);
  if (tokens.length > 0) sendPushNotification(tokens, title, body, data);
};

const notifyStaffMember = async (staffUid, title, body, data) => {
  const tokens = await getTokenForUid(staffUid);
  if (tokens.length > 0) sendPushNotification(tokens, title, body, data);
};

const submit = async (req, res) => {
  try {
    const settings = await getComplaintSettings();
    const availability = isComplaintOpen(settings);
    if (!availability.open) return sendError(res, buildClosedMessage(settings), 403);

    const { category, subIssue, customIssue, description, building, roomDetail, photoUrl } = req.body;
    const uid = req.user.uid;

    if (!subIssue && !customIssue) return sendError(res, 'Please select or enter an issue', 400);

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);

    const ticketId = generateTicketId();
    let assignableTo = [];
    let requiredDesignation = null;
    let notifyGender = null;

const categoryRecord = await prisma.category.findFirst({
      where: { name: { equals: category, mode: 'insensitive' } },
    });
    requiredDesignation = categoryRecord?.designation || null;

    const isWashroom = category.toLowerCase() === 'washroom';
    if (isWashroom) {
      if (!user.gender) return sendError(res, 'Your profile does not have a gender set. Please update your profile first.', 400);
      const staff = await prisma.user.findMany({
        where: { role: 'staff', designation: requiredDesignation || 'Cleaner', verificationStatus: 'approved', gender: user.gender },
        select: { id: true },
      });
      assignableTo = staff.map(s => s.id);
      notifyGender = user.gender;
    } else if (requiredDesignation) {
      const staff = await prisma.user.findMany({
        where: { role: 'staff', designation: requiredDesignation, verificationStatus: 'approved' },
        select: { id: true },
      });
      assignableTo = staff.map(s => s.id);
    }
    const { NO_ACCEPTANCE_LIMITS } = require('../config/escalationLimits');
    const nextCheckAt = new Date(Date.now() + (NO_ACCEPTANCE_LIMITS[category?.toLowerCase()] || 24 * 60 * 60 * 1000));

    const complaint = await prisma.complaint.create({
      data: {
        ticketId,
        category,
        subIssue: subIssue || null,
        customIssue: customIssue || null,
        description: description || '',
        building,
        roomDetail: roomDetail || '',
        photoUrl: photoUrl || null,
        submittedById: uid,
        submittedByName: user.fullName || '',
        submittedByRole: user.role || '',
        submittedByEmail: user.email || '',
        submittedByPhone: user.phone || '',
        submittedByGender: user.gender || '',
        assignableTo,
        nextCheckAt,
      },
    });

    await scheduleEscalation(complaint.id, category, Date.now());
    await createAuditLog({ action: 'complaint_submitted', performedBy: uid, performedByRole: user.role, targetId: complaint.id, targetType: 'complaint', metadata: { category, building, ticketId } });
    logger.info('[Complaint] Submitted', { complaintId: complaint.id, uid, category });

    if (assignableTo.length > 0 && requiredDesignation) {
      const staffTokens = await getTokensByDesignation(requiredDesignation, uid, notifyGender);
      const issueTitle = subIssue || customIssue || 'New Issue';
      sendPushNotification(staffTokens, 'New Complaint Assigned', `${user.fullName || 'Someone'} reported: ${issueTitle}. Location: ${building.replace(/\s*—\s*/g, ', ')}`, {
        type: 'new_complaint',
        complaintId: complaint.id,
        ticketId,
      });
    }

    sendSuccess(res, {
      ticketId,
      complaintId: complaint.id,
      message: 'Complaint submitted successfully',
      queueStatus: 'waiting_for_staff',
      assignableStaffCount: assignableTo.length,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const accept = async (req, res) => {
  try {
    const settings = await getComplaintSettings();
    const availability = isComplaintOpen(settings);
    if (!availability.open) return sendError(res, buildClosedMessage(settings), 403);

    const { complaintId } = req.body;
    const uid = req.user.uid;
    if (!complaintId) return sendError(res, 'Complaint ID required', 400);

    const staffUser = await prisma.user.findUnique({ where: { id: uid } });
    if (!staffUser) return sendError(res, 'Staff not found', 404);

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found', 404);
    if (complaint.status !== 'pending') return sendError(res, 'Complaint already accepted by someone else', 400);
    if (!complaint.assignableTo.includes(uid)) return sendError(res, 'You are not authorized to accept this complaint', 403);

    const { ESCALATION_LIMITS } = require('../config/escalationLimits');
    const nextCheckAt = new Date(Date.now() + (ESCALATION_LIMITS[complaint.category?.toLowerCase()] || 24 * 60 * 60 * 1000));

    await prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: 'assigned',
        queueStatus: 'assigned',
        assignedToId: uid,
        assignedToName: staffUser.fullName || '',
        assignedToPhone: staffUser.phone || '',
        acceptedAt: new Date(),
        nextCheckAt,
      },
    });

    await cancelEscalation(complaintId);
    await scheduleEscalation(complaintId, complaint.category, Date.now());
    await createAuditLog({ action: 'complaint_accepted', performedBy: uid, performedByRole: 'staff', targetId: complaintId, targetType: 'complaint', metadata: { ticketId: complaint.ticketId } });
    logger.info('[Complaint] Accepted', { complaintId, staffUid: uid });

    const issueTitle = complaint.subIssue || complaint.customIssue || 'Your complaint';
    await notifyReporter(complaint.submittedById, 'Complaint Accepted', `${staffUser.fullName || 'A staff member'} has accepted your complaint: ${issueTitle}`, {
      type: 'complaint_accepted', complaintId, ticketId: complaint.ticketId,
    });

    const cleanBuilding = complaint.building.replace(/—/g, '').trim();
    const cleanTitle = issueTitle.replace(/—/g, '').trim();
    await notifyStaffMember(uid, 'Complaint Accepted', `You accepted: ${cleanTitle} at ${cleanBuilding}, Room ${complaint.roomDetail || ''}`, {
      type: 'complaint_accepted', complaintId, ticketId: complaint.ticketId,
    });

    sendSuccess(res, { message: 'Complaint accepted successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const updateStatus = async (req, res) => {
  try {
    const settings = await getComplaintSettings();
    const availability = isComplaintOpen(settings);
    if (!availability.open) return sendError(res, buildClosedMessage(settings), 403);

    const { complaintId, status } = req.body;
    const uid = req.user.uid;
    if (!complaintId || !status) return sendError(res, 'Complaint ID and status required', 400);

    const validStatuses = ['in_progress', 'completed'];
    if (!validStatuses.includes(status)) return sendError(res, 'Invalid status', 400);

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found', 404);
    if (complaint.assignedToId !== uid) return sendError(res, 'You are not assigned to this complaint', 403);

    const updateData = { status, queueStatus: status };
    if (status === 'completed') {
      updateData.completedAt = new Date();
      updateData.nextCheckAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      cancelEscalation(complaintId);
    }

    await prisma.complaint.update({ where: { id: complaintId }, data: updateData });
    await createAuditLog({ action: `complaint_status_${status}`, performedBy: uid, performedByRole: 'staff', targetId: complaintId, targetType: 'complaint', metadata: { status, ticketId: complaint.ticketId } });
    logger.info('[Complaint] Status updated', { complaintId, status, staffUid: uid });

    const issueTitle = complaint.subIssue || complaint.customIssue || 'Your complaint';

    if (status === 'in_progress') {
      await notifyReporter(complaint.submittedById, 'Work In Progress', `Work has started on your complaint: ${issueTitle}`, { type: 'complaint_in_progress', complaintId, ticketId: complaint.ticketId });
      await notifyStaffMember(uid, 'Status Updated', `You marked "${issueTitle}" as In Progress`, { type: 'complaint_in_progress', complaintId, ticketId: complaint.ticketId });
    }

    if (status === 'completed') {
      await notifyReporter(complaint.submittedById, 'Complaint Resolved', `Your complaint "${issueTitle}" has been resolved. Please rate the work.`, { type: 'complaint_completed', complaintId, ticketId: complaint.ticketId });
      await notifyStaffMember(uid, 'Task Completed', `You completed: ${issueTitle}`, { type: 'complaint_completed', complaintId, ticketId: complaint.ticketId });

      if (complaint.flagged && !complaint.flagResolved) {
        const adminTokens = await require('../services/notificationService').getTokensByRole(['admin']);
        if (adminTokens.length > 0) {
          await sendPushNotification(adminTokens, 'Flagged Complaint Resolved by Staff', `${complaint.assignedToName || 'Staff'} resolved: ${issueTitle}`, { type: 'complaint_completed', complaintId });
        }

        if (complaint.hodEmailSent) {
          try {
            await prisma.complaint.update({
              where: { id: complaintId },
              data: { flagResolvedBy: 'staff', flagResolvedAt: new Date(), hodResolutionEmailSent: true },
            });
            const { sendHODResolutionEmail } = require('./escalationController');
            await sendHODResolutionEmail({ ...complaint, id: complaintId, flagResolvedBy: 'staff', flagResolvedAt: new Date() }, 'staff');
          } catch (emailErr) {
            console.error('HOD resolution email failed:', emailErr.message);
          }
        }
      }
    }

    sendSuccess(res, { message: `Status updated to ${status}` });
  } catch (error) {
    sendError(res, error.message);
  }
};

const reject = async (req, res) => {
  try {
    const settings = await getComplaintSettings();
    const availability = isComplaintOpen(settings);
    if (!availability.open) return sendError(res, buildClosedMessage(settings), 403);

    const { complaintId, reason } = req.body;
    if (!complaintId || !reason) return sendError(res, 'complaintId and reason are required.', 400);

    const uid = req.user.uid;
    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found.', 404);
    if (!complaint.assignableTo?.includes(uid)) return sendError(res, 'You are not authorized to reject this complaint.', 403);
    if (complaint.status !== 'pending') return sendError(res, 'Only pending complaints can be rejected.', 400);

    const staffUser = await prisma.user.findUnique({ where: { id: uid }, select: { fullName: true } });
    const staffName = staffUser?.fullName || 'Staff';

    const newAssignableTo = complaint.assignableTo.filter(id => id !== uid);
    const rejectedBy = Array.isArray(complaint.rejectedBy) ? complaint.rejectedBy : [];
    rejectedBy.push({ uid, name: staffName, reason, rejectedAt: new Date().toISOString() });
    const rejectedByUids = rejectedBy.map(r => r.uid);

    const updateData = { assignableTo: newAssignableTo, rejectedBy, rejectedByUids };

    if (newAssignableTo.length === 0) {
      updateData.status = 'rejected';
      updateData.queueStatus = 'rejected';
      updateData.rejectionReason = reason;
      updateData.nextCheckAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      cancelEscalation(complaintId);
      logger.info('[Complaint] Fully rejected by all staff', { complaintId });

      const issueTitle = complaint.subIssue || complaint.customIssue || 'Your complaint';
      await notifyReporter(complaint.submittedById, 'Complaint Rejected', `Unfortunately your complaint "${issueTitle}" could not be assigned to any staff.`, {
        type: 'complaint_rejected', complaintId, ticketId: complaint.ticketId,
      });
    }

    await prisma.complaint.update({ where: { id: complaintId }, data: updateData });
    await createAuditLog({ action: 'complaint_rejected', performedBy: uid, performedByRole: 'staff', targetId: complaintId, targetType: 'complaint', metadata: { reason, allRejected: newAssignableTo.length === 0 } });

    sendSuccess(res, {
      message: newAssignableTo.length > 0
        ? 'You rejected this complaint. Other staff can still accept it.'
        : 'Complaint rejected by all staff.',
    });
  } catch (error) {
    logger.error('[Complaint] Reject failed', { error: error.message, complaintId: req.body?.complaintId });
    sendError(res, error.message);
  }
};

const rate = async (req, res) => {
  try {
    const { complaintId, rating, comment } = req.body;
    const uid = req.user.uid;

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return sendError(res, 'Complaint not found.', 404);
    if (complaint.submittedById !== uid) return sendError(res, 'You can only rate your own complaints.', 403);
    if (complaint.status !== 'completed') return sendError(res, 'You can only rate completed complaints.', 400);
    if (complaint.rating !== null && complaint.rating !== undefined) return sendError(res, 'You have already rated this complaint.', 400);
    if (!complaint.assignedToId) return sendError(res, 'No staff assigned to rate.', 400);
    if (complaint.ratingDisabled) return sendError(res, 'This complaint cannot be rated.', 400);

    await prisma.complaint.update({
      where: { id: complaintId },
      data: { rating, ratingComment: comment || null, ratedAt: new Date() },
    });

    const staffUser = await prisma.user.findUnique({ where: { id: complaint.assignedToId } });
    if (staffUser) {
      const newCount = (staffUser.ratingCount || 0) + 1;
      const newTotal = (staffUser.ratingTotal || 0) + rating;
      await prisma.user.update({
        where: { id: complaint.assignedToId },
        data: { ratingTotal: newTotal, ratingCount: newCount, avgRating: Math.round((newTotal / newCount) * 10) / 10 },
      });

      const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
      await notifyStaffMember(complaint.assignedToId, 'New Rating Received', `You received ${rating}/5 ${stars} for: ${complaint.subIssue || complaint.customIssue || 'a complaint'}`, {
        type: 'new_rating', complaintId,
      });
    }

    sendSuccess(res, { message: 'Rating submitted successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const myComplaints = async (req, res) => {
  try {
    const uid = req.user.uid;
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;

    const complaints = await prisma.complaint.findMany({
      where: {
        submittedById: uid,
        ...(since ? { updatedAt: { gt: since } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });

    sendSuccess(res, { complaints });
  } catch (error) {
    sendError(res, error.message);
  }
};

const staffComplaints = async (req, res) => {
  try {
    const uid = req.user.uid;
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;
    const sinceFilter = since ? { updatedAt: { gt: since } } : {};

    const [pendingSnap, assignedSnap, rejectedSnap] = await Promise.all([
      prisma.complaint.findMany({
        where: { assignableTo: { has: uid }, status: 'pending', ...sinceFilter },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.complaint.findMany({
        where: { assignedToId: uid, ...sinceFilter },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.complaint.findMany({
        where: { rejectedByUids: { has: uid }, ...sinceFilter },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const active = assignedSnap.filter(c => c.status === 'assigned' || c.status === 'in_progress');
    const completed = assignedSnap.filter(c => c.status === 'completed');

    const completedWithTimes = completed.filter(c => c.createdAt && c.completedAt);
    let avgTimeMinutes = null;
    if (completedWithTimes.length > 0) {
      const totalMs = completedWithTimes.reduce((sum, c) => {
        const start = getSeconds(c.createdAt);
        const end = getSeconds(c.completedAt);
        return start !== null && end !== null ? sum + Math.max(0, (end - start) * 1000) : sum;
      }, 0);
      avgTimeMinutes = completedWithTimes.length > 0 ? Math.round(totalMs / completedWithTimes.length / 60000) : null;
    }

    const staffUser = await prisma.user.findUnique({ where: { id: uid }, select: { avgRating: true, ratingCount: true } });
    const rejected = rejectedSnap.filter(c => Array.isArray(c.rejectedBy) && c.rejectedBy.some(r => r.uid === uid));

    sendSuccess(res, {
      pending: pendingSnap,
      active,
      completed,
      rejected,
      avgTimeMinutes,
      avgRating: staffUser?.avgRating || null,
      ratingCount: staffUser?.ratingCount || 0,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const allComplaints = async (req, res) => {
  try {
    const complaints = await prisma.complaint.findMany({ orderBy: { createdAt: 'desc' } });
    sendSuccess(res, { complaints });
  } catch (error) {
    sendError(res, error.message);
  }
};

module.exports = { submit, accept, updateStatus, reject, rate, myComplaints, staffComplaints, allComplaints, getSettings, updateSettings };