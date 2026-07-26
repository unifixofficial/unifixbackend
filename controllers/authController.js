const argon2 = require('argon2');
const prisma = require('../config/prisma');
const { generateOTP, storeOTP, verifyOTP, deleteOTP } = require('../utils/otpUtils');
const { signAccessToken, signRefreshToken, getRefreshExpiry } = require('../utils/jwt');
const { sendOTPEmail } = require('../services/emailService');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../services/logger');
const { sendPushNotification, getTokensByRole } = require('../services/notificationService');

const signup = async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body;
    const validRoles = ['student', 'teacher', 'staff'];
    if (!validRoles.includes(role)) return sendError(res, 'Invalid role', 400);

    const emailDomain = email.split('@')[1];
    if (role !== 'staff' && emailDomain !== 'vcet.edu.in') {
      return sendError(res, 'Invalid college email', 400);
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return sendError(res, 'Email already exists', 400);

    const otp = generateOTP();
    await storeOTP(email, otp, 'email-verification');

    try {
      await sendOTPEmail(email, otp, fullName, 'email-verification');
    } catch {
      return sendError(res, 'Failed to send OTP email. Please try again.', 500);
    }

    logger.info('[Auth] OTP sent for signup', { email });
    sendSuccess(res, { message: 'OTP sent to your email', email });
  } catch (error) {
    logger.error('[Auth] signup failed', { error: error.message });
    sendError(res, error.message);
  }
};

const verifyOtp = async (req, res) => {
  try {
    const { email, otp, fullName, password, role } = req.body;
    const isValid = await verifyOTP(email, otp, 'email-verification');
    if (!isValid) return sendError(res, 'Invalid or expired OTP', 400);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return sendError(res, 'Email already registered', 400);

    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: {
        email,
        fullName,
        role,
        passwordHash,
        isVerified: true,
        profileCompleted: false,
      },
    });

    const tokenPayload = { uid: user.id, role: user.role, tokenVersion: user.tokenVersion };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken({ uid: user.id });

    await prisma.refreshToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt: getRefreshExpiry() },
    });

    sendSuccess(res, { message: 'Email verified successfully', uid: user.id, token: accessToken, refreshToken });
  } catch (error) {
    sendError(res, error.message);
  }
};

const resendOtp = async (req, res) => {
  try {
    const { email, fullName, type } = req.body;
    const otpType = type || 'email-verification';
    if (!email || !fullName) return sendError(res, 'Email and fullName required', 400);

    const otp = generateOTP();
    await storeOTP(email, otp, otpType);

    try {
      await sendOTPEmail(email, otp, fullName, otpType);
    } catch {
      return sendError(res, 'Failed to send OTP email. Please try again.', 500);
    }

    sendSuccess(res, { message: 'OTP resent to your email' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 'Email required', 400);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return sendError(res, 'No account found with this email', 400);

    const otp = generateOTP();
    await storeOTP(email, otp, 'password-reset');

    try {
      await sendOTPEmail(email, otp, user.fullName || 'User', 'password-reset');
    } catch {
      return sendError(res, 'Failed to send OTP email. Please try again.', 500);
    }

    sendSuccess(res, { message: 'OTP sent to your email for password reset' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const verifyResetOtp = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return sendError(res, 'Missing required fields', 400);
    if (newPassword.length < 6) return sendError(res, 'Password must be at least 6 characters', 400);

    const isValid = await verifyOTP(email, otp, 'password-reset');
    if (!isValid) return sendError(res, 'Invalid or expired OTP', 400);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return sendError(res, 'User not found', 400);

    const passwordHash = await argon2.hash(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    });

    sendSuccess(res, { message: 'Password reset successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const validateResetOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return sendError(res, 'Missing required fields', 400);

    const isValid = await verifyOTP(email, otp, 'password-reset');
    if (!isValid) return sendError(res, 'Invalid or expired OTP', 400);

    await storeOTP(email, otp, 'password-reset');

    sendSuccess(res, { message: 'OTP is valid' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return sendError(res, 'Invalid email or password', 400);
    if (!user.isVerified) return sendError(res, 'Email not verified', 400);
    if (user.accountStatus === 'suspended') return sendError(res, 'Account suspended', 403);
    if (user.accountStatus === 'deleted') return sendError(res, 'Account not found', 400);

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return sendError(res, 'Invalid email or password', 400);

    const tokenPayload = { uid: user.id, role: user.role, tokenVersion: user.tokenVersion };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken({ uid: user.id });

    await prisma.$transaction([
      prisma.refreshToken.create({
        data: { userId: user.id, token: refreshToken, expiresAt: getRefreshExpiry() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      }),
    ]);

    logger.info('[Auth] Login successful', { uid: user.id, role: user.role });
    sendSuccess(res, {
      message: 'Login successful',
      uid: user.id,
      token: accessToken,
      refreshToken,
      user: {
        uid: user.id,
        fullName: user.fullName || '',
        email: user.email,
        role: user.role,
        profileCompleted: user.profileCompleted || false,
        verificationStatus: user.verificationStatus || null,
      },
    });
  } catch (error) {
    logger.error('[Auth] login failed', { error: error.message });
    sendError(res, error.message);
  }
};

const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return sendError(res, 'Refresh token required', 400);

    const { verifyRefreshToken } = require('../utils/jwt');
    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch {
      return sendError(res, 'Invalid or expired refresh token', 401);
    }

    const stored = await prisma.refreshToken.findUnique({ where: { token } });
    if (!stored || stored.revoked || new Date() > stored.expiresAt) {
      return sendError(res, 'Refresh token invalid or expired', 401);
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.uid } });
    if (!user || user.accountStatus === 'deleted') {
      return sendError(res, 'User not found', 401);
    }

    const newAccessToken = signAccessToken({ uid: user.id, role: user.role, tokenVersion: user.tokenVersion });
    const newRefreshToken = signRefreshToken({ uid: user.id });

    await prisma.$transaction([
      prisma.refreshToken.update({ where: { token }, data: { revoked: true } }),
      prisma.refreshToken.create({
        data: { userId: user.id, token: newRefreshToken, expiresAt: getRefreshExpiry() },
      }),
    ]);

    sendSuccess(res, { token: newAccessToken, refreshToken: newRefreshToken });
  } catch (error) {
    sendError(res, error.message);
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const uid = req.user?.uid;

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);

    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) return sendError(res, 'Current password is incorrect', 400);

    const passwordHash = await argon2.hash(newPassword);
    await prisma.user.update({
      where: { id: uid },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    await prisma.refreshToken.updateMany({
      where: { userId: uid },
      data: { revoked: true },
    });

    sendSuccess(res, { message: 'Password changed successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const updateProfile = async (req, res) => {
  try {
    const { fullName, phone } = req.body;
    const uid = req.user?.uid;
    if (!fullName || !fullName.trim()) return sendError(res, 'Full name is required', 400);
    const updateData = { fullName: fullName.trim() };
    if (phone !== undefined) updateData.phone = phone.trim();
    await prisma.user.update({ where: { id: uid }, data: updateData });
    sendSuccess(res, { message: 'Profile updated successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const completeProfile = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const {
      phone, gender, profileCompleted,
      year, branch, rollNumber, studentIdCardUrl, studentIdCardName,
      department, teacherId, teacherIdCardUrl, teacherIdCardName,
      employeeId, designation, experience, idCardUrl, idCardName,
      certificateUrl, certificateName, verificationStatus, rejectionMessage,
      photoUrl,
    } = req.body;

    const updateData = {};
    if (phone !== undefined) updateData.phone = phone;
    if (gender !== undefined) updateData.gender = gender;
    if (profileCompleted !== undefined) updateData.profileCompleted = profileCompleted;
    if (year !== undefined) updateData.year = year;
    if (branch !== undefined) updateData.branch = branch;
    if (rollNumber !== undefined) updateData.rollNumber = rollNumber;
    if (studentIdCardUrl !== undefined) updateData.studentIdCardUrl = studentIdCardUrl;
    if (studentIdCardName !== undefined) updateData.studentIdCardName = studentIdCardName;
    if (department !== undefined) updateData.department = department;
    if (teacherId !== undefined) updateData.teacherId = teacherId;
    if (teacherIdCardUrl !== undefined) updateData.teacherIdCardUrl = teacherIdCardUrl;
    if (teacherIdCardName !== undefined) updateData.teacherIdCardName = teacherIdCardName;
    if (employeeId !== undefined) updateData.employeeId = employeeId;
    if (designation !== undefined) updateData.designation = designation;
    if (experience !== undefined) updateData.experience = experience;
    if (idCardUrl !== undefined) updateData.idCardUrl = idCardUrl;
    if (idCardName !== undefined) updateData.idCardName = idCardName;
    if (certificateUrl !== undefined) updateData.certificateUrl = certificateUrl;
    if (certificateName !== undefined) updateData.certificateName = certificateName;
    if (verificationStatus !== undefined) updateData.verificationStatus = verificationStatus;
    if (rejectionMessage !== undefined) updateData.rejectionMessage = rejectionMessage;
    if (photoUrl !== undefined) updateData.photoUrl = photoUrl;

    await prisma.user.update({ where: { id: uid }, data: updateData });
    sendSuccess(res, { message: 'Profile completed successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const logoutAllDevices = async (req, res) => {
  try {
    const uid = req.user?.uid;
    await prisma.$transaction([
      prisma.user.update({ where: { id: uid }, data: { tokenVersion: { increment: 1 } } }),
      prisma.refreshToken.updateMany({ where: { userId: uid }, data: { revoked: true } }),
    ]);
    sendSuccess(res, { message: 'Logged out from all devices successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const deleteAccount = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);

    if (user.role === 'staff') {
      const existing = await prisma.deletionRequest.findFirst({
        where: { userId: uid, status: 'pending' },
      });
      if (existing) {
        return sendError(res, 'Deletion request already submitted and pending review', 400);
      }

      const delReq = await prisma.deletionRequest.create({
        data: {
          userId: uid,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          designation: user.designation || null,
        },
      });

      const adminTokens = await getTokensByRole(['admin']);
      await sendPushNotification(adminTokens, 'New Deletion Request', `${user.fullName} (staff) requested account deletion.`, {
        type: 'new_deletion_request',
        requestId: delReq.id,
      });

      return sendSuccess(res, {
        requiresApproval: true,
        message: 'Your account deletion request has been submitted and is currently under review.',
      });
    }

    await prisma.$transaction([
      prisma.deletionLog.create({
        data: { uid, email: user.email, fullName: user.fullName, role: user.role },
      }),
      prisma.user.update({ where: { id: uid }, data: { accountStatus: 'deleted' } }),
    ]);

    sendSuccess(res, { message: 'Account deleted successfully' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const reportSecurityIssue = async (req, res) => {
  try {
    const { issueType, description } = req.body;
    const uid = req.user?.uid;

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);

    const issue = await prisma.securityIssue.create({
      data: {
        userId: uid,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone || null,
        role: user.role,
        issueType,
        description: description.trim(),
      },
    });

    const adminTokens = await getTokensByRole(['admin']);
    await sendPushNotification(adminTokens, 'New Security Issue', `${user.fullName} reported: ${issueType}`, {
      type: 'new_security_issue',
      issueId: issue.id,
    });

    sendSuccess(res, { message: 'Security issue reported successfully. Our team will review it shortly.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const requestIdCardUpdate = async (req, res) => {
  try {
    const { newIdCardUrl, newIdCardName } = req.body;
    const uid = req.user?.uid;

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);
    if (user.role !== 'student' && user.role !== 'teacher') {
      return sendError(res, 'Only students and teachers can request ID card updates', 403);
    }

    const existing = await prisma.idCardRequest.findFirst({
      where: { userId: uid, status: 'pending' },
    });
    if (existing) return sendError(res, 'You already have a pending ID card update request', 400);

    const currentIdCardUrl = user.role === 'student' ? user.studentIdCardUrl : user.teacherIdCardUrl;

    const request = await prisma.idCardRequest.create({
      data: {
        userId: uid,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        newIdCardUrl,
        newIdCardName: newIdCardName || null,
        currentIdCardUrl: currentIdCardUrl || null,
      },
    });

    const adminTokens = await getTokensByRole(['admin']);
    await sendPushNotification(adminTokens, 'New ID Card Request', `${user.fullName} requested an ID card update.`, {
      type: 'new_idcard_request',
      requestId: request.id,
    });

    sendSuccess(res, { message: 'ID card update request submitted. Admin will review it shortly.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const myProfile = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        id: true, fullName: true, email: true, phone: true, role: true,
        gender: true, profileCompleted: true, verificationStatus: true,
        rejectionMessage: true, year: true, branch: true, rollNumber: true,
        studentIdCardUrl: true, studentIdCardName: true, department: true,
        teacherId: true, teacherIdCardUrl: true, teacherIdCardName: true,
        employeeId: true, designation: true, experience: true,
        avgRating: true, ratingCount: true, createdAt: true, lastLogin: true,
      },
    });
    if (!user) return sendError(res, 'User not found', 404);

    const pendingIdCard = await prisma.idCardRequest.findFirst({
      where: { userId: uid, status: 'pending' },
    });

    sendSuccess(res, { profile: user, hasPendingIdCardRequest: !!pendingIdCard });
  } catch (error) {
    sendError(res, error.message);
  }
};

const savePushToken = async (req, res) => {
  try {
    const { expoPushToken } = req.body;
    const uid = req.user?.uid;

    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) {
      return sendError(res, 'Invalid push token', 400);
    }

    await prisma.user.update({
      where: { id: uid },
      data: { expoPushToken, tokenUid: uid },
    });

    sendSuccess(res, { message: 'Push token saved successfully.' });
  } catch (error) {
    sendError(res, error.message);
  }
};

const reportRagging = async (req, res) => {
  try {
    const { incidentDate, incidentTime, location, description, bullyDescription, isAnonymous } = req.body;
    const uid = req.user?.uid;

    if (!incidentDate || !location || !description) {
      return sendError(res, 'Date, location and description are required.', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);
    if (user.role !== 'student') return sendError(res, 'Only students can report ragging.', 403);

    const reporterInfo = isAnonymous
      ? { name: 'Anonymous', email: 'Anonymous', rollNumber: 'Hidden', branch: 'Hidden', year: 'Hidden' }
      : {
          name: user.fullName || 'Unknown',
          email: user.email || 'Unknown',
          rollNumber: user.rollNumber || 'N/A',
          branch: user.branch || 'N/A',
          year: user.year || 'N/A',
        };

    const report = await prisma.raggingReport.create({
      data: {
        userId: isAnonymous ? null : uid,
        isAnonymous,
        reporterName: reporterInfo.name,
        reporterEmail: reporterInfo.email,
        reporterRollNumber: reporterInfo.rollNumber,
        reporterBranch: reporterInfo.branch,
        reporterYear: reporterInfo.year,
        incidentDate,
        incidentTime: incidentTime || 'Not specified',
        location,
        description: description.trim(),
        bullyDescription: bullyDescription?.trim() || 'Not provided',
      },
    });

    const { sendRaggingReportEmail } = require('../services/emailService');
    await sendRaggingReportEmail(process.env.HOD_EMAIL, {
      reportId: report.id,
      isAnonymous,
      reporter: reporterInfo,
      incidentDate,
      incidentTime: incidentTime || 'Not specified',
      location,
      description: description.trim(),
      bullyDescription: bullyDescription?.trim() || 'Not provided',
    });

    logger.info('[Auth] Ragging report submitted', { uid, isAnonymous });
    sendSuccess(res, { message: 'Ragging report submitted successfully. HOD has been notified.' });
  } catch (error) {
    logger.error('[Auth] reportRagging failed', { error: error.message });
    sendError(res, error.message);
  }
};

const notifyStaffSignup = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return sendError(res, 'User not found', 404);
    if (user.role !== 'staff') return sendSuccess(res, { message: 'Not staff, skipped' });

    const adminTokens = await getTokensByRole(['admin']);
    await sendPushNotification(adminTokens, 'New Staff Signup', `${user.fullName} has registered and needs approval.`, {
      type: 'new_staff_signup',
    });

    sendSuccess(res, { message: 'Admins notified' });
  } catch (error) {
    sendError(res, error.message);
  }
};

module.exports = {
  signup,
  verifyOtp,
  completeProfile,
  resendOtp,
  forgotPassword,
  verifyResetOtp,
  validateResetOtp,
  login,
  refreshToken,
  changePassword,
  updateProfile,
  logoutAllDevices,
  deleteAccount,
  reportSecurityIssue,
  requestIdCardUpdate,
  myProfile,
  savePushToken,
  reportRagging,
  notifyStaffSignup,
};