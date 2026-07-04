const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  const { data, error } = await supabaseAdmin.from("admin_settings").select("*").limit(1);
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("admin_settings columns:", data.length > 0 ? Object.keys(data[0]) : "No rows");
    console.log("Full data:", data[0]);
  }
}
inspect();
