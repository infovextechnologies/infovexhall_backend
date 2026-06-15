const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  try {
    const { data: halls } = await supabaseAdmin.from("marriage_halls").select("id").limit(1);
    const hallId = halls?.[0]?.id;
    if (!hallId) {
      console.error("No halls found to test with.");
      return;
    }

    const payload = {
      customer_name: "Test Lead",
      phone: "1234567890",
      email: "test@example.com",
      event_type: "wedding",
      expected_date: "2026-06-12",
      guest_count: 150,
      budget_min: 50000,
      budget_max: 100000,
      notes: "Test notes",
      source: "walk_in",
      status: "new",
      priority: "medium",
      address: "123 Street",
      city: "Chennai",
      hall_section: "Main Hall",
      hall_id: hallId
    };

    const { data, error } = await supabaseAdmin.from("enquiries").insert([payload]).select();
    if (error) {
      console.error("Insert error:", error);
    } else {
      console.log("Insert succeeded! Created row ID:", data[0].id);
      // clean up
      await supabaseAdmin.from("enquiries").delete().eq("id", data[0].id);
      console.log("Cleaned up successfully.");
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}
inspect();
