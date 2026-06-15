const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function testJoin() {
  try {
    const { data, error } = await supabaseAdmin
      .from("enquiries")
      .select(`
        id,
        assigned_to,
        assignee:users(id, name, email)
      `)
      .limit(1);

    if (error) {
      console.error("Join error:", error);
    } else {
      console.log("Join success! Data:", data);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

testJoin();
