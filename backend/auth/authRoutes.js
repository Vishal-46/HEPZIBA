const express = require('express');
const router = express.Router();
const ctrl = require('./authController');

const { body } = require('express-validator');
const validate = require('../middleware/validate');

// Registration and verification
router.post('/register/patient', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').notEmpty().trim()
], validate, ctrl.registerPatient);
router.post('/verify-email', ctrl.verifyEmail);

// Login
router.post('/login', ctrl.login);
router.post('/google', ctrl.googleLogin);

// Password reset
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);

const roleAuth = require('../middleware/roleAuth');

// Admin-only registration endpoints
router.post('/register/doctor', roleAuth('admin'), ctrl.registerDoctor);
router.post('/register/admin', roleAuth('admin'), ctrl.registerAdmin);

module.exports = router;
