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
  deleteBooking,
} = require("../controllers/bookingController");
const {
  allocateVendor,
  updateAllocation,
  deallocateVendor,
  getBookingVendors,
} = require("../controllers/bookingVendorController");

const { validateBooking } = require("../middleware/validationMiddleware");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/check-availability", ...isAuthenticated, checkAvailability);
router.get("/stats", ...isOwnerOrManager, getBookingStats);
router.get("/", ...isAuthenticated, getBookings);
router.get("/:id", ...isAuthenticated, getBookingById);
router.post("/", ...isOwnerOrManager, validateBooking, createBooking);
router.put("/:id", ...isOwnerOrManager, validateBooking, updateBooking);
router.patch("/:id/cancel", ...isOwnerOrManager, cancelBooking);
router.delete("/:id", ...isOwnerOrManager, deleteBooking);

// Vendor allocations routes
router.get("/:bookingId/vendors", ...isAuthenticated, getBookingVendors);
router.post("/:bookingId/vendors", ...isOwnerOrManager, allocateVendor);
router.put("/:bookingId/vendors/:vendorId", ...isOwnerOrManager, updateAllocation);
router.delete("/:bookingId/vendors/:vendorId", ...isOwnerOrManager, deallocateVendor);

module.exports = router;