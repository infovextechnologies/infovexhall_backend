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

async function testQuery(start_date, end_date) {
  try {
    const hall_id = "8626baab-05c7-4293-aacc-6c1b6c24c299"; // Hosanna Hall ID
    let query = supabaseAdmin
      .from("bookings")
      .select("id, event_name, start_date, end_date, status")
      .eq("hall_id", hall_id)
      .neq("status", "cancelled")
      .lt("start_date", end_date)
      .gt("end_date", start_date);

    const { data, error } = await query;
    if (error) {
      console.error("Query Error:", error);
    } else {
      console.log(`Query between ${start_date} and ${end_date} returned ${data.length} conflicts:`, data);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

async function run() {
  console.log("1. Testing range: July 15th (no bookings expected)");
  await testQuery("2026-07-15 00:00:00", "2026-07-15 23:59:59");
  
  console.log("\n2. Testing range: July 5th (within July 3 - July 8 booking)");
  await testQuery("2026-07-05 00:00:00", "2026-07-05 23:59:59");
}

run();
