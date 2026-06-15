const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  console.log("--- Fetching all subscriptions ---");
  const { data, error } = await supabaseAdmin
    .from("hall_subscriptions")
    .select("*, marriage_halls(hall_name, status)")
    .order("created_at", { ascending: false });
    
  if (error) {
    console.error("Fetch error:", error);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

inspect();
