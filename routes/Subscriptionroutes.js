const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const { getSubscription, renewSubscription, changePackage, requestSubscriptionChange } = require("../controllers/SubcriptionController");

const isSuperAdmin = [authMiddleware, roleMiddleware("super_admin")];

// Hall owner can view their own subscription
router.get("/my", authMiddleware, (req, res, next) => {
  req.params.hall_id = req.user.primary_hall_id || req.user.hall_id;
  next();
}, getSubscription);

// Hall owner can request upgrade or extension
router.post("/request-change", authMiddleware, requestSubscriptionChange);

// Super admin manages subscriptions
router.get("/:hall_id", ...isSuperAdmin, getSubscription);
router.put("/:hall_id/renew", ...isSuperAdmin, renewSubscription);
router.patch("/:hall_id/change-package", ...isSuperAdmin, changePackage);

module.exports = router;