const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  try {
    const { data, error } = await supabaseAdmin.from("enquiries").select("*").limit(1);
    if (error) {
      console.error("Error fetching enquiries:", error);
    } else {
      console.log("Enquiries columns:", Object.keys(data[0] || {}));
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
