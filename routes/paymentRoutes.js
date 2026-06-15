const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  createPayment,
  getPayments,
  getPaymentsByBooking,
  deletePayment,
  getPaymentStats,
} = require("../controllers/paymentController");

const { validatePayment } = require("../middleware/validationMiddleware");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/stats", ...isOwnerOrManager, getPaymentStats);
router.get("/", ...isAuthenticated, getPayments);
router.get("/booking/:booking_id", ...isAuthenticated, getPaymentsByBooking);
router.post("/", ...isOwnerOrManager, validatePayment, createPayment);
router.delete("/:id", ...isOwnerOrManager, deletePayment);

module.exports = router;