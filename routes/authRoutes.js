const express = require("express");
const router = express.Router();
const { loginUser, refreshToken, getProfile, createSuperAdmin, forgotPassword, resetPassword, changePassword } = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const { authLimiter } = require("../middleware/rateLimitMiddleware");

router.post("/login", authLimiter, loginUser);
router.post("/refresh", refreshToken);
router.post("/refresh-token", refreshToken); // alias to match frontend API client
router.get("/profile", authMiddleware, getProfile);
router.post("/create-super-admin", createSuperAdmin); // bootstrap only
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);
router.post("/change-password", authMiddleware, changePassword);

module.exports = router;