const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  try {
    const { data, error } = await supabaseAdmin.from("enquiries").insert([{}]).select();
    if (error) {
      console.log("Insert empty error:", error);
    } else {
      console.log("Insert empty succeeded. Created row:", data);
      // Clean up
      await supabaseAdmin.from("enquiries").delete().eq("id", data[0].id);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

inspect();
