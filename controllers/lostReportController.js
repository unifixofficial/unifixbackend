const prisma = require('../config/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const { sendPushNotification, getTokenForUid, getTokensByRole } = require('../services/notificationService');

const post = async (req, res) => {
  try {
    const { itemName, category, description, locationLost, dateLost, howToReach, images } = req.body;
    const uid = req.user.uid;

    if (!itemName || !category || !description || !locationLost || !dateLost || !howToReach) {
      return sendError(res, 'All required fields must be filled.', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);
    if (user.role === 'staff') return sendError(res, 'Staff cannot post lost reports.', 403);

    const report = await prisma.lostReport.create({
      data: {
        itemName: itemName.trim(),
        category,
        description: description.trim(),
        locationLost,
        dateLost,
        howToReach: howToReach.trim(),
        images: images || [],
        postedById: uid,
        postedByName: user.fullName || '',
        postedByRole: user.role || '',
        postedByDept: user.department || null,
      },
    });

    const ownerTokens = await getTokenForUid(uid);
    const otherTokens = await getTokensByRole(['student', 'teacher'], uid);

    if (ownerTokens.length > 0) {
      await sendPushNotification(ownerTokens, 'Lost Item Report', `You posted a lost item report: ${itemName.trim()}`, { type: 'new_lost_report', reportId: report.id });
    }
    if (otherTokens.length > 0) {
      await sendPushNotification(otherTokens, 'Lost Item Report', `${user.fullName || 'Someone'} lost: ${itemName.trim()}, Can you help?`, { type: 'new_lost_report', reportId: report.id });
    }

    sendSuccess(res, { reportId: report.id, message: 'Lost report posted successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const feed = async (req, res) => {
  try {
    const uid = req.user.uid;
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;

    if (since) {
      const [updated, deleted] = await Promise.all([
        prisma.lostReport.findMany({
          where: { status: { in: ['active', 'found'] }, updatedAt: { gt: since } },
          orderBy: { updatedAt: 'desc' },
        }),
        prisma.lostReport.findMany({
          where: { status: 'deleted', updatedAt: { gt: since } },
          select: { id: true },
        }),
      ]);

      return sendSuccess(res, {
        items: updated.map(r => ({ ...r, postedAt: r.postedAt?.getTime() ?? null, isMyPost: r.postedById === uid })),
        deletedIds: deleted.map(r => r.id),
        nextCursor: null,
        hasMore: false,
      });
    }

    const limit = parseInt(req.query.limit) || 10;
    const after = req.query.after || null;

    const reports = await prisma.lostReport.findMany({
      where: {
        status: { in: ['active', 'found'] },
        ...(after ? { postedAt: { lt: (await prisma.lostReport.findUnique({ where: { id: after }, select: { postedAt: true } }))?.postedAt } } : {}),
      },
      orderBy: { postedAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = reports.length > limit;
    const page = hasMore ? reports.slice(0, limit) : reports;

    sendSuccess(res, {
      items: page.map(r => ({ ...r, postedAt: r.postedAt?.getTime() ?? null, isMyPost: r.postedById === uid })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const markFound = async (req, res) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const report = await prisma.lostReport.findUnique({ where: { id } });
    if (!report) return sendError(res, 'Report not found.', 404);
    if (report.postedById !== uid) return sendError(res, 'Only the owner can mark this as found.', 403);
    if (report.status !== 'active') return sendError(res, 'This report is no longer active.', 400);

    await prisma.lostReport.update({ where: { id }, data: { status: 'found' } });

    const ownerTokens = await getTokenForUid(uid);
    const otherTokens = await getTokensByRole(['student', 'teacher'], uid);

    if (ownerTokens.length > 0) {
      await sendPushNotification(ownerTokens, 'Item Found!', `You marked your "${report.itemName}" as found.`, { type: 'lost_report_found', reportId: id });
    }
    if (otherTokens.length > 0) {
      await sendPushNotification(otherTokens, 'Item Found!', `${report.postedByName || 'Someone'}'s lost "${report.itemName}" has been found!`, { type: 'lost_report_found', reportId: id });
    }

    sendSuccess(res, { message: 'Marked as found.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const deleteReport = async (req, res) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const report = await prisma.lostReport.findUnique({ where: { id } });
    if (!report) return sendError(res, 'Report not found.', 404);
    if (report.postedById !== uid) return sendError(res, 'Only the owner can delete this report.', 403);

    await prisma.lostReport.update({ where: { id }, data: { status: 'deleted' } });

    sendSuccess(res, { message: 'Report deleted.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

module.exports = { post, feed, markFound, deleteReport };