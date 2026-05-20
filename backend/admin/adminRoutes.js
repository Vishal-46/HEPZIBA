const express = require('express');
const router = express.Router();
const ctrl = require('./adminController');
const roleAuth = require('../middleware/roleAuth');

router.get('/users', roleAuth('admin'), ctrl.listUsers);
router.get('/users/:id', roleAuth('admin'), ctrl.getUser);
router.put('/users/:id', roleAuth('admin'), ctrl.updateUser);
router.delete('/users/:id', roleAuth('admin'), ctrl.deleteUser);
router.get('/appointments', roleAuth('admin'), ctrl.listAppointments);

module.exports = router;
