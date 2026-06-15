const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

const mapSettingsBodyToDb = (body) => {
  const fields = {};

  if (body.invoicePrefix !== undefined) fields.invoice_prefix = body.invoicePrefix;
  else if (body.invoice_prefix !== undefined) fields.invoice_prefix = body.invoice_prefix;

  if (body.bookingPrefix !== undefined) fields.booking_prefix = body.bookingPrefix;
  else if (body.booking_prefix !== undefined) fields.booking_prefix = body.booking_prefix;

  if (body.receiptPrefix !== undefined) fields.receipt_prefix = body.receiptPrefix;
  else if (body.receipt_prefix !== undefined) fields.receipt_prefix = body.receipt_prefix;

  if (body.invoiceStartNumber !== undefined) fields.invoice_start_number = body.invoiceStartNumber;
  else if (body.invoice_start_number !== undefined) fields.invoice_start_number = body.invoice_start_number;

  if (body.bookingStartNumber !== undefined) fields.booking_start_number = body.bookingStartNumber;
  else if (body.booking_start_number !== undefined) fields.booking_start_number = body.booking_start_number;

  if (body.currency !== undefined) fields.currency = body.currency;

  if (body.currencySymbol !== undefined) fields.currency_symbol = body.currencySymbol;
  else if (body.currency_symbol !== undefined) fields.currency_symbol = body.currency_symbol;

  if (body.dateFormat !== undefined) fields.date_format = body.dateFormat;
  else if (body.date_format !== undefined) fields.date_format = body.date_format;

  if (body.timeFormat !== undefined) fields.time_format = body.timeFormat;
  else if (body.time_format !== undefined) fields.time_format = body.time_format;

  if (body.timezone !== undefined) fields.timezone = body.timezone;

  if (body.taxEnabled !== undefined) fields.tax_enabled = body.taxEnabled;
  else if (body.tax_enabled !== undefined) fields.tax_enabled = body.tax_enabled;

  if (body.gstRate !== undefined) {
    fields.tax_percentage = body.gstRate;
    fields.tax_label = "GST";
  } else if (body.tax_percentage !== undefined) {
    fields.tax_percentage = body.tax_percentage;
  }
  if (body.tax_label !== undefined) fields.tax_label = body.tax_label;

  if (body.gstApplicableOn !== undefined) fields.gst_applicable_on = body.gstApplicableOn;
  else if (body.gst_applicable_on !== undefined) fields.gst_applicable_on = body.gst_applicable_on;

  if (body.autoInvoice !== undefined) fields.auto_invoice = body.autoInvoice;
  else if (body.auto_invoice !== undefined) fields.auto_invoice = body.auto_invoice;

  if (body.invoiceFooterNote !== undefined) fields.invoice_footer_note = body.invoiceFooterNote;
  else if (body.invoice_footer_note !== undefined) fields.invoice_footer_note = body.invoice_footer_note;

  if (body.termsAndConditions !== undefined) fields.terms_and_conditions = body.termsAndConditions;
  else if (body.terms_and_conditions !== undefined) fields.terms_and_conditions = body.terms_and_conditions;
  else if (body.booking_terms !== undefined) fields.terms_and_conditions = body.booking_terms;

  if (body.cancellation_policy !== undefined) fields.cancellation_policy = body.cancellation_policy;

  if (body.advance_percentage !== undefined) fields.advance_percentage = body.advance_percentage;
  if (body.booking_confirmation_message !== undefined) fields.booking_confirmation_message = body.booking_confirmation_message;
  if (body.payment_reminder_message !== undefined) fields.payment_reminder_message = body.payment_reminder_message;

  if (body.invoiceTemplate !== undefined) fields.invoice_template = body.invoiceTemplate;
  else if (body.invoice_template !== undefined) fields.invoice_template = body.invoice_template;

  // JSON fields
  if (body.notifications !== undefined) fields.notifications = body.notifications;
  if (body.bookingSettings !== undefined) fields.booking_settings = body.bookingSettings;
  else if (body.booking_settings !== undefined) fields.booking_settings = body.booking_settings;

  // Sync back notification flags if present
  if (fields.notifications) {
    fields.email_notifications = fields.notifications.emailEnabled !== undefined ? fields.notifications.emailEnabled : true;
    fields.whatsapp_notifications = fields.notifications.whatsappEnabled !== undefined ? fields.notifications.whatsappEnabled : false;
  }

  // Sync back advance policy if present inside booking settings
  if (fields.booking_settings) {
    fields.advance_percentage = fields.booking_settings.minimumAdvancePercent !== undefined ? fields.booking_settings.minimumAdvancePercent : 25;
  }

  return fields;
};

const formatDbSettingsToFrontend = (data) => {
  if (!data) return null;
  return {
    ...data,
    id: data.id,
    hallId: data.hall_id,
    invoicePrefix: data.invoice_prefix || "INV",
    bookingPrefix: data.booking_prefix || "BK",
    receiptPrefix: data.receipt_prefix || "RCP",
    invoiceStartNumber: data.invoice_start_number || 1,
    bookingStartNumber: data.booking_start_number || 1,
    currency: data.currency || "INR",
    currencySymbol: data.currency_symbol || "₹",
    dateFormat: data.date_format || "DD/MM/YYYY",
    timeFormat: data.time_format || "12h",
    timezone: data.timezone || "Asia/Kolkata",
    taxEnabled: data.tax_enabled || false,
    gstRate: data.tax_percentage || 0,
    gstApplicableOn: data.gst_applicable_on || "all",
    autoInvoice: data.auto_invoice || false,
    invoiceFooterNote: data.invoice_footer_note || "Thank you for choosing us!",
    termsAndConditions: data.terms_and_conditions || "",
    notifications: data.notifications || {
      emailEnabled: data.email_notifications !== undefined ? data.email_notifications : true,
      smsEnabled: true,
      whatsappEnabled: data.whatsapp_notifications !== undefined ? data.whatsapp_notifications : false,
      newBookingAlert: true,
      paymentReceivedAlert: true,
      enquiryAlert: true,
      followupReminder: true,
      bookingReminderDaysBefore: 2,
      dailySummaryEnabled: true,
      dailySummaryTime: "08:00",
    },
    bookingSettings: data.booking_settings || {
      requireAdvancePayment: true,
      minimumAdvancePercent: data.advance_percentage || 25,
      allowDoubleBooking: false,
      bookingCancellationHours: 48,
      defaultBookingDurationHours: 12,
      workingHoursStart: "08:00",
      workingHoursEnd: "23:00",
      workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    },
    invoiceTemplate: data.invoice_template || "classic",
    updatedAt: data.updated_at,
  };
};

/* ============================================================
   GET HALL SETTINGS
   Returns all configuration for the hall
   ============================================================ */
const getHallSettings = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("hall_settings")
      .select("*")
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });

    // Return defaults if no settings row exists yet
    if (!data) {
      return res.json({
        ...formatDbSettingsToFrontend({ hall_id }),
        settings_complete: false,
      });
    }

    res.json({ ...formatDbSettingsToFrontend(data), settings_complete: true });
  } catch (err) {
    console.error("getHallSettings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE HALL SETTINGS
   Full upsert — frontend sends entire settings object
   ============================================================ */
const updateHallSettings = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const settingsFields = mapSettingsBodyToDb(req.body);

    const settingsData = {
      ...settingsFields,
      hall_id,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("hall_settings")
      .upsert(settingsData, { onConflict: "hall_id" })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "settings.updated",
      entity_type: "settings",
      entity_id: hall_id,
      description: "Updated marriage hall settings configurations",
      metadata: { updated_fields: Object.keys(settingsFields) },
    });

    res.json({ message: "Settings saved successfully", data: formatDbSettingsToFrontend(data) });
  } catch (err) {
    console.error("updateHallSettings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE NOTIFICATION PREFERENCES ONLY
   Lightweight endpoint for toggling notifications from frontend
   ============================================================ */
const updateNotificationPreferences = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { whatsapp_notifications, email_notifications } = req.body;

    const updates = { hall_id, updated_at: new Date().toISOString() };
    if (whatsapp_notifications !== undefined) updates.whatsapp_notifications = whatsapp_notifications;
    if (email_notifications !== undefined) updates.email_notifications = email_notifications;

    const { data, error } = await supabaseAdmin
      .from("hall_settings")
      .upsert(updates, { onConflict: "hall_id" })
      .select("whatsapp_notifications, email_notifications")
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Notification preferences updated", data });
  } catch (err) {
    console.error("updateNotificationPreferences error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET HALL SETTINGS (helper for other controllers)
   Used internally by invoice/notification controllers
   ============================================================ */
const getSettingsForHall = async (hall_id) => {
  const { data } = await supabaseAdmin
    .from("hall_settings")
    .select("*")
    .eq("hall_id", hall_id)
    .maybeSingle();

  return data || {
    currency: "INR",
    currency_symbol: "₹",
    invoice_prefix: "INV",
    receipt_prefix: "RCP",
    invoice_footer_note: "Thank you for choosing us!",
    tax_enabled: false,
    tax_percentage: 0,
    tax_label: "GST",
  };
};

module.exports = {
  getHallSettings,
  updateHallSettings,
  updateNotificationPreferences,
  getSettingsForHall,
};