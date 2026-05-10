const express = require('express');
const router = express.Router();
const ctrl = require('./patientController');
const roleAuth = require('../middleware/roleAuth');

// All endpoints here require a patient JWT
router.get('/me', roleAuth('patient'), ctrl.getMe);
router.put('/me', roleAuth('patient'), ctrl.updateMe);

module.exports = router;
