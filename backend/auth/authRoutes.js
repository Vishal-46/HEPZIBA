const express = require('express');
const router = express.Router();
const ctrl = require('./authController');

const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { loginLimiter, forgotLimiter, resetLimiter } = require('../middleware/rateLimit');

// Registration (public, patient-only)
router.post('/register/patient', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').notEmpty().trim()
], validate, ctrl.registerPatient);

// Email verification (real): code issued at registration, 15-min expiry.
router.post('/verify-email', [
  body('email').isEmail().normalizeEmail(),
  body('code').matches(/^\d{6}$/),
], validate, ctrl.verifyEmail);
router.post('/resend-verification', forgotLimiter, [
  body('email').isEmail().normalizeEmail(),
], validate, ctrl.resendVerification);

// Login (rate-limited: brute-force protection)
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], validate, ctrl.login);

// Google OAuth login (rate-limited like password login)
router.post('/google', loginLimiter, [
  body('idToken').notEmpty().isString().trim()
], validate, ctrl.googleLogin);

// Password reset (rate-limited: email-abuse + code-guessing protection)
router.post('/forgot-password', forgotLimiter, [
  body('email').isEmail().normalizeEmail()
], validate, ctrl.forgotPassword);
router.post('/reset-password', resetLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('code').matches(/^\d{6}$/),
  body('newPassword').isLength({ min: 8 })
], validate, ctrl.resetPassword);

const roleAuth = require('../middleware/roleAuth');

// Admin-only registration endpoints — NEVER public. There is no public
// signup for doctor/admin roles. The very first admin cannot be created via
// this API (chicken-and-egg: no admin token exists yet); seed it directly
// in the database — see sql/003_seed_admin_example.sql (placeholders only,
// no real secrets).
router.post('/register/doctor', roleAuth('admin'), [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').notEmpty().trim(),
  body('specialty').optional().isString().trim(),
  body('phone').optional().isString().trim(),
  body('bio').optional().isString().trim()
], validate, ctrl.registerDoctor);
router.post('/register/admin', roleAuth('admin'), [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').notEmpty().trim()
], validate, ctrl.registerAdmin);

module.exports = router;
