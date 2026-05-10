const express = require('express');
const router = express.Router();
const ctrl = require('./authController');

// Registration and verification
router.post('/register/patient', ctrl.registerPatient);
router.post('/verify-email', ctrl.verifyEmail);

// Login
router.post('/login', ctrl.login);

// Password reset
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);

const roleAuth = require('../middleware/roleAuth');

// Admin-only registration endpoints
router.post('/register/doctor', roleAuth('admin'), ctrl.registerDoctor);
router.post('/register/admin', roleAuth('admin'), ctrl.registerAdmin);

module.exports = router;
