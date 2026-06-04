const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  getActivityLogs,
  getEntityLogs,
  getRecentActivity,
  getActivitySummary,
} = require("../controllers/activityLogController");

// Only owner and manager can view activity logs
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

// ---- Log list ----
router.get("/", ...isOwnerOrManager, getActivityLogs);
router.get("/recent", ...isOwnerOrManager, getRecentActivity);
router.get("/summary", ...isOwnerOrManager, getActivitySummary);

// ---- Logs for a specific entity ----
// e.g. GET /activity-logs/booking/uuid-here
router.get("/:entity_type/:entity_id", ...isOwnerOrManager, getEntityLogs);

module.exports = router;