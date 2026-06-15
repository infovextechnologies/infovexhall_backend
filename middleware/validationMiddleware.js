/**
 * Zero-dependency request validation middleware
 * Validates request bodies for bookings, payments, and enquiries
 */

// Simple regex to check ISO Date formats (e.g. YYYY-MM-DD)
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Helper to return validation error response
const sendErrors = (res, errors) => {
  return res.status(400).json({
    message: "Request validation failed",
    errors,
  });
};

/**
 * Validate Booking creation & updates
 */
const validateBooking = (req, res, next) => {
  const errors = [];
  const {
    customer_id,
    start_date,
    end_date,
    total_amount,
    advance_amount,
    discount_amount,
    guest_count,
  } = req.body;

  // customer_id, start_date, and end_date are required for creation (POST)
  // For updates (PUT), they might be optional, but if provided, must be valid.
  const isPost = req.method === "POST";

  if (isPost) {
    if (!customer_id) errors.push("customer_id is required");
    if (!start_date) errors.push("start_date is required");
    if (!end_date) errors.push("end_date is required");
  }

  // Type checks if they exist
  if (customer_id && typeof customer_id !== "string") {
    errors.push("customer_id must be a string");
  }

  if (start_date) {
    if (typeof start_date !== "string" || !DATE_REGEX.test(start_date) || isNaN(Date.parse(start_date))) {
      errors.push("start_date must be a valid date string in YYYY-MM-DD format");
    }
  }

  if (end_date) {
    if (typeof end_date !== "string" || !DATE_REGEX.test(end_date) || isNaN(Date.parse(end_date))) {
      errors.push("end_date must be a valid date string in YYYY-MM-DD format");
    }
  }

  if (start_date && end_date && !errors.length) {
    if (new Date(start_date) > new Date(end_date)) {
      errors.push("start_date cannot be after end_date");
    }
  }

  // Optional numeric boundary checks
  if (total_amount !== undefined) {
    const val = Number(total_amount);
    if (isNaN(val) || val < 0) {
      errors.push("total_amount must be a non-negative number");
    }
  }

  if (advance_amount !== undefined) {
    const val = Number(advance_amount);
    if (isNaN(val) || val < 0) {
      errors.push("advance_amount must be a non-negative number");
    }
  }

  if (discount_amount !== undefined) {
    const val = Number(discount_amount);
    if (isNaN(val) || val < 0) {
      errors.push("discount_amount must be a non-negative number");
    }
  }

  if (guest_count !== undefined) {
    const val = Number(guest_count);
    if (isNaN(val) || !Number.isInteger(val) || val < 0) {
      errors.push("guest_count must be a non-negative integer");
    }
  }

  if (errors.length > 0) {
    return sendErrors(res, errors);
  }

  next();
};

/**
 * Validate Payment creation
 */
const validatePayment = (req, res, next) => {
  const errors = [];
  const { booking_id, amount, payment_method, payment_date } = req.body;

  if (!booking_id) errors.push("booking_id is required");
  if (amount === undefined) errors.push("amount is required");
  if (!payment_method) errors.push("payment_method is required");
  if (!payment_date) errors.push("payment_date is required");

  if (booking_id && typeof booking_id !== "string") {
    errors.push("booking_id must be a string");
  }

  if (amount !== undefined) {
    const val = Number(amount);
    if (isNaN(val) || val <= 0) {
      errors.push("amount must be a positive number greater than zero");
    }
  }

  if (payment_method) {
    const allowedMethods = ["cash", "bank_transfer", "upi", "card", "cheque"];
    if (!allowedMethods.includes(payment_method)) {
      errors.push(`payment_method must be one of: ${allowedMethods.join(", ")}`);
    }
  }

  if (payment_date) {
    if (typeof payment_date !== "string" || !DATE_REGEX.test(payment_date) || isNaN(Date.parse(payment_date))) {
      errors.push("payment_date must be a valid date string in YYYY-MM-DD format");
    }
  }

  if (errors.length > 0) {
    return sendErrors(res, errors);
  }

  next();
};

/**
 * Validate Enquiry creation & updates
 */
const validateEnquiry = (req, res, next) => {
  const errors = [];
  const { customer_name, phone, event_date, guest_count, budget_min, budget_max } = req.body;
  const isPost = req.method === "POST";

  if (isPost) {
    if (!customer_name || typeof customer_name !== "string" || !customer_name.trim()) {
      errors.push("customer_name is required and must be a non-empty string");
    }
    if (!phone || typeof phone !== "string" || !phone.trim()) {
      errors.push("phone is required and must be a non-empty string");
    }
  }

  if (customer_name !== undefined && (typeof customer_name !== "string" || !customer_name.trim())) {
    errors.push("customer_name must be a non-empty string");
  }

  if (phone !== undefined && (typeof phone !== "string" || !phone.trim())) {
    errors.push("phone must be a non-empty string");
  }

  if (event_date) {
    if (typeof event_date !== "string" || !DATE_REGEX.test(event_date) || isNaN(Date.parse(event_date))) {
      errors.push("event_date must be a valid date string in YYYY-MM-DD format");
    }
  }

  if (guest_count !== undefined) {
    const val = Number(guest_count);
    if (isNaN(val) || !Number.isInteger(val) || val < 0) {
      errors.push("guest_count must be a non-negative integer");
    }
  }

  if (budget_min !== undefined) {
    const val = Number(budget_min);
    if (isNaN(val) || val < 0) {
      errors.push("budget_min must be a non-negative number");
    }
  }

  if (budget_max !== undefined) {
    const val = Number(budget_max);
    if (isNaN(val) || val < 0) {
      errors.push("budget_max must be a non-negative number");
    }
  }

  if (budget_min !== undefined && budget_max !== undefined && !errors.length) {
    if (Number(budget_min) > Number(budget_max)) {
      errors.push("budget_min cannot be greater than budget_max");
    }
  }

  if (errors.length > 0) {
    return sendErrors(res, errors);
  }

  next();
};

module.exports = {
  validateBooking,
  validatePayment,
  validateEnquiry,
};
