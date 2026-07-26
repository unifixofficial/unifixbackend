const express = require('express');
const router = express.Router();
const { sendDeletionRequest } = require('../controllers/deleteAccountController');

router.post('/request', sendDeletionRequest);

module.exports = router;