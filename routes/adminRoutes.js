const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const crypto = require('crypto');
const { verifyAdminToken } = require('../middleware/roleMiddleware');
const { authLimiter } = require('../middleware/rateLimiter');
const {
  login, getPendingStaff, getAllStaff, getStaffById, approveStaff, rejectStaff,
  getStats, getAllComplaints, getAllUsers, getUserIdCard, getIdCardRequests,
  approveIdCard, rejectIdCard, getDeletionRequests, approveDeletion, rejectDeletion,
  getSecurityIssues, resolveSecurityIssue, getAllLostFound, iwillhandle, markFlagResolved,
} = require('../controllers/adminController');
const { checkEscalations } = require('../controllers/escalationController');

router.post('/login', authLimiter, login);

router.post('/check-escalations', (req, res, next) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}, checkEscalations);

router.get('/pending-staff', verifyAdminToken, getPendingStaff);
router.get('/all-staff', verifyAdminToken, getAllStaff);
router.get('/staff/:uid', verifyAdminToken, getStaffById);
router.post('/approve-staff', verifyAdminToken, approveStaff);
router.post('/reject-staff', verifyAdminToken, rejectStaff);
router.get('/stats', verifyAdminToken, getStats);

router.get('/all-complaints/hash', verifyAdminToken, async (req, res) => {
  try {
    const [count, latest] = await Promise.all([
      prisma.complaint.count(),
      prisma.complaint.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    const latestTs = latest?.updatedAt?.getTime() ?? 0;
    res.json({ hash: `${count}_${latestTs}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/all-complaints', verifyAdminToken, getAllComplaints);
router.get('/all-users', verifyAdminToken, getAllUsers);
router.get('/user/:uid/idcard', verifyAdminToken, getUserIdCard);
router.get('/idcard-requests', verifyAdminToken, getIdCardRequests);
router.post('/approve-idcard', verifyAdminToken, approveIdCard);
router.post('/reject-idcard', verifyAdminToken, rejectIdCard);
router.get('/deletion-requests', verifyAdminToken, getDeletionRequests);
router.post('/approve-deletion', verifyAdminToken, approveDeletion);
router.post('/reject-deletion', verifyAdminToken, rejectDeletion);
router.get('/security-issues', verifyAdminToken, getSecurityIssues);
router.post('/resolve-security-issue', verifyAdminToken, resolveSecurityIssue);
router.get('/all-lost-found', verifyAdminToken, getAllLostFound);
router.post('/iwillhandle', verifyAdminToken, iwillhandle);
router.post('/mark-flag-resolved', verifyAdminToken, markFlagResolved);

router.get('/all-lost-reports', verifyAdminToken, async (req, res) => {
  try {
    const reports = await prisma.lostReport.findMany({ orderBy: { postedAt: 'desc' } });
    return res.json({ success: true, reports });
  } catch (e) {
    return res.json({ success: false, message: e.message });
  }
});

router.get('/user/:uid', verifyAdminToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.uid },
      select: { fullName: true, email: true, phone: true, designation: true, employeeId: true },
    });
    if (!user) return res.json({ success: false, message: 'User not found' });
    return res.json({ success: true, user });
  } catch (e) {
    return res.json({ success: false, message: e.message });
  }
});

module.exports = router;