const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  checkAvailability,
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  cancelBooking,
  getBookingStats,
} = require("../controllers/bookingController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/check-availability", ...isAuthenticated, checkAvailability);
router.get("/stats", ...isOwnerOrManager, getBookingStats);
router.get("/", ...isAuthenticated, getBookings);
router.get("/:id", ...isAuthenticated, getBookingById);
router.post("/", ...isOwnerOrManager, createBooking);
router.put("/:id", ...isOwnerOrManager, updateBooking);
router.patch("/:id/cancel", ...isOwnerOrManager, cancelBooking);

module.exports = router;