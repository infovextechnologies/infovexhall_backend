require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

// ---- Existing routes (unchanged) ----
const authRoutes         = require("./routes/authRoutes");
const adminRoutes        = require("./routes/adminRoutes");
const staffRoutes        = require("./routes/StaffRoutes");
const packageRoutes      = require("./routes/Packageroutes");
const subscriptionRoutes = require("./routes/Subscriptionroutes");
const customerRoutes     = require("./routes/customerRoutes");
const bookingRoutes      = require("./routes/bookingRoutes");
const paymentRoutes      = require("./routes/paymentRoutes");
const vendorRoutes       = require("./routes/vendorRoutes");
const calendarRoutes     = require("./routes/CalendarRoutes");
const dashboardRoutes    = require("./routes/dashboardRotues");

// ---- New routes (add these) ----
const hallProfileRoutes  = require("./routes/hallProfileRoutes");
const hallSettingsRoutes = require("./routes/hallSettingsRoutes");
const enquiryRoutes      = require("./routes/enquiryRoutes");
const invoiceRoutes      = require("./routes/invoiceRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const activityLogRoutes  = require("./routes/activityLogRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(helmet());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---- Existing routes ----
app.use("/auth",          authRoutes);
app.use("/admin",         adminRoutes);
app.use("/staff",         staffRoutes);
app.use("/packages",      packageRoutes);
app.use("/subscriptions", subscriptionRoutes);
app.use("/dashboard",     dashboardRoutes);
app.use("/customers",     customerRoutes);
app.use("/bookings",      bookingRoutes);
app.use("/payments",      paymentRoutes);
app.use("/vendors",       vendorRoutes);
app.use("/calendar",      calendarRoutes);

// ---- New routes ----
app.use("/hall/profile",   hallProfileRoutes);
app.use("/hall/settings",  hallSettingsRoutes);
app.use("/enquiries",      enquiryRoutes);
app.use("/invoices",       invoiceRoutes);
app.use("/notifications",  notificationRoutes);
app.use("/activity-logs",  activityLogRoutes);

// ---- Health check ----
app.get("/health", (req, res) => {
  res.json({ status: "HallFlow backend is running", timestamp: new Date() });
});

// ---- Global error handler ----
app.use((err, req, res, next) => {
  console.error(err.stack);

  // Multer file size error
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ message: "File too large. Maximum size is 5MB." });
  }

  // Multer file type error (thrown in fileFilter)
  if (err.message?.includes("Only JPEG")) {
    return res.status(400).json({ message: err.message });
  }

  res.status(500).json({ message: "Unexpected server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HallFlow server running on port ${PORT}`);
});