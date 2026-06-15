const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const {
  createHall,
  getAllHalls,
  getHallById,
  suspendHall,
  activateHall,
  deleteHall,
  getAggregateHallStats,
  getHallStats,
  getHallActivity,
  getAdminDashboardStats,
  getAdminAnalytics,
  getAdminUsers,
  updateAdminUserStatus,
  resetAdminUserPassword,
  getAdminSettings,
  updateAdminSettings,
  getAdminTickets,
  updateAdminTicketStatus,
  addAdminTicketMessage,
} = require("../controllers/adminController");

const isSuperAdmin = [authMiddleware, roleMiddleware("super_admin")];

router.get("/stats", ...isSuperAdmin, getAggregateHallStats);
router.get("/dashboard-stats", ...isSuperAdmin, getAdminDashboardStats);
router.get("/analytics", ...isSuperAdmin, getAdminAnalytics);
router.get("/users", ...isSuperAdmin, getAdminUsers);
router.patch("/users/:id/status", ...isSuperAdmin, updateAdminUserStatus);
router.post("/users/:id/reset-password", ...isSuperAdmin, resetAdminUserPassword);
router.get("/settings", ...isSuperAdmin, getAdminSettings);
router.put("/settings", ...isSuperAdmin, updateAdminSettings);
router.get("/tickets", ...isSuperAdmin, getAdminTickets);
router.patch("/tickets/:id", ...isSuperAdmin, updateAdminTicketStatus);
router.post("/tickets/:id/messages", ...isSuperAdmin, addAdminTicketMessage);

router.post("/halls", ...isSuperAdmin, createHall);
router.get("/halls", ...isSuperAdmin, getAllHalls);
router.get("/halls/:id", ...isSuperAdmin, getHallById);
router.get("/halls/:id/stats", ...isSuperAdmin, getHallStats);
router.get("/halls/:id/activity", ...isSuperAdmin, getHallActivity);
router.patch("/halls/:id/suspend", ...isSuperAdmin, suspendHall);
router.patch("/halls/:id/activate", ...isSuperAdmin, activateHall);
router.delete("/halls/:id", ...isSuperAdmin, deleteHall);

module.exports = router;