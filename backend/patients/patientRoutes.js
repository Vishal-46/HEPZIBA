const express = require('express');
const router = express.Router();
const ctrl = require('./patientController');
const roleAuth = require('../middleware/roleAuth');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// All endpoints here require a valid JWT
router.get('/me', roleAuth('patient'), ctrl.getMe);
router.put('/me', roleAuth('patient'), [
    body('address').optional().trim(),
    body('contact').optional().trim()
], validate, ctrl.updateMe);

// Admin & Doctor endpoints
router.get('/', roleAuth(['admin', 'doctor']), ctrl.listPatients);
router.post('/walkin', roleAuth('admin'), ctrl.registerWalkin);
router.get('/:id', roleAuth(['admin', 'doctor']), ctrl.getPatientById);
router.put('/:id', roleAuth('admin'), ctrl.updatePatientById);

module.exports = router;

