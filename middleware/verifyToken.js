const { verifyAccessToken } = require('../utils/jwt');
const prisma = require('../config/prisma');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.uid },
      select: {
        id: true,
        email: true,
        role: true,
        fullName: true,
        verificationStatus: true,
        profileCompleted: true,
        accountStatus: true,
        tokenVersion: true,
      },
    });

    if (!user || user.accountStatus === 'deleted') {
      return res.status(401).json({ error: 'User not found' });
    }

    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Token revoked' });
    }

    req.user = {
      uid: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      verificationStatus: user.verificationStatus,
      profileCompleted: user.profileCompleted,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = verifyToken;