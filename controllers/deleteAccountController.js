const { BrevoClient } = require('@getbrevo/brevo');

const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });

exports.sendDeletionRequest = async (req, res) => {
  const { name, email, role, reason, feedback } = req.body;

  if (!name || !email || !role || !reason) {
    return res.status(400).json({
      success: false,
      message: 'Name, email, role and reason are required.'
    });
  }

  const roleLabels = {
    student: 'Student',
    teacher: 'Teacher',
    staff: 'Staff Member',
    other: 'Other'
  };

  try {
    // 1. Send email to ADMIN (you)
    await client.transactionalEmails.sendTransacEmail({
      sender: { name: 'UniFiX Account Deletion', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: process.env.HELPDESK_EMAIL }],
      replyTo: { email, name },
      subject: `[UniFiX] Account Deletion Request from ${email}`,
      htmlContent: `
        <h2>Account Deletion Request</h2>
        <hr />
        <h3>User Details:</h3>
        <ul>
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Role:</strong> ${roleLabels[role] || role}</li>
        </ul>
        <h3>Reason for Deletion:</h3>
        <ul>
          <li><strong>Reason:</strong> ${reason}</li>
        </ul>
        ${feedback ? `<h3>Additional Feedback:</h3><p>${feedback}</p>` : ''}
        <hr />
        <p><strong>Timestamp:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
        <p><strong>Action Required:</strong> Verify user identity before deletion.</p>
        <p><em>This request was submitted from the UniFiX Delete Account page.</em></p>
      `,
    });

    // 2. Send CONFIRMATION email to USER
    await client.transactionalEmails.sendTransacEmail({
      sender: { name: 'UniFiX Support', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: email }],
      subject: `[UniFiX] Account Deletion Request Received`,
      htmlContent: `
        <h2>Account Deletion Request Received</h2>
        <p>Dear ${name},</p>
        <p>We have received your request to delete your UniFiX account.</p>
        <h3>Request Summary:</h3>
        <ul>
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Role:</strong> ${roleLabels[role] || role}</li>
          <li><strong>Reason:</strong> ${reason}</li>
        </ul>
        <h3>What happens next?</h3>
        <ul>
          <li>Our team will review your request within 24-48 hours.</li>
          <li>We may contact you if we need any additional information.</li>
          <li>Once verified, your account will be permanently deleted.</li>
        </ul>
        <hr />
        <p><strong>Timestamp:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
        <p><strong>Request ID:</strong> DREQ-${Date.now().toString(36).toUpperCase()}</p>
        <hr />
        <p style="color: #94a3b8; font-size: 12px;">
          This is an automated confirmation. If you did not request this, please contact us immediately at ${process.env.HELPDESK_EMAIL}.
        </p>
        <p style="color: #94a3b8; font-size: 12px;">
          &copy; 2026 UniFiX. All rights reserved.
        </p>
      `,
    });

    res.status(200).json({
      success: true,
      message: 'Deletion request submitted successfully.'
    });

  } catch (err) {
    console.error('Brevo error:', err?.message || err);
    res.status(500).json({
      success: false,
      message: 'Failed to submit deletion request.'
    });
  }
};