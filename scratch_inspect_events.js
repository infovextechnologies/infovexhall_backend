const dotenv = require("dotenv");
const path = require("path");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  try {
    const { data: events, error } = await supabaseAdmin.from("events").select("*");
    if (error) {
      console.error("Events query error:", error);
    } else {
      console.log(`Found ${events.length} events:`);
      events.forEach((ev) => {
        console.log(`ID: ${ev.id}, Title: "${ev.event_title}", Date: ${ev.event_date}, EndDate: ${ev.end_date}, Status: ${ev.status}, BookingID: ${ev.booking_id}, HallID: ${ev.hall_id}`);
      });
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
