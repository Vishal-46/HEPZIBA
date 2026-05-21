const express = require('express');
const router = express.Router();
const ctrl = require('./prescriptionController');
const roleAuth = require('../middleware/roleAuth');

router.post('/', roleAuth('doctor'), ctrl.createPrescription);
router.get('/my', roleAuth('patient'), ctrl.getMyPrescriptions);
router.get('/appointment/:appointmentId', roleAuth(['doctor', 'patient']), ctrl.getByAppointment);

module.exports = router;
