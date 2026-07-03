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
  getInvoiceDto,
  getReceiptDto,
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

// ---- Document DTO Endpoints ----
router.get("/:id/dto", ...hasPermission("view_payments"), getInvoiceDto);
router.get("/receipt/:payment_id/dto", ...hasPermission("view_payments"), getReceiptDto);

module.exports = router;