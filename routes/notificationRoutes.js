const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearReadNotifications,
  generateSystemNotifications,
} = require("../controllers/notificationController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

// ---- Read notifications ----
router.get("/", ...isAuthenticated, getNotifications);
router.get("/unread-count", ...isAuthenticated, getUnreadCount);

// ---- Mark as read ----
router.patch("/read-all", ...isAuthenticated, markAllAsRead);
router.patch("/:id/read", ...isAuthenticated, markAsRead);

// ---- Delete ----
router.delete("/clear-read", ...isOwnerOrManager, clearReadNotifications);
router.delete("/:id", ...isAuthenticated, deleteNotification);

// ---- System generation — protected, called by cron or Supabase Edge Function ----
// Requires a CRON_SECRET header matching process.env.CRON_SECRET
router.post("/generate", (req, res, next) => {
  const secret = req.headers["x-cron-secret"];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
}, generateSystemNotifications);

module.exports = router;