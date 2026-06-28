const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  try {
    const { data, error } = await supabaseAdmin.from("enquiry_followups").select("*").limit(1);
    if (error) {
      console.error("Query error:", error);
    } else {
      console.log("enquiry_followups columns:", data.length > 0 ? Object.keys(data[0]) : "Table empty");
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
