const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

const validHallId = '64f8be35-e919-4987-94ed-d3b57d9921d4'; // AJAY MARRIAGE HALL

async function testInsert() {
  console.log("--- Testing notification insert for a valid hall ID ---");
  const { data, error } = await supabaseAdmin.from("notifications").insert([{
    hall_id: validHallId,
    type: "booking_created",
    title: "Test Notification",
    message: "A test notification for a valid hall ID",
    is_read: false
  }]).select();

  if (error) {
    console.error("Insert error:", error);
  } else {
    console.log("Insert success:", data);
  }
}

testInsert();
