const prisma = require('../config/prisma');
const logger = require('./logger');

async function createAuditLog({ action, performedBy, performedByRole, targetId, targetType, metadata = {} }) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        performedById: performedBy || null,
        performedByRole: performedByRole || null,
        targetId: targetId || null,
        targetType: targetType || null,
        metadata,
      },
    });
  } catch (err) {
    logger.error('[AuditLog] Failed to write audit log', { action, performedBy, error: err.message });
  }
}

module.exports = { createAuditLog };