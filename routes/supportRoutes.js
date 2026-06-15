const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  createTicket,
  getTickets,
  getTicketById,
  addTicketMessage,
} = require("../controllers/supportController");

const isAuthenticated = [authMiddleware, subscriptionMiddleware];

router.post("/tickets", ...isAuthenticated, createTicket);
router.get("/tickets", ...isAuthenticated, getTickets);
router.get("/tickets/:id", ...isAuthenticated, getTicketById);
router.post("/tickets/:id/messages", ...isAuthenticated, addTicketMessage);

module.exports = router;
