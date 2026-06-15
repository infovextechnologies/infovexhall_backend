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
    const { data: users, error: usersError } = await supabaseAdmin.from("users").select("*");
    if (usersError) {
      console.error("Users query error:", usersError);
    } else {
      console.log("Users in DB:", users);
    }

    const { data: userHalls, error: userHallsError } = await supabaseAdmin.from("user_halls").select("*");
    if (userHallsError) {
      console.error("UserHalls query error:", userHallsError);
    } else {
      console.log("UserHalls in DB:", userHalls);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
