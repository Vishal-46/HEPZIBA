const express = require('express');
const router = express.Router();
const ctrl = require('./appointmentController');
const roleAuth = require('../middleware/roleAuth');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// Booking endpoint (patients self-book, or admin/doctor book on behalf of patient)
router.post('/', roleAuth(['patient', 'admin', 'doctor']), [
    body('patient_id').optional().isInt({ min: 1 }).withMessage('patient_id must be an integer'),
    body('doctor_id').optional().isInt({ min: 1 }).withMessage('doctor_id must be an integer'),
    body('scheduled_at').optional().isISO8601().withMessage('scheduled_at must be ISO8601'),
    body('date_time').optional().isISO8601().withMessage('date_time must be ISO8601'),
    body('reason').optional().trim(),
    body('notes').optional().trim()
], validate, ctrl.createAppointment);
router.get('/my', roleAuth('patient'), ctrl.getMyAppointments);
router.get('/catalog/doctors', roleAuth('patient'), ctrl.listDoctorsForPatients);
// Doctor endpoint (must be before /:id or "for-me" matches as an id)
router.get('/for-me', roleAuth('doctor'), ctrl.getForMe);
// Patient ownership: view / cancel own appointment
router.get('/:id', roleAuth('patient'), ctrl.getMyAppointmentById);
router.patch('/:id', roleAuth('patient'), ctrl.cancelMyAppointment);

module.exports = router;
