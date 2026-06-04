const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  getHallSettings,
  updateHallSettings,
  updateNotificationPreferences,
} = require("../controllers/hallSettingsController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwner = [authMiddleware, roleMiddleware("owner"), subscriptionMiddleware];

// GET settings — all authenticated staff can view (needed for invoice generation etc.)
router.get("/", ...isAuthenticated, getHallSettings);

// UPDATE full settings — only owner
router.put("/", ...isOwner, updateHallSettings);

// UPDATE notification preferences — owner or manager
router.patch(
  "/notifications",
  authMiddleware,
  roleMiddleware(["owner", "manager"]),
  subscriptionMiddleware,
  updateNotificationPreferences
);

module.exports = router;