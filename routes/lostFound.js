const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const verifyToken = require('../middleware/verifyToken');
const { postLostFoundValidator } = require('../validators/complaintValidator');
const { post, feed, handover, myPosts, claims, deletePost } = require('../controllers/lostFoundController');

router.post('/post', verifyToken, postLostFoundValidator, post);
router.get('/feed', verifyToken, feed);
router.post('/handover', verifyToken, handover);
router.get('/my-posts', verifyToken, myPosts);
router.get('/claims', verifyToken, claims);
router.delete('/:id', verifyToken, deletePost);

router.get('/feed/hash', verifyToken, async (req, res) => {
  try {
    const [count, latest] = await Promise.all([
      prisma.lostFound.count(),
      prisma.lostFound.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    const latestTs = latest?.updatedAt?.getTime() ?? 0;
    res.json({ hash: `${count}_${latestTs}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/claims/hash', verifyToken, async (req, res) => {
  try {
    const count = await prisma.claim.count();
    res.json({ hash: `${count}`, serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;