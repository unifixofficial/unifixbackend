const errorHandler = (err, req, res, next) => {
  const status = err.status || 500;
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unhandled error:', err);
  } else {
    console.error('Unhandled error:', err.message);
  }
  const message = status < 500 ? (err.message || 'Request failed') : 'Internal server error';
  res.status(status).json({ error: message });
};

module.exports = errorHandler;