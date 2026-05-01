const { Resend } = require('resend');

module.exports = {
  getResend: () => new Resend(process.env.RESEND_API_KEY),
};