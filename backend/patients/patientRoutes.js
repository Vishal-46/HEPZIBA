const express = require('express');
const router = express.Router();
const ctrl = require('./patientController');
const roleAuth = require('../middleware/roleAuth');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// All endpoints here require a valid JWT
router.get('/me', roleAuth('patient'), ctrl.getMe);
// Push tokens belong to the authenticated account, whatever its role:
// patients, doctors and admins all receive policy notifications.
router.post('/push-token', roleAuth(['patient', 'doctor', 'admin']), ctrl.savePushToken);
router.delete('/push-token', roleAuth(['patient', 'doctor', 'admin']), ctrl.removePushToken);
router.post('/test-push', roleAuth(['patient', 'doctor', 'admin']), ctrl.testPush);
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

