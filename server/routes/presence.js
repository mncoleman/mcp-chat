const express = require('express');
const router = express.Router();
const { getPresence } = require('../ws/index');

/**
 * GET /api/presence - Get all online users and their sessions
 */
router.get('/', (req, res) => {
  res.json(getPresence());
});

module.exports = router;
