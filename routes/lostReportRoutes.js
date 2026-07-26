const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const verifyToken = require('../middleware/verifyToken');
const { post, feed, markFound, deleteReport } = require('../controllers/lostReportController');

router.post('/post', verifyToken, post);
router.get('/feed', verifyToken, feed);
router.patch('/:id/found', verifyToken, markFound);
router.delete('/:id', verifyToken, deleteReport);

router.get('/feed/hash', verifyToken, async (req, res) => {
  try {
    const [count, latestUpdated, latestPosted] = await Promise.all([
      prisma.lostReport.count(),
      prisma.lostReport.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      prisma.lostReport.findFirst({ orderBy: { postedAt: 'desc' }, select: { postedAt: true } }),
    ]);
    const latest = Math.max(
      latestUpdated?.updatedAt?.getTime() ?? 0,
      latestPosted?.postedAt?.getTime() ?? 0,
    );
    res.json({ hash: `${count}_${latest}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;