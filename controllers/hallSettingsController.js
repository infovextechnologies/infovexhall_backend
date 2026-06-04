const { supabaseAdmin } = require("../config/supabase");

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
        hall_id,
        currency: "INR",
        currency_symbol: "₹",
        date_format: "DD/MM/YYYY",
        time_format: "12h",
        advance_percentage: 25,
        cancellation_policy: "",
        booking_terms: "",
        invoice_prefix: "INV",
        receipt_prefix: "RCP",
        invoice_footer_note: "Thank you for choosing us!",
        tax_enabled: false,
        tax_percentage: 0,
        tax_label: "GST",
        whatsapp_notifications: false,
        email_notifications: true,
        booking_confirmation_message: "Your booking has been confirmed. We look forward to hosting your event.",
        payment_reminder_message: "Friendly reminder: a payment is pending for your upcoming event.",
        settings_complete: false,
      });
    }

    res.json({ ...data, settings_complete: true });
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

    const {
      currency,
      currency_symbol,
      date_format,
      time_format,
      advance_percentage,
      cancellation_policy,
      booking_terms,
      invoice_prefix,
      receipt_prefix,
      invoice_footer_note,
      tax_enabled,
      tax_percentage,
      tax_label,
      whatsapp_notifications,
      email_notifications,
      booking_confirmation_message,
      payment_reminder_message,
    } = req.body;

    // Validate advance percentage range
    if (advance_percentage !== undefined) {
      if (advance_percentage < 0 || advance_percentage > 100) {
        return res.status(400).json({ message: "advance_percentage must be between 0 and 100" });
      }
    }

    // Validate tax percentage range
    if (tax_percentage !== undefined) {
      if (tax_percentage < 0 || tax_percentage > 100) {
        return res.status(400).json({ message: "tax_percentage must be between 0 and 100" });
      }
    }

    const settingsData = {
      hall_id,
      currency,
      currency_symbol,
      date_format,
      time_format,
      advance_percentage,
      cancellation_policy,
      booking_terms,
      invoice_prefix,
      receipt_prefix,
      invoice_footer_note,
      tax_enabled,
      tax_percentage,
      tax_label,
      whatsapp_notifications,
      email_notifications,
      booking_confirmation_message,
      payment_reminder_message,
      updated_at: new Date().toISOString(),
    };

    // Remove undefined keys
    Object.keys(settingsData).forEach(
      (k) => settingsData[k] === undefined && delete settingsData[k]
    );

    const { data, error } = await supabaseAdmin
      .from("hall_settings")
      .upsert(settingsData, { onConflict: "hall_id" })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Settings saved successfully", data });
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