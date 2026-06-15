const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  logCustomerInteraction,
} = require("../controllers/customerController");

// All staff roles can read customers; owner/manager can write
const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/", ...isAuthenticated, getCustomers);
router.get("/:id", ...isAuthenticated, getCustomerById);
router.post("/", ...isOwnerOrManager, createCustomer);
router.put("/:id", ...isOwnerOrManager, updateCustomer);
router.delete("/:id", ...isOwnerOrManager, deleteCustomer);
router.post("/:id/interactions", ...isAuthenticated, logCustomerInteraction);

module.exports = router;