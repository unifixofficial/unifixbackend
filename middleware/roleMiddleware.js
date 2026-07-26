const { verifyAccessToken } = require('../utils/jwt');
const prisma = require('../config/prisma');

const verifyAdminToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.uid },
      select: { id: true, role: true, fullName: true, email: true, accountStatus: true, tokenVersion: true },
    });

    if (!user || user.role !== 'admin' || user.accountStatus === 'deleted') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Token revoked' });
    }

    req.admin = { uid: user.id, role: user.role, fullName: user.fullName, email: user.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
};

module.exports = { verifyAdminToken, allowRoles };