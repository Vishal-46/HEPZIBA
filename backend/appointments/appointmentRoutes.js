const express = require('express');
const router = express.Router();
const ctrl = require('./appointmentController');
const roleAuth = require('../middleware/roleAuth');

// Patient endpoints
router.post('/', roleAuth('patient'), ctrl.createAppointment);
router.get('/my', roleAuth('patient'), ctrl.getMyAppointments);
router.get('/catalog/doctors', roleAuth('patient'), ctrl.listDoctorsForPatients);
// Doctor endpoint
router.get('/for-me', roleAuth('doctor'), ctrl.getForMe);

module.exports = router;
