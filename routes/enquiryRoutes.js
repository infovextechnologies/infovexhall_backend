const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  createEnquiry,
  getEnquiries,
  getEnquiryById,
  updateEnquiryStatus,
  updateEnquiry,
  convertToBooking,
  getEnquiryStats,
  addFollowup,
  completeFollowup,
  getFollowups,
  getTodaysFollowups,
} = require("../controllers/enquiryController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

// ---- Enquiry CRUD ----
router.get("/stats", ...isOwnerOrManager, getEnquiryStats);
router.get("/followups/today", ...isAuthenticated, getTodaysFollowups);
router.get("/", ...isAuthenticated, getEnquiries);
router.post("/", ...isAuthenticated, createEnquiry);
router.get("/:id", ...isAuthenticated, getEnquiryById);
router.put("/:id", ...isOwnerOrManager, updateEnquiry);

// ---- Status transition ----
router.patch("/:id/status", ...isOwnerOrManager, updateEnquiryStatus);

// ---- Convert to booking ----
router.post("/:id/convert", ...isOwnerOrManager, convertToBooking);

// ---- Followups ----
router.get("/:id/followups", ...isAuthenticated, getFollowups);
router.post("/:id/followups", ...isAuthenticated, addFollowup);
router.patch("/:id/followups/:followup_id/complete", ...isAuthenticated, completeFollowup);

module.exports = router;