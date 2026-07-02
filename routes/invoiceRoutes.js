const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const permissionMiddleware = require("../middleware/permissionMiddleware");

const {
  createInvoice,
  getInvoiceById,
  getInvoiceByBooking,
  getInvoices,
  updateInvoiceStatus,
  getInvoiceHtml,
  getInvoicePdf,
  createReceipt,
  getReceiptPdf,
  deleteInvoice,
  exportGstr1Report,
} = require("../controllers/invoiceController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const hasPermission = (perm) => [authMiddleware, subscriptionMiddleware, permissionMiddleware(perm)];

// ---- Invoice list and creation ----
router.get("/", ...hasPermission("view_payments"), getInvoices);
router.post("/", ...hasPermission("create_payments"), createInvoice);

// ---- Export GSTR-1 Report ----
router.get("/export/gstr1", ...hasPermission("view_payments"), exportGstr1Report);

// ---- Get invoice by booking (useful shortcut for booking detail page) ----
router.get("/booking/:booking_id", ...hasPermission("view_payments"), getInvoiceByBooking);

// ---- Individual invoice operations ----
router.get("/:id", ...hasPermission("view_payments"), getInvoiceById);
router.patch("/:id/sync", ...hasPermission("create_payments"), updateInvoiceStatus);
router.delete("/:id", ...hasPermission("delete_bookings"), deleteInvoice);

// ---- HTML invoice — returns printable HTML page ----
// No JSON header — returns text/html directly for iframe or print window
router.get("/:id/html", ...hasPermission("view_payments"), getInvoiceHtml);

// ---- PDF invoice — returns compiled high-fidelity vector PDF ----
router.get("/:id/pdf", ...hasPermission("view_payments"), getInvoicePdf);

// ---- Payment receipt ----
// Returns printable HTML receipt for a single payment
router.get("/receipt/:payment_id", ...hasPermission("view_payments"), createReceipt);

// ---- PDF receipt — returns compiled vector PDF receipt ----
router.get("/receipt/:payment_id/pdf", ...hasPermission("view_payments"), getReceiptPdf);

module.exports = router;