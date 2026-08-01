const express = require('express');
const router = express.Router();
const ctrl = require('./patientController');
const roleAuth = require('../middleware/roleAuth');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// All endpoints here require a patient JWT
router.get('/me', roleAuth('patient'), ctrl.getMe);
router.put('/me', roleAuth('patient'), [
    body('address').optional().trim(),
    body('contact').optional().trim()
], validate, ctrl.updateMe);

module.exports = router;
