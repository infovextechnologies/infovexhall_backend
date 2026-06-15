const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspectViaQuery() {
  const { data: halls, error: hallErr } = await supabaseAdmin.from("marriage_halls").select("id").limit(1);
  if (hallErr) {
    console.error("Hall fetch error:", hallErr);
    return;
  }
  const hallId = halls?.[0]?.id;
  if (!hallId) {
    console.error("No halls found in DB to use for inspection.");
    return;
  }

  const { data, error } = await supabaseAdmin.from("enquiries").insert([{
    customer_name: "TEMP",
    phone: "9999999999",
    hall_id: hallId
  }]).select();

  if (error) {
    console.error("Error inserting temp:", error);
  } else {
    console.log("Temp row columns:", Object.keys(data[0]));
    // Clean up
    await supabaseAdmin.from("enquiries").delete().eq("id", data[0].id);
  }
}

inspectViaQuery();
