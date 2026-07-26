const prisma = require('../config/prisma');
const { sendSuccess, sendError } = require('../utils/response');

const getAnalytics = async (req, res) => {
  try {
    const [complaints, staffUsers] = await Promise.all([
      prisma.complaint.findMany({
        select: {
          id: true,
          category: true,
          status: true,
          flagged: true,
          createdAt: true,
          completedAt: true,
          assignedToId: true,
        },
      }),
      prisma.user.findMany({
        where: { role: 'staff', verificationStatus: 'approved' },
        select: {
          id: true,
          fullName: true,
          designation: true,
          avgRating: true,
          ratingCount: true,
        },
      }),
    ]);

    const total = complaints.length;

    const byCategory = {};
    complaints.forEach(c => {
      const cat = c.category || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    const completed = complaints.filter(c => c.status === 'completed' && c.createdAt && c.completedAt);
    let avgResolutionMinutes = null;
    if (completed.length > 0) {
      const totalMs = completed.reduce((sum, c) => {
        const start = c.createdAt instanceof Date ? c.createdAt.getTime() : null;
        const end = c.completedAt instanceof Date ? c.completedAt.getTime() : null;
        return start && end ? sum + (end - start) : sum;
      }, 0);
      avgResolutionMinutes = Math.round(totalMs / completed.length / 60000);
    }

    const flagged = complaints.filter(c => c.flagged);
    const escalationRate = total > 0 ? ((flagged.length / total) * 100).toFixed(1) : '0.0';

    const staffPerformance = staffUsers.map(s => ({
      uid: s.id,
      fullName: s.fullName || '',
      designation: s.designation || '',
      avgRating: s.avgRating || null,
      ratingCount: s.ratingCount || 0,
      completedComplaints: complaints.filter(c => c.assignedToId === s.id && c.status === 'completed').length,
    }));

    const statusBreakdown = {
      pending: complaints.filter(c => c.status === 'pending').length,
      assigned: complaints.filter(c => c.status === 'assigned').length,
      in_progress: complaints.filter(c => c.status === 'in_progress').length,
      completed: completed.length,
      rejected: complaints.filter(c => c.status === 'rejected').length,
    };

    sendSuccess(res, {
      total,
      byCategory,
      avgResolutionMinutes,
      escalationRate: `${escalationRate}%`,
      escalatedCount: flagged.length,
      statusBreakdown,
      staffPerformance,
    });
  } catch (error) {
    sendError(res, error.message);
  }
};

module.exports = { getAnalytics };