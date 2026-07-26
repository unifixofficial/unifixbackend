const prisma = require('../config/prisma');
const logger = require('./logger');

async function logNotification({ recipientUid, title, body, type, status, error = null, tokens = [] }) {
  try {
    await prisma.notificationLog.create({
      data: {
        recipientId: recipientUid || null,
        title,
        body,
        type,
        status,
        error: error || null,
        tokenCount: tokens.length,
      },
    });
  } catch (err) {
    logger.error('[NotificationLogger] Failed to log notification', { error: err.message });
  }
}

module.exports = { logNotification };