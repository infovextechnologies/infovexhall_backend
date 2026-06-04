const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const { getDashboard } = require("../controllers/dashboardController");

router.get("/", authMiddleware, subscriptionMiddleware, getDashboard);

module.exports = router;