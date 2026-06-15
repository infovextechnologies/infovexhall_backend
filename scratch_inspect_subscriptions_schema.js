const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function test() {
  console.log("--- Inspecting hall_subscriptions columns ---");
  const { data, error } = await supabaseAdmin.from("hall_subscriptions").select("*").limit(1);
  if (error) {
    console.error("Fetch error:", error);
  } else {
    console.log("Columns:", Object.keys(data[0] || {}));
  }

  // Try insert a subscription row for the secondary hall
  const secondaryId = '173408aa-878e-4fae-88f6-69af71973cb7';
  const packageId = 'aaedca45-e0d9-4a66-b908-a1ade0661e39';
  const today = new Date().toISOString().split("T")[0];

  console.log("\n--- Testing insert of shared subscription ---");
  const { data: insData, error: insError } = await supabaseAdmin.from("hall_subscriptions").insert([{
    hall_id: secondaryId,
    package_id: packageId,
    status: "active",
    payment_status: "paid",
    end_date: '2027-05-19',
    start_date: today
  }]).select();

  if (insError) {
    console.error("Insert failed:", insError);
  } else {
    console.log("Insert success! Row:", insData);
  }
}

test();
