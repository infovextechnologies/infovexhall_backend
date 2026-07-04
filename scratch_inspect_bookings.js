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
    const { data: bookings, error } = await supabaseAdmin.from("bookings").select("*");
    if (error) {
      console.error("Bookings query error:", error);
    } else {
      console.log(`Found ${bookings.length} bookings:`);
      bookings.forEach((bk) => {
        console.log(`ID: ${bk.id}, EventName: "${bk.event_name}", Start: ${bk.start_date}, End: ${bk.end_date}, Status: ${bk.status}, HallID: ${bk.hall_id}`);
      });
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
