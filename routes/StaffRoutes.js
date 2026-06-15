const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");
const { createStaff, getStaff, updateStaff, deleteStaff } = require("../controllers/staffController");

const isOwner = [authMiddleware, roleMiddleware("owner"), subscriptionMiddleware];

router.post("/", ...isOwner, createStaff);
router.get("/", ...isOwner, getStaff);
router.patch("/:id", ...isOwner, updateStaff);
router.put("/:id", ...isOwner, updateStaff);
router.delete("/:id", ...isOwner, deleteStaff);

module.exports = router;