const admin = require('../config/firebase');
const axios = require('axios');
const { sendRejectionEmail, sendIdCardRejectionEmail } = require('../services/emailService');
const { sendSuccess, sendError } = require('../utils/response');
const { createAuditLog } = require('../services/auditLogService');
const logger = require('../services/logger');
const crypto = require('crypto');

function computeHash(docs) {
  const str = docs.map(d => `${d.id}:${d.updatedAt?._seconds || d.createdAt?._seconds || 0}`).join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

async function getRedisHash(redis, key) {
  const val = await redis.get(`hash:${key}`);
  return val || null;
}

async function setRedisHash(redis, key, hash) {
  await redis.set(`hash:${key}`, hash, 'EX', 86400);
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return sendError(res, 'Email and password required', 400);

    let signInData;
    try {
      const signInRes = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
        { email, password, returnSecureToken: true }
      );
      signInData = signInRes.data;
    } catch (firebaseError) {
      const code = firebaseError.response?.data?.error?.message || '';
      logger.error('[Admin] Firebase auth failed', { code, full: firebaseError.response?.data });
      if (code.includes('TOO_MANY_ATTEMPTS')) {
        return sendError(res, 'Too many attempts. Please try again later.', 400);
      }
      return sendError(res, 'Invalid admin credentials', 401);
    }

    const userRecord = await admin.auth().getUserByEmail(email);
    const userDoc = await admin.firestore().collection('users').doc(userRecord.uid).get();

    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      return sendError(res, 'Invalid admin credentials', 401);
    }

    const idTokenResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
      { email, password, returnSecureToken: true }
    );
    const token = idTokenResponse.data.idToken;
    sendSuccess(res, { token });
  } catch (error) {
    logger.error('[Admin] login failed', { error: error.message });
    sendError(res, error.message);
  }
};

const getPendingStaff = async (req, res) => {
  try {
    const snapshot = await admin.firestore()
      .collection('users')
      .where('role', '==', 'staff')
      .where('verificationStatus', '==', 'pending')
      .get();
    const staff = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    sendSuccess(res, { staff });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllStaff = async (req, res) => {
  try {
    const redis = require('../config/redis');
    const clientHash = req.headers['x-client-hash'] || null;

    if (clientHash) {
      const redisHash = await getRedisHash(redis, 'staff');
      if (redisHash && redisHash === clientHash) {
        return sendSuccess(res, { staff: [], hash: clientHash, delta: true });
      }
    }

    const snapshot = await admin.firestore().collection('users').where('role', '==', 'staff').get();
    const staff = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const currentHash = computeHash(staff);

    if (clientHash && clientHash !== currentHash) {
      const cachedRaw = await redis.get('snapshot:staff');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const cachedMap = new Map(cached.map(s => [s.id, s]));
      const currentMap = new Map(staff.map(s => [s.id, s]));
      const changed = staff.filter(s => {
        const old = cachedMap.get(s.id);
        if (!old) return true;
        const oldSec = old.updatedAt?._seconds || old.createdAt?._seconds || 0;
        const newSec = s.updatedAt?._seconds || s.createdAt?._seconds || 0;
        return newSec !== oldSec;
      });
      const deletedIds = cached.filter(s => !currentMap.has(s.id)).map(s => s.id);
      await redis.set('snapshot:staff', JSON.stringify(staff), 'EX', 3600);
      await setRedisHash(redis, 'staff', currentHash);
      return sendSuccess(res, { staff: changed, deletedIds, hash: currentHash, delta: true });
    }

    await redis.set('snapshot:staff', JSON.stringify(staff), 'EX', 3600);
    await setRedisHash(redis, 'staff', currentHash);
    sendSuccess(res, { staff, hash: currentHash, delta: false });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getStaffById = async (req, res) => {
  try {
    const { uid } = req.params;
    const docSnap = await admin.firestore().collection('users').doc(uid).get();
    if (!docSnap.exists) return sendError(res, 'Staff not found', 404);
    sendSuccess(res, { staff: { id: docSnap.id, ...docSnap.data() } });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveStaff = async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return sendError(res, 'UID required', 400);
    const docSnap = await admin.firestore().collection('users').doc(uid).get();
    if (!docSnap.exists) return sendError(res, 'Staff not found', 404);
    await admin.firestore().collection('users').doc(uid).update({
      verificationStatus: 'approved',
      rejectionMessage: null,
      approvedAt: admin.firestore.Timestamp.now(),
    });
    try { const redis = require('../config/redis'); await redis.del('hash:staff'); await redis.del('hash:users'); } catch {}
    await createAuditLog({
      action: 'staff_approved',
      performedBy: 'admin',
      performedByRole: 'admin',
      targetId: uid,
      targetType: 'user',
    });
    logger.info('[Admin] Staff approved', { uid });
    sendSuccess(res, { message: 'Staff approved successfully' });
  } catch (error) {
    logger.error('[Admin] approveStaff failed', { error: error.message });
    sendError(res, error.message);
  }
};

const rejectStaff = async (req, res) => {
  try {
    const { uid, rejectionMessage } = req.body;
    if (!uid || !rejectionMessage) return sendError(res, 'UID and rejection message required', 400);
    const docSnap = await admin.firestore().collection('users').doc(uid).get();
    if (!docSnap.exists) return sendError(res, 'Staff not found', 404);
    const staffData = docSnap.data();
    await admin.firestore().collection('users').doc(uid).update({
      verificationStatus: 'rejected',
      rejectionMessage: rejectionMessage.trim(),
      profileCompleted: false,
      rejectedAt: admin.firestore.Timestamp.now(),
    });
    try { const redis = require('../config/redis'); await redis.del('hash:staff'); await redis.del('hash:users'); } catch {}
    try { await sendRejectionEmail(staffData.email, staffData.fullName, rejectionMessage.trim()); } catch {}
    await createAuditLog({
      action: 'staff_rejected',
      performedBy: 'admin',
      performedByRole: 'admin',
      targetId: uid,
      targetType: 'user',
      metadata: { rejectionMessage: rejectionMessage.trim() },
    });
    logger.info('[Admin] Staff rejected', { uid });
    sendSuccess(res, { message: 'Staff rejected and notified' });
  } catch (error) {
    logger.error('[Admin] rejectStaff failed', { error: error.message });
    sendError(res, error.message);
  }
};

const getStats = async (req, res) => {
  try {
    const [pendingSnap, approvedSnap, rejectedSnap, studentSnap, teacherSnap, complaintsSnap, idCardSnap, deletionSnap, securitySnap] =
      await Promise.all([
        admin.firestore().collection('users').where('role', '==', 'staff').where('verificationStatus', '==', 'pending').get(),
        admin.firestore().collection('users').where('role', '==', 'staff').where('verificationStatus', '==', 'approved').get(),
        admin.firestore().collection('users').where('role', '==', 'staff').where('verificationStatus', '==', 'rejected').get(),
        admin.firestore().collection('users').where('role', '==', 'student').get(),
        admin.firestore().collection('users').where('role', '==', 'teacher').get(),
        admin.firestore().collection('complaints').get(),
        admin.firestore().collection('idCardRequests').where('status', '==', 'pending').get(),
        admin.firestore().collection('deletionRequests').where('status', '==', 'pending').get(),
        admin.firestore().collection('securityIssues').where('status', '==', 'open').get(),
      ]);

    const complaints = complaintsSnap.docs.map(d => d.data());
    const complaintStats = {
      total: complaints.length,
      pending: complaints.filter(c => c.status === 'pending').length,
      assigned: complaints.filter(c => c.status === 'assigned').length,
      in_progress: complaints.filter(c => c.status === 'in_progress').length,
      completed: complaints.filter(c => c.status === 'completed').length,
      rejected: complaints.filter(c => c.status === 'rejected').length,
    };

    sendSuccess(res, {
      stats: {
        pending: pendingSnap.size,
        approved: approvedSnap.size,
        rejected: rejectedSnap.size,
        total: pendingSnap.size + approvedSnap.size + rejectedSnap.size,
        students: studentSnap.size,
        teachers: teacherSnap.size,
        complaints: complaintStats,
        pendingIdCardRequests: idCardSnap.size,
        pendingDeletionRequests: deletionSnap.size,
        openSecurityIssues: securitySnap.size,
      },
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllComplaints = async (req, res) => {
  try {
    const redis = require('../config/redis');
    const clientHash = req.headers['x-client-hash'] || null;

    if (clientHash) {
      const redisHash = await getRedisHash(redis, 'complaints');
      if (redisHash && redisHash === clientHash) {
        return sendSuccess(res, { complaints: [], hash: clientHash, delta: true });
      }
    }

    const snapshot = await admin.firestore().collection('complaints').orderBy('createdAt', 'desc').get();
    const complaints = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const currentHash = computeHash(complaints);

    if (clientHash && clientHash !== currentHash) {
      const cachedRaw = await redis.get('snapshot:complaints');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const cachedMap = new Map(cached.map(c => [c.id, c]));
      const currentMap = new Map(complaints.map(c => [c.id, c]));
      const changed = complaints.filter(c => {
        const old = cachedMap.get(c.id);
        if (!old) return true;
        const oldSec = old.updatedAt?._seconds || old.createdAt?._seconds || 0;
        const newSec = c.updatedAt?._seconds || c.createdAt?._seconds || 0;
        return newSec !== oldSec;
      });
      const deletedIds = cached.filter(c => !currentMap.has(c.id)).map(c => c.id);
      await redis.set('snapshot:complaints', JSON.stringify(complaints), 'EX', 3600);
      await setRedisHash(redis, 'complaints', currentHash);
      return sendSuccess(res, { complaints: changed, deletedIds, hash: currentHash, delta: true });
    }

    await redis.set('snapshot:complaints', JSON.stringify(complaints), 'EX', 3600);
    await setRedisHash(redis, 'complaints', currentHash);
    sendSuccess(res, { complaints, hash: currentHash, delta: false });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllUsers = async (req, res) => {
  try {
    const redis = require('../config/redis');
    const clientHash = req.headers['x-client-hash'] || null;

    if (clientHash) {
      const redisHash = await getRedisHash(redis, 'users');
      if (redisHash && redisHash === clientHash) {
        return sendSuccess(res, { users: [], hash: clientHash, delta: true });
      }
    }

    const snapshot = await admin.firestore().collection('users').get();
    const users = snapshot.docs.map(doc => {
      const { idCardBase64, certificateBase64, ...rest } = doc.data();
      return { id: doc.id, ...rest };
    });
    const currentHash = computeHash(users);

    if (clientHash && clientHash !== currentHash) {
      const cachedRaw = await redis.get('snapshot:users');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const cachedMap = new Map(cached.map(u => [u.id, u]));
      const currentMap = new Map(users.map(u => [u.id, u]));
      const changed = users.filter(u => {
        const old = cachedMap.get(u.id);
        if (!old) return true;
        const oldSec = old.updatedAt?._seconds || old.createdAt?._seconds || 0;
        const newSec = u.updatedAt?._seconds || u.createdAt?._seconds || 0;
        return newSec !== oldSec;
      });
      const deletedIds = cached.filter(u => !currentMap.has(u.id)).map(u => u.id);
      await redis.set('snapshot:users', JSON.stringify(users), 'EX', 3600);
      await setRedisHash(redis, 'users', currentHash);
      return sendSuccess(res, { users: changed, deletedIds, hash: currentHash, delta: true });
    }

    await redis.set('snapshot:users', JSON.stringify(users), 'EX', 3600);
    await setRedisHash(redis, 'users', currentHash);
    sendSuccess(res, { users, hash: currentHash, delta: false });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getUserIdCard = async (req, res) => {
  try {
    const { uid } = req.params;
    const docSnap = await admin.firestore().collection('users').doc(uid).get();
    if (!docSnap.exists) return sendError(res, 'User not found', 404);
    const data = docSnap.data();
    sendSuccess(res, {
      idCard: {
        role: data.role,
        fullName: data.fullName,
        studentIdCardUrl: data.studentIdCardUrl || null,
        studentIdCardName: data.studentIdCardName || null,
        teacherIdCardUrl: data.teacherIdCardUrl || null,
        teacherIdCardName: data.teacherIdCardName || null,
      },
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getIdCardRequests = async (req, res) => {
  try {
    const snapshot = await admin.firestore().collection('idCardRequests').orderBy('requestedAt', 'desc').get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    sendSuccess(res, { requests });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveIdCard = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);
    const reqDoc = await admin.firestore().collection('idCardRequests').doc(requestId).get();
    if (!reqDoc.exists) return sendError(res, 'Request not found', 404);
    const reqData = reqDoc.data();
    if (reqData.status !== 'pending') return sendError(res, 'Request already processed', 400);
    const updateField = reqData.role === 'student' ? 'studentIdCardUrl' : 'teacherIdCardUrl';
    const updateNameField = reqData.role === 'student' ? 'studentIdCardName' : 'teacherIdCardName';
    await admin.firestore().collection('users').doc(reqData.uid).update({
      [updateField]: reqData.newIdCardUrl,
      [updateNameField]: reqData.newIdCardName || null,
      idCardUpdatedAt: admin.firestore.Timestamp.now(),
    });
    await admin.firestore().collection('idCardRequests').doc(requestId).update({
      status: 'approved',
      processedAt: admin.firestore.Timestamp.now(),
    });
    try { const redis = require('../config/redis'); await redis.del('hash:users'); } catch {}
    sendSuccess(res, { message: 'ID card approved and updated successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const rejectIdCard = async (req, res) => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);
    const reqDoc = await admin.firestore().collection('idCardRequests').doc(requestId).get();
    if (!reqDoc.exists) return sendError(res, 'Request not found', 404);
    const reqData = reqDoc.data();
    if (reqData.status !== 'pending') return sendError(res, 'Request already processed', 400);
    await admin.firestore().collection('idCardRequests').doc(requestId).update({
      status: 'rejected',
      rejectionReason: reason || 'Not specified',
      processedAt: admin.firestore.Timestamp.now(),
    });
    try { await sendIdCardRejectionEmail(reqData.email, reqData.fullName, reason || 'Not specified'); } catch {}
    sendSuccess(res, { message: 'ID card request rejected' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getDeletionRequests = async (req, res) => {
  try {
    const [staffPending, deletionLogs] = await Promise.all([
      admin.firestore().collection('deletionRequests').orderBy('requestedAt', 'desc').get(),
      admin.firestore().collection('deletionLogs').orderBy('deletedAt', 'desc').limit(50).get(),
    ]);
    sendSuccess(res, {
      staffRequests: staffPending.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      userDeletions: deletionLogs.docs.map(doc => ({ id: doc.id, ...doc.data() })),
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

const approveDeletion = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);
    const reqDoc = await admin.firestore().collection('deletionRequests').doc(requestId).get();
    if (!reqDoc.exists) return sendError(res, 'Request not found', 404);
    const reqData = reqDoc.data();
    if (reqData.status !== 'pending') return sendError(res, 'Request already processed', 400);
    await admin.firestore().collection('deletionRequests').doc(requestId).update({
      status: 'approved',
      processedAt: admin.firestore.Timestamp.now(),
    });
    await admin.firestore().collection('users').doc(reqData.uid).delete();
    try { await admin.auth().deleteUser(reqData.uid); } catch {}
    try { const redis = require('../config/redis'); await redis.del('hash:users'); await redis.del('hash:staff'); } catch {}
    sendSuccess(res, { message: 'Staff account deleted successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const rejectDeletion = async (req, res) => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) return sendError(res, 'Request ID required', 400);
    const reqDoc = await admin.firestore().collection('deletionRequests').doc(requestId).get();
    if (!reqDoc.exists) return sendError(res, 'Request not found', 404);
    const reqData = reqDoc.data();
    if (reqData.status !== 'pending') return sendError(res, 'Request already processed', 400);
    await admin.firestore().collection('deletionRequests').doc(requestId).update({
      status: 'rejected',
      rejectionReason: reason || 'Not specified',
      processedAt: admin.firestore.Timestamp.now(),
    });
    await admin.firestore().collection('users').doc(reqData.uid).update({
      deletionRequestStatus: 'rejected',
      deletionRejectionReason: reason || 'Not specified',
    });
    sendSuccess(res, { message: 'Deletion request rejected' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getSecurityIssues = async (req, res) => {
  try {
    const snapshot = await admin.firestore().collection('securityIssues').orderBy('reportedAt', 'desc').get();
    const issues = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    sendSuccess(res, { issues });
  } catch (error) {
    sendError(res, error.message);
  }
};

const resolveSecurityIssue = async (req, res) => {
  try {
    const { issueId, resolution } = req.body;
    if (!issueId) return sendError(res, 'Issue ID required', 400);
    const issueDoc = await admin.firestore().collection('securityIssues').doc(issueId).get();
    if (!issueDoc.exists) return sendError(res, 'Issue not found', 404);
    await admin.firestore().collection('securityIssues').doc(issueId).update({
      status: 'resolved',
      resolution: resolution || 'Resolved by admin',
      resolvedAt: admin.firestore.Timestamp.now(),
    });
    sendSuccess(res, { message: 'Security issue resolved' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllLostFound = async (req, res) => {
  try {
    const redis = require('../config/redis');
    const clientHash = req.headers['x-client-hash'] || null;

    if (clientHash) {
      const redisHash = await getRedisHash(redis, 'lostFound');
      if (redisHash && redisHash === clientHash) {
        return sendSuccess(res, { items: [], hash: clientHash, delta: true });
      }
    }

    const snapshot = await admin.firestore().collection('lostFound').orderBy('createdAt', 'desc').get();
    const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const currentHash = computeHash(items);

    if (clientHash && clientHash !== currentHash) {
      const cachedRaw = await redis.get('snapshot:lostFound');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const cachedMap = new Map(cached.map(i => [i.id, i]));
      const currentMap = new Map(items.map(i => [i.id, i]));
      const changed = items.filter(i => {
        const old = cachedMap.get(i.id);
        if (!old) return true;
        const oldSec = old.updatedAt?._seconds || old.createdAt?._seconds || 0;
        const newSec = i.updatedAt?._seconds || i.createdAt?._seconds || 0;
        return newSec !== oldSec;
      });
      const deletedIds = cached.filter(i => !currentMap.has(i.id)).map(i => i.id);
      await redis.set('snapshot:lostFound', JSON.stringify(items), 'EX', 3600);
      await setRedisHash(redis, 'lostFound', currentHash);
      return sendSuccess(res, { items: changed, deletedIds, hash: currentHash, delta: true });
    }

    await redis.set('snapshot:lostFound', JSON.stringify(items), 'EX', 3600);
    await setRedisHash(redis, 'lostFound', currentHash);
    sendSuccess(res, { items, hash: currentHash, delta: false });
  } catch (error) {
    sendError(res, error.message);
  }
};

const getAllLostReports = async (req, res) => {
  try {
    const redis = require('../config/redis');
    const clientHash = req.headers['x-client-hash'] || null;

    if (clientHash) {
      const redisHash = await getRedisHash(redis, 'lostReports');
      if (redisHash && redisHash === clientHash) {
        return sendSuccess(res, { reports: [], hash: clientHash, delta: true });
      }
    }

    const snap = await admin.firestore().collection('lost_reports').orderBy('postedAt', 'desc').get();
    const reports = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const currentHash = computeHash(reports);

    if (clientHash && clientHash !== currentHash) {
      const cachedRaw = await redis.get('snapshot:lostReports');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const cachedMap = new Map(cached.map(r => [r.id, r]));
      const currentMap = new Map(reports.map(r => [r.id, r]));
      const changed = reports.filter(r => {
        const old = cachedMap.get(r.id);
        if (!old) return true;
        const oldSec = old.updatedAt?._seconds || old.postedAt?._seconds || 0;
        const newSec = r.updatedAt?._seconds || r.postedAt?._seconds || 0;
        return newSec !== oldSec;
      });
      const deletedIds = cached.filter(r => !currentMap.has(r.id)).map(r => r.id);
      await redis.set('snapshot:lostReports', JSON.stringify(reports), 'EX', 3600);
      await setRedisHash(redis, 'lostReports', currentHash);
      return sendSuccess(res, { reports: changed, deletedIds, hash: currentHash, delta: true });
    }

    await redis.set('snapshot:lostReports', JSON.stringify(reports), 'EX', 3600);
    await setRedisHash(redis, 'lostReports', currentHash);
    sendSuccess(res, { reports, hash: currentHash, delta: false });
  } catch (error) {
    sendError(res, error.message);
  }
};

const iwillhandle = async (req, res) => {
  try {
    const { complaintId } = req.body;
    if (!complaintId) return sendError(res, 'Complaint ID required', 400);
    const ref = admin.firestore().collection('complaints').doc(complaintId);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 'Complaint not found', 404);
    const { cancelEscalation } = require('../services/schedulerService');
    cancelEscalation(complaintId);
    await ref.update({ adminHandling: true, adminHandledAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now() });
    try { const redis = require('../config/redis'); await redis.del('hash:complaints'); } catch {}
    const complaint = snap.data();
    if (complaint.submittedBy) {
      const studentSnap = await admin.firestore().collection('users').doc(complaint.submittedBy).get();
      const token = studentSnap.exists ? studentSnap.data().expoPushToken : null;
      if (token) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ to: token, title: 'Admin is handling your complaint', body: 'The admin has taken ownership of your complaint.', sound: 'default', data: { type: 'complaint_accepted', complaintId } }]),
        });
      }
    }
    await createAuditLog({
      action: 'admin_iwillhandle',
      performedBy: 'admin',
      performedByRole: 'admin',
      targetId: complaintId,
      targetType: 'complaint',
    });
    logger.info('[Admin] iwillhandle', { complaintId });
    sendSuccess(res, { message: 'Marked as admin handling' });
  } catch (error) {
    logger.error('[Admin] iwillhandle failed', { error: error.message });
    sendError(res, error.message);
  }
};

const markFlagResolved = async (req, res) => {
  try {
    const { complaintId } = req.body;
    if (!complaintId) return sendError(res, 'Complaint ID required', 400);
    const ref = admin.firestore().collection('complaints').doc(complaintId);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 'Complaint not found', 404);
    const resolvedAt = admin.firestore.Timestamp.now();
    await ref.update({
      status: 'completed',
      flagResolved: true,
      flagResolvedBy: 'admin',
      flagResolvedAt: resolvedAt,
      completedAt: resolvedAt,
      hodResolutionEmailSent: true,
      ratingDisabled: true,
      updatedAt: resolvedAt,
    });
    try { const redis = require('../config/redis'); await redis.del('hash:complaints'); } catch {}
    const complaint = { id: complaintId, ...snap.data(), flagResolvedAt: resolvedAt, flagResolvedBy: 'admin' };
    if (complaint.submittedBy) {
      const studentSnap = await admin.firestore().collection('users').doc(complaint.submittedBy).get();
      const token = studentSnap.exists ? studentSnap.data().expoPushToken : null;
      if (token) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ to: token, title: 'Complaint Resolved', body: 'Your complaint has been resolved by the admin.', sound: 'default', data: { type: 'complaint_completed', complaintId } }]),
        });
      }
    }
    try {
      const { sendHODResolutionEmail } = require('../controllers/escalationController');
      await sendHODResolutionEmail(complaint, 'admin');
    } catch (emailErr) {
      console.error('HOD resolution email failed:', emailErr.message);
    }
    await createAuditLog({
      action: 'admin_resolved_complaint',
      performedBy: 'admin',
      performedByRole: 'admin',
      targetId: complaintId,
      targetType: 'complaint',
    });
    logger.info('[Admin] markFlagResolved', { complaintId });
    sendSuccess(res, { message: 'Complaint marked as resolved' });
  } catch (error) {
    logger.error('[Admin] markFlagResolved failed', { error: error.message });
    sendError(res, error.message);
  }
};

module.exports = {
  login,
  getPendingStaff,
  getAllStaff,
  getStaffById,
  approveStaff,
  rejectStaff,
  getStats,
  getAllComplaints,
  getAllUsers,
  getUserIdCard,
  getIdCardRequests,
  approveIdCard,
  rejectIdCard,
  getDeletionRequests,
  approveDeletion,
  rejectDeletion,
  getSecurityIssues,
  resolveSecurityIssue,
  getAllLostFound,
  getAllLostReports,
  iwillhandle,
  markFlagResolved,
};