const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const permissionMiddleware = require("../middleware/permissionMiddleware");
const {
  createPayment,
  getPayments,
  getPaymentsByBooking,
  deletePayment,
  getPaymentStats,
  updatePayment,
} = require("../controllers/paymentController");

const { validatePayment, validatePaymentUpdate } = require("../middleware/validationMiddleware");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const hasPermission = (perm) => [authMiddleware, subscriptionMiddleware, permissionMiddleware(perm)];

router.get("/stats", ...hasPermission("view_payments"), getPaymentStats);
router.get("/", ...hasPermission("view_payments"), getPayments);
router.get("/booking/:booking_id", ...hasPermission("view_payments"), getPaymentsByBooking);
router.post("/", ...hasPermission("create_payments"), validatePayment, createPayment);
router.patch("/:id", ...hasPermission("create_payments"), validatePaymentUpdate, updatePayment);
router.delete("/:id", ...hasPermission("create_payments"), deletePayment);

module.exports = router;