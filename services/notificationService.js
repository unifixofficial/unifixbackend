const admin = require('../config/firebase');
const prisma = require('../config/prisma');
const logger = require('./logger');
const { logNotification } = require('./notificationLogger');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const sendPushNotification = async (tokens, title, body, data = {}) => {
  try {
    if (!tokens || tokens.length === 0) {
      logger.warn('[Notification] No tokens provided', { title });
      return;
    }

    const expoTokens = tokens.filter(t => t && typeof t === 'string' && t.startsWith('ExponentPushToken'));
    const fcmTokens = tokens.filter(t => t && typeof t === 'string' && !t.startsWith('ExponentPushToken'));

    if (expoTokens.length > 0) await sendViaExpo(expoTokens, title, body, data);
    if (fcmTokens.length > 0) await sendViaFCM(fcmTokens, title, body, data);

    if (expoTokens.length === 0 && fcmTokens.length === 0) {
      logger.warn('[Notification] No valid tokens found', { title });
      return;
    }

    await logNotification({
      recipientUid: data.recipientUid || null,
      title,
      body,
      type: data.type || 'unknown',
      status: 'sent',
      tokens,
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

const sendViaExpo = async (expoPushTokens, title, body, data = {}) => {
  try {
    const messages = expoPushTokens.map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: { ...data, _deepLink: buildDeepLink(data) },
      priority: 'high',
      channelId: 'default',
    }));

    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const result = await response.json();
      logger.info('[Notification] Expo push result', { result });

      if (result?.data) {
        await Promise.all(
          result.data.map(async (ticket, idx) => {
            if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
              const staleToken = batch[idx]?.to;
              if (staleToken) {
                await prisma.user.updateMany({
                  where: { expoPushToken: staleToken },
                  data: { expoPushToken: null },
                });
              }
            }
          })
        );
      }
    }
  } catch (error) {
    logger.error('[Notification] Expo push error', { error: error.message });
  }
};

const sendViaFCM = async (fcmTokens, title, body, data = {}) => {
  try {
    const validTokens = fcmTokens.slice(0, 500);
    const message = {
      tokens: validTokens,
      notification: { title, body },
      data: { ...data, _deepLink: buildDeepLink(data) || '' },
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
      const failedTokens = response.responses
        .map((resp, idx) => (resp.error ? validTokens[idx] : null))
        .filter(Boolean);
      for (const token of failedTokens) {
        await prisma.user.updateMany({
          where: { expoPushToken: token },
          data: { expoPushToken: null },
        });
      }
    }
  } catch (error) {
    logger.error('[Notification] FCM push error', { error: error.message });
  }
};

const buildDeepLink = (data = {}) => {
  const { type, complaintId, itemId } = data;
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

const extractTokensFromUser = (user) => {
  const tokens = [];
  if (user.expoPushToken && typeof user.expoPushToken === 'string') {
    tokens.push(user.expoPushToken);
  }
  return [...new Set(tokens)];
};

const getAllUserTokens = async (excludeUid = null) => {
  const users = await prisma.user.findMany({
    where: {
      id: excludeUid ? { not: excludeUid } : undefined,
      expoPushToken: { not: null },
      accountStatus: 'active',
    },
    select: { id: true, expoPushToken: true, role: true, verificationStatus: true },
  });

  const tokens = [];
  for (const u of users) {
    if (u.role === 'staff' && u.verificationStatus !== 'approved') continue;
    if (u.expoPushToken) tokens.push(u.expoPushToken);
  }
  return tokens;
};

const getTokensByRole = async (roles = [], excludeUid = null) => {
  const tokens = [];
  for (const role of roles) {
    const users = await prisma.user.findMany({
      where: {
        role,
        id: excludeUid ? { not: excludeUid } : undefined,
        expoPushToken: { not: null },
        accountStatus: 'active',
        ...(role === 'staff' ? { verificationStatus: 'approved' } : {}),
      },
      select: { expoPushToken: true },
    });
    users.forEach(u => { if (u.expoPushToken) tokens.push(u.expoPushToken); });
  }
  return tokens;
};

const getTokensByDesignation = async (designation, excludeUid = null, gender = null) => {
  const users = await prisma.user.findMany({
    where: {
      role: 'staff',
      designation,
      verificationStatus: 'approved',
      accountStatus: 'active',
      id: excludeUid ? { not: excludeUid } : undefined,
      expoPushToken: { not: null },
      ...(gender ? { gender } : {}),
    },
    select: { expoPushToken: true },
  });
  return users.map(u => u.expoPushToken).filter(Boolean);
};

const getTokenForUid = async (uid) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { expoPushToken: true },
  });
  if (!user || !user.expoPushToken) return [];
  return [user.expoPushToken];
};

module.exports = {
  sendPushNotification,
  getAllUserTokens,
  getTokensByRole,
  getTokensByDesignation,
  getTokenForUid,
};