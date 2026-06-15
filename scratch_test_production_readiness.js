const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

const EXPECTED_SETTINGS_COLUMNS = [
  "invoice_prefix",
  "booking_prefix",
  "receipt_prefix",
  "invoice_start_number",
  "booking_start_number",
  "currency",
  "currency_symbol",
  "date_format",
  "time_format",
  "timezone",
  "tax_enabled",
  "tax_percentage",
  "tax_label",
  "gst_applicable_on",
  "auto_invoice",
  "invoice_footer_note",
  "terms_and_conditions",
  "notifications",
  "booking_settings",
  "email_notifications",
  "whatsapp_notifications",
  "advance_percentage"
];

const EXPECTED_PROFILE_COLUMNS = [
  "hall_name",
  "owner_name",
  "phone",
  "alternate_phone",
  "email",
  "website",
  "address",
  "city",
  "state",
  "pincode",
  "country",
  "description",
  "established_year",
  "total_capacity",
  "logo_url",
  "cover_image_url",
  "gst_number",
  "pan_number",
  "bank_name",
  "account_number",
  "ifsc_code",
  "upi_id",
  "hall_sections"
];

async function verify() {
  console.log("=== DB Production Readiness Verification ===");

  // 1. Inspect settings
  const { data: settings, error: settingsErr } = await supabaseAdmin.from("hall_settings").select("*").limit(1);
  if (settingsErr) {
    console.error("❌ Error fetching settings:", settingsErr.message);
  } else {
    const existing = Object.keys(settings?.[0] || {});
    if (existing.length === 0) {
      console.log("ℹ️ No settings row exists yet (we'll look at table schema cache if possible).");
    }
    const missing = EXPECTED_SETTINGS_COLUMNS.filter(c => !existing.includes(c));
    if (missing.length > 0) {
      console.log("❌ Missing settings columns:", missing);
    } else {
      console.log("✅ All settings columns are present!");
    }
  }

  // 2. Inspect profile
  const { data: profiles, error: profileErr } = await supabaseAdmin.from("hall_profiles").select("*").limit(1);
  if (profileErr) {
    console.error("❌ Error fetching profiles:", profileErr.message);
  } else {
    const existing = Object.keys(profiles?.[0] || {});
    const missing = EXPECTED_PROFILE_COLUMNS.filter(c => !existing.includes(c));
    if (missing.length > 0) {
      console.log("❌ Missing profile columns:", missing);
    } else {
      console.log("✅ All profile columns are present!");
    }
  }
}

verify();
