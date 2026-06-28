const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const { getMuhurthams, addMuhurtham } = require("../controllers/muhurthamController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];

// GET: Fetch Muhurtham dates
router.get("/", ...isAuthenticated, getMuhurthams);

// POST: Add a custom Muhurtham date (guarded by super admin check in controller)
router.post("/", ...isAuthenticated, addMuhurtham);

module.exports = router;
