const express = require('express');
const router = express.Router();
const ctrl = require('./adminController');
const roleAuth = require('../middleware/roleAuth');

router.get('/users', roleAuth('admin'), ctrl.listUsers);
router.get('/patients', roleAuth('admin'), ctrl.listPatients);
router.get('/users/:id', roleAuth('admin'), ctrl.getUser);
router.put('/users/:id', roleAuth('admin'), ctrl.updateUser);
router.delete('/users/:id', roleAuth('admin'), ctrl.deleteUser);
router.get('/appointments', roleAuth('admin'), ctrl.listAppointments);
router.patch('/appointments/:id', roleAuth('admin'), ctrl.updateAppointmentStatus);
router.get('/settings', roleAuth(['admin', 'doctor']), ctrl.getSettings);
router.post('/settings', roleAuth('admin'), ctrl.updateSettings);

module.exports = router;
