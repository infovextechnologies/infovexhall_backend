const express = require("express");
const router = express.Router();
const multer = require("multer");

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const subscriptionMiddleware = require("../middleware/Subscriptionmiddleware");

const {
  getHallProfile,
  upsertHallProfile,
  uploadLogo,
  uploadCoverImage,
  addGalleryImage,
  removeGalleryImage,
} = require("../controllers/hallProfileController");

// Multer — store file in memory so we can pass buffer to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP images are allowed"), false);
    }
  },
});

const isAuthenticated = [authMiddleware, subscriptionMiddleware];
const isOwner = [authMiddleware, roleMiddleware("owner"), subscriptionMiddleware];

// GET hall profile — all authenticated staff can view
router.get("/", ...isAuthenticated, getHallProfile);

// UPDATE hall profile — only owner
router.put("/", ...isOwner, upsertHallProfile);

// UPLOAD logo — only owner
router.post("/logo", ...isOwner, upload.single("logo"), uploadLogo);

// UPLOAD cover image — only owner
router.post("/cover", ...isOwner, upload.single("cover"), uploadCoverImage);

// GALLERY — only owner
router.post("/gallery", ...isOwner, upload.single("image"), addGalleryImage);
router.delete("/gallery", ...isOwner, removeGalleryImage);

module.exports = router;