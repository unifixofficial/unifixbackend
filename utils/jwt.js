const jwt = require('jsonwebtoken');
const { jwtAccessSecret, jwtRefreshSecret, jwtAccessExpiresIn, jwtRefreshExpiresIn } = require('../config/env');

const signAccessToken = (payload) => {
  return jwt.sign(payload, jwtAccessSecret, { expiresIn: jwtAccessExpiresIn });
};

const signRefreshToken = (payload) => {
  return jwt.sign(payload, jwtRefreshSecret, { expiresIn: jwtRefreshExpiresIn });
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, jwtAccessSecret);
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, jwtRefreshSecret);
};

const getRefreshExpiry = () => {
  const ms = parseDuration(jwtRefreshExpiresIn);
  return new Date(Date.now() + ms);
};

const parseDuration = (str) => {
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 30 * 86400000;
  return parseInt(match[1]) * units[match[2]];
};

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, getRefreshExpiry };