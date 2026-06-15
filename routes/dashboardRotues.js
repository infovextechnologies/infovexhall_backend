const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  getDashboard,
  getRevenueSummary,
  getMonthlyBookings,
  getUpcomingBookings,
  getRecentPayments
} = require("../controllers/dashboardController");

router.get("/", authMiddleware, subscriptionMiddleware, getDashboard);
router.get("/revenue-summary", authMiddleware, subscriptionMiddleware, getRevenueSummary);
router.get("/monthly-bookings", authMiddleware, subscriptionMiddleware, getMonthlyBookings);
router.get("/upcoming-bookings", authMiddleware, subscriptionMiddleware, getUpcomingBookings);
router.get("/recent-payments", authMiddleware, subscriptionMiddleware, getRecentPayments);

module.exports = router;