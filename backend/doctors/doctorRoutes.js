const express = require('express');
const router = express.Router();
const ctrl = require('./doctorController');
const roleAuth = require('../middleware/roleAuth');

// Profile endpoints
router.get('/me', roleAuth('doctor'), ctrl.getMe);
router.put('/me', roleAuth('doctor'), ctrl.updateMe);
// Appointment endpoints
router.get('/appointments/:id', roleAuth('doctor'), ctrl.getAppointment);
router.patch('/appointments/:id', roleAuth('doctor'), ctrl.updateAppointment);

module.exports = router;
