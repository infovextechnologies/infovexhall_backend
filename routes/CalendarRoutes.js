const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const {
  getEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getUpcomingEvents,
} = require("../controllers/CalendarController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwnerOrManager = [authMiddleware, roleMiddleware(["owner", "manager"]), subscriptionMiddleware];

router.get("/upcoming", ...isAuthenticated, getUpcomingEvents);
router.get("/events", ...isAuthenticated, getEvents);
router.post("/events", ...isOwnerOrManager, createEvent);
router.put("/events/:id", ...isOwnerOrManager, updateEvent);
router.delete("/events/:id", ...isOwnerOrManager, deleteEvent);

module.exports = router;