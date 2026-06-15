const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  createVendor,
  getVendors,
  getVendorById,
  updateVendor,
  deleteVendor,
} = require("../controllers/VendorController");
const {
  getVendorAllocations,
  getVendorAllocationStats,
} = require("../controllers/bookingVendorController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/", ...isAuthenticated, getVendors);
router.get("/:id/allocations", ...isAuthenticated, getVendorAllocations);
router.get("/:id/allocation-stats", ...isAuthenticated, getVendorAllocationStats);
router.get("/:id", ...isAuthenticated, getVendorById);
router.post("/", ...isOwnerOrManager, createVendor);
router.put("/:id", ...isOwnerOrManager, updateVendor);
router.delete("/:id", ...isOwnerOrManager, deleteVendor);

module.exports = router;