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
    const { data, error } = await supabaseAdmin.from("enquiry_followups").select("*").limit(1);

    if (error) {
      console.error("Query error:", error);
    } else {
      console.log("Followup columns in DB:", Object.keys(data[0] || {}));
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
