const express = require('express');
const router = express.Router();
const ctrl = require('./appointmentController');
const roleAuth = require('../middleware/roleAuth');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// Patient endpoints
router.post('/', roleAuth('patient'), [
    body('doctor_id').isInt(),
    body('date_time').isISO8601(),
    body('reason').optional().trim()
], validate, ctrl.createAppointment);
router.get('/my', roleAuth('patient'), ctrl.getMyAppointments);
router.get('/catalog/doctors', roleAuth('patient'), ctrl.listDoctorsForPatients);
// Doctor endpoint
router.get('/for-me', roleAuth('doctor'), ctrl.getForMe);

module.exports = router;
