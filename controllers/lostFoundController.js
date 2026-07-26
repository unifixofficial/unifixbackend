const prisma = require('../config/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const { sendPushNotification, getAllUserTokens, getTokenForUid, getTokensByRole } = require('../services/notificationService');

const post = async (req, res) => {
  try {
    const { itemName, category, description, roomNumber, roomLabel, collectLocation, photoUrl } = req.body;
    const uid = req.user.uid;

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);

    const item = await prisma.lostFound.create({
      data: {
        itemName: itemName.trim(),
        category: category || 'Others',
        description: description || '',
        roomNumber: roomNumber.trim(),
        roomLabel: roomLabel || '',
        collectLocation: collectLocation.trim(),
        photoUrl: photoUrl || null,
        postedById: uid,
        postedByName: user.fullName || '',
        postedByRole: user.role || '',
        postedByEmail: user.email || '',
      },
    });

    const ownerTokens = await getTokenForUid(uid);
    const othersTokens = await getAllUserTokens(uid);

    if (ownerTokens.length > 0) {
      await sendPushNotification(ownerTokens, 'Lost & Found', `You posted a found item: ${itemName.trim()}, Collect from ${collectLocation.trim()}`, { type: 'new_lost_found', itemId: item.id, postedByRole: user.role || '' });
    }
    if (othersTokens.length > 0) {
      await sendPushNotification(othersTokens, 'Lost & Found', `${user.fullName || 'Someone'} found: ${itemName.trim()}, Collect from ${collectLocation.trim()}`, { type: 'new_lost_found', itemId: item.id, postedByRole: user.role || '' });
    }

    sendSuccess(res, { itemId: item.id, message: 'Item posted successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const feed = async (req, res) => {
  try {
    const uid = req.user.uid;
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;

    if (since) {
      const items = await prisma.lostFound.findMany({
        where: { updatedAt: { gt: since } },
        orderBy: { updatedAt: 'desc' },
      });
      return sendSuccess(res, {
        items: items.map(i => ({ ...i, isMyPost: i.postedById === uid })),
        nextCursor: null,
        hasMore: false,
      });
    }

    const limit = parseInt(req.query.limit) || 10;
    const after = req.query.after || null;

    const items = await prisma.lostFound.findMany({
      where: {
        status: 'available',
        ...(after ? { createdAt: { lt: (await prisma.lostFound.findUnique({ where: { id: after }, select: { createdAt: true } }))?.createdAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    sendSuccess(res, {
      items: page.map(i => ({ ...i, createdAt: i.createdAt?.getTime() ?? null, isMyPost: i.postedById === uid })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const handover = async (req, res) => {
  try {
    const { itemId, handedToName } = req.body;
    const uid = req.user.uid;

    if (!itemId || !handedToName) return sendError(res, 'Item ID and recipient name are required.', 400);

    const item = await prisma.lostFound.findUnique({ where: { id: itemId } });
    if (!item) return sendError(res, 'Item not found.', 404);
    if (item.postedById !== uid) return sendError(res, 'Only the person who posted this item can mark it as handed over.', 403);
    if (item.status !== 'available') return sendError(res, 'Item already handed over.', 400);

    const user = await prisma.user.findUnique({ where: { id: uid } });
    const handedAt = new Date();

    await prisma.$transaction([
      prisma.lostFound.update({
        where: { id: itemId },
        data: { status: 'handed_over', handedToName: handedToName.trim(), handedAt, updatedAt: handedAt },
      }),
      prisma.claim.create({
        data: {
          itemId,
          itemName: item.itemName,
          photoUrl: item.photoUrl || null,
          handedByUid: uid,
          handedByName: user?.fullName || '',
          handedByRole: user?.role || '',
          handedToName: handedToName.trim(),
          roomNumber: item.roomNumber || '',
          roomLabel: item.roomLabel || '',
          collectLocation: item.collectLocation || '',
          handedAt,
        },
      }),
    ]);

    const ownerTokens = await getTokenForUid(uid);
    const othersTokens = await getAllUserTokens(uid);

    if (ownerTokens.length > 0) {
      await sendPushNotification(ownerTokens, 'Lost & Found: Item Collected', `You handed "${item.itemName}" over to ${handedToName.trim()}.`, { type: 'item_handed_over', itemId });
    }
    if (othersTokens.length > 0) {
      await sendPushNotification(othersTokens, 'Lost & Found: Item Collected', `"${item.itemName}" has been handed over to ${handedToName.trim()}.`, { type: 'item_handed_over', itemId });
    }

    sendSuccess(res, { message: 'Item marked as handed over successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const myPosts = async (req, res) => {
  try {
    const uid = req.user.uid;
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;

    const items = await prisma.lostFound.findMany({
      where: {
        postedById: uid,
        ...(since ? { updatedAt: { gt: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    sendSuccess(res, { items: items.map(i => ({ ...i, isMyPost: true })) });
  } catch (error) {
    sendError(res, error.message);
  }
};

const claims = async (req, res) => {
  try {
    const since = req.query.since ? new Date(parseInt(req.query.since)) : null;

    const items = await prisma.claim.findMany({
      where: since ? { createdAt: { gt: since } } : {},
      orderBy: { createdAt: 'desc' },
    });

    sendSuccess(res, { items });
  } catch (error) {
    sendError(res, error.message);
  }
};

const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const item = await prisma.lostFound.findUnique({ where: { id } });
    if (!item) return sendError(res, 'Item not found.', 404);
    if (item.postedById !== uid) return sendError(res, 'Only the owner can delete this post.', 403);
    if (item.status === 'handed_over') return sendError(res, 'Cannot delete a handed over item.', 400);

    await prisma.lostFound.delete({ where: { id } });

    sendSuccess(res, { message: 'Post deleted successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

module.exports = { post, feed, handover, myPosts, claims, deletePost };