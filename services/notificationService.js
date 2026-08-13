const admin = require('../config/firebase');
const prisma = require('../config/prisma');
const logger = require('./logger');
const { logNotification } = require('./notificationLogger');

const sendPushNotification = async (tokens, title, body, data = {}) => {
  try {
    if (!tokens || tokens.length === 0) {
      logger.warn('[Notification] No tokens provided', { title });
      return;
    }

    const validTokens = tokens.filter(t => t && typeof t === 'string' && t.length > 0);

    if (validTokens.length === 0) {
      logger.warn('[Notification] No valid tokens found', { title });
      return;
    }

    await sendViaFCM(validTokens, title, body, data);

    await logNotification({
      recipientUid: data.recipientUid || null,
      title,
      body,
      type: data.type || 'unknown',
      status: 'sent',
      tokens: validTokens,
    });
  } catch (error) {
    logger.error('[Notification] sendPushNotification failed', { error: error.message, title });
    await logNotification({
      recipientUid: data.recipientUid || null,
      title,
      body,
      type: data.type || 'unknown',
      status: 'failed',
      error: error.message,
      tokens,
    });
  }
};

const sendViaFCM = async (fcmTokens, title, body, data = {}) => {
  try {
    const stringifiedData = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        stringifiedData[key] = String(value);
      }
    }

    const deepLink = buildDeepLink(data);
    if (deepLink) stringifiedData._deepLink = deepLink;

    const chunks = [];
    for (let i = 0; i < fcmTokens.length; i += 500) {
      chunks.push(fcmTokens.slice(i, i + 500));
    }

    for (const chunk of chunks) {
      const message = {
        tokens: chunk,
        notification: { title, body },
        data: stringifiedData,
        android: {
          priority: 'high',
          notification: { channelId: 'default', sound: 'default' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'content-available': 1 } },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      logger.info('[Notification] FCM response', {
        successCount: response.successCount,
        failureCount: response.failureCount,
      });

      if (response.failureCount > 0) {
        const invalidTokens = response.responses
          .map((resp, idx) => {
            if (!resp.error) return null;
            const code = resp.error.code;
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/invalid-argument'
            ) {
              return chunk[idx];
            }
            logger.warn('[Notification] FCM delivery error', {
              token: chunk[idx]?.slice(0, 20),
              code,
              message: resp.error.message,
            });
            return null;
          })
          .filter(Boolean);

        if (invalidTokens.length > 0) {
          await prisma.deviceToken.deleteMany({
            where: { token: { in: invalidTokens } },
          });
          logger.info('[Notification] Removed invalid FCM tokens', { count: invalidTokens.length });
        }
      }
    }
  } catch (error) {
    logger.error('[Notification] FCM push error', { error: error.message });
  }
};

const buildDeepLink = (data = {}) => {
  const { type, complaintId } = data;
  if (['new_complaint', 'complaint_accepted', 'complaint_in_progress', 'complaint_completed', 'complaint_rejected', 'new_rating'].includes(type)) {
    if (complaintId) return `unifix://complaint/${complaintId}`;
  }
  if (type === 'new_lost_found') return `unifix://lost-and-found?openTab=feed`;
  if (type === 'item_handed_over') return `unifix://lost-and-found?openTab=claims`;
  if (type === 'lost_report_found') return `unifix://lost-and-found?openTab=lost-history`;
  if (type === 'new_lost_report') return `unifix://lost-and-found?openTab=lostreports`;
  if (type === 'new_staff_signup') return `unifix://admin/maintenance`;
  if (type === 'new_idcard_request') return `unifix://admin/idcards`;
  if (type === 'new_deletion_request') return `unifix://admin/deletions`;
  if (type === 'new_security_issue') return `unifix://admin/security`;
  return null;
};

const getDeviceTokensForUser = async (uid) => {
  const rows = await prisma.deviceToken.findMany({
    where: { userId: uid },
    select: { token: true },
  });
  return rows.map(r => r.token);
};

const getAllUserTokens = async (excludeUid = null) => {
  const users = await prisma.user.findMany({
    where: {
      id: excludeUid ? { not: excludeUid } : undefined,
      accountStatus: 'active',
      deviceTokens: { some: {} },
    },
    select: {
      id: true,
      role: true,
      verificationStatus: true,
      deviceTokens: { select: { token: true } },
    },
  });

  const tokens = [];
  for (const u of users) {
    if (u.role === 'staff' && u.verificationStatus !== 'approved') continue;
    u.deviceTokens.forEach(dt => tokens.push(dt.token));
  }
  return [...new Set(tokens)];
};

const getTokensByRole = async (roles = [], excludeUid = null) => {
  const tokens = [];
  for (const role of roles) {
    const users = await prisma.user.findMany({
      where: {
        role,
        id: excludeUid ? { not: excludeUid } : undefined,
        accountStatus: 'active',
        ...(role === 'staff' ? { verificationStatus: 'approved' } : {}),
        deviceTokens: { some: {} },
      },
      select: { deviceTokens: { select: { token: true } } },
    });
    users.forEach(u => u.deviceTokens.forEach(dt => tokens.push(dt.token)));
  }
  return [...new Set(tokens)];
};

const getTokensByDesignation = async (designation, excludeUid = null, gender = null) => {
  const users = await prisma.user.findMany({
    where: {
      role: 'staff',
      designation,
      verificationStatus: 'approved',
      accountStatus: 'active',
      id: excludeUid ? { not: excludeUid } : undefined,
      ...(gender ? { gender } : {}),
      deviceTokens: { some: {} },
    },
    select: { deviceTokens: { select: { token: true } } },
  });
  return users.flatMap(u => u.deviceTokens.map(dt => dt.token));
};

const getTokenForUid = async (uid) => {
  return getDeviceTokensForUser(uid);
};

module.exports = {
  sendPushNotification,
  getAllUserTokens,
  getTokensByRole,
  getTokensByDesignation,
  getTokenForUid,
};