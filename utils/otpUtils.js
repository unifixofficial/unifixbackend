const prisma = require('../config/prisma');

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const storeOTP = async (email, otp, type) => {
  const otpType = type || 'email-verification';
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.otp.upsert({
    where: { email_type: { email, type: otpType } },
    update: {
      otp: String(otp),
      expiresAt,
      used: false,
      createdAt: new Date(),
    },
    create: {
      email,
      otp: String(otp),
      type: otpType,
      expiresAt,
    },
  });
};

const verifyOTP = async (email, otp, type) => {
  const otpType = type || 'email-verification';
  if (!email || !otp) return false;

  try {
    const record = await prisma.otp.findUnique({
      where: { email_type: { email, type: otpType } },
    });

    if (!record) return false;
    if (record.used) return false;
    if (String(record.otp).trim() !== String(otp).trim()) return false;
    if (new Date() > record.expiresAt) return false;

    await prisma.otp.delete({
      where: { email_type: { email, type: otpType } },
    });

    return true;
  } catch {
    return false;
  }
};

const deleteOTP = async (email, type) => {
  if (!email) return;
  try {
    const otpType = type || 'email-verification';
    await prisma.otp.deleteMany({ where: { email, type: otpType } });
  } catch {}
};

module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  deleteOTP,
};