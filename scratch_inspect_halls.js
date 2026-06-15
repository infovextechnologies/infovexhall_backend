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
    const { data: halls, error: hallsError } = await supabaseAdmin.from("marriage_halls").select("*");
    if (hallsError) {
      console.error("Halls query error:", hallsError);
    } else {
      console.log("Halls in DB:", halls);
    }

    const { data: profiles, error: profilesError } = await supabaseAdmin.from("hall_profiles").select("*");
    if (profilesError) {
      console.error("Profiles query error:", profilesError);
    } else {
      console.log("Profiles in DB:", profiles);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
