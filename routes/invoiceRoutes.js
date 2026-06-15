const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  createInvoice,
  getInvoiceById,
  getInvoiceByBooking,
  getInvoices,
  updateInvoiceStatus,
  getInvoiceHtml,
  createReceipt,
  deleteInvoice,
} = require("../controllers/invoiceController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

// ---- Invoice list and creation ----
router.get("/", ...isAuthenticated, getInvoices);
router.post("/", ...isOwnerOrManager, createInvoice);

// ---- Get invoice by booking (useful shortcut for booking detail page) ----
router.get("/booking/:booking_id", ...isAuthenticated, getInvoiceByBooking);

// ---- Individual invoice operations ----
router.get("/:id", ...isAuthenticated, getInvoiceById);
router.patch("/:id/sync", ...isOwnerOrManager, updateInvoiceStatus);
router.delete("/:id", ...isOwnerOrManager, deleteInvoice);

// ---- HTML invoice — returns printable HTML page ----
// No JSON header — returns text/html directly for iframe or print window
router.get("/:id/html", ...isAuthenticated, getInvoiceHtml);

// ---- Payment receipt ----
// Returns printable HTML receipt for a single payment
router.get("/receipt/:payment_id", ...isAuthenticated, createReceipt);

module.exports = router;