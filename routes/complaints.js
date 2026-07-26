const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const verifyToken = require('../middleware/verifyToken');
const { submitComplaintValidator, rateComplaintValidator } = require('../validators/complaintValidator');
const { submit, accept, updateStatus, reject, rate, myComplaints, staffComplaints, allComplaints } = require('../controllers/complaintController');

router.post('/submit', verifyToken, submitComplaintValidator, submit);
router.post('/accept', verifyToken, accept);
router.post('/update-status', verifyToken, updateStatus);
router.post('/reject', verifyToken, reject);
router.post('/rate', verifyToken, rateComplaintValidator, rate);
router.get('/my-complaints', verifyToken, myComplaints);

router.get('/my-complaints/hash', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const [count, latest] = await Promise.all([
      prisma.complaint.count({ where: { submittedById: uid } }),
      prisma.complaint.findFirst({ where: { submittedById: uid }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    const latestTs = latest?.updatedAt?.getTime() ?? 0;
    res.json({ hash: `${count}_${latestTs}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/staff-complaints', verifyToken, staffComplaints);

router.get('/staff-complaints/hash', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const [pendingLatest, assignedLatest, rejectedLatest, pc, ac, rc] = await Promise.all([
      prisma.complaint.findFirst({ where: { assignableTo: { has: uid }, status: 'pending' }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      prisma.complaint.findFirst({ where: { assignedToId: uid }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      prisma.complaint.findFirst({ where: { rejectedByUids: { has: uid } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      prisma.complaint.count({ where: { assignableTo: { has: uid }, status: 'pending' } }),
      prisma.complaint.count({ where: { assignedToId: uid } }),
      prisma.complaint.count({ where: { rejectedByUids: { has: uid } } }),
    ]);
    const latest = Math.max(
      pendingLatest?.updatedAt?.getTime() ?? 0,
      assignedLatest?.updatedAt?.getTime() ?? 0,
      rejectedLatest?.updatedAt?.getTime() ?? 0,
    );
    res.json({ hash: `${pc + ac + rc}_${latest}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/all', verifyToken, allComplaints);

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
    if (!complaint) return res.status(404).json({ error: 'Not found' });
    res.json(complaint);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;