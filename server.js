require("dotenv").config();
const express = require("express");
const cors = require("cors");


const helmet = require("helmet");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

// ---- Existing routes (unchanged) ----
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const staffRoutes = require("./routes/StaffRoutes");
const packageRoutes = require("./routes/Packageroutes");
const subscriptionRoutes = require("./routes/Subscriptionroutes");
const customerRoutes = require("./routes/customerRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const vendorRoutes = require("./routes/vendorRoutes");
const calendarRoutes = require("./routes/CalendarRoutes");
const dashboardRoutes = require("./routes/dashboardRotues");

// ---- New routes (add these) ----
const hallProfileRoutes = require("./routes/hallProfileRoutes");
const hallSettingsRoutes = require("./routes/hallSettingsRoutes");
const enquiryRoutes = require("./routes/enquiryRoutes");
const invoiceRoutes = require("./routes/invoiceRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const activityLogRoutes = require("./routes/activityLogRoutes");
const multiHallRoutes = require("./routes/multiHallRoutes");

const app = express();

app.use(express.json());
app.use(helmet());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://hallsondesk.netlify.app",
  "https://infovexweddinghallcrm.netlify.app",
  "https://hallflow2.netlify.app"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or server-to-server)
    if (!origin) return callback(null, true);
    
    // Match allowed list or any Vercel deployment URL
    if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }
    
    return callback(new Error("Not allowed by CORS"), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Active-Hall-ID", "X-Product-Context"],
}));


// ---- Existing routes ----
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/staff", staffRoutes);
app.use("/packages", packageRoutes);
app.use("/subscriptions", subscriptionRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/customers", customerRoutes);
app.use("/bookings", bookingRoutes);
app.use("/payments", paymentRoutes);
app.use("/vendors", vendorRoutes);
app.use("/calendar", calendarRoutes);

// ---- New routes ----
app.use("/hall/profile", hallProfileRoutes);
app.use("/hall/settings", hallSettingsRoutes);
app.use("/enquiries", enquiryRoutes);
app.use("/invoices", invoiceRoutes);
app.use("/notifications", notificationRoutes);
app.use("/activity-logs",  activityLogRoutes);
app.use("/multihall",      multiHallRoutes);

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