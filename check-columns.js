require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { supabaseAdmin } = require("./config/supabase");

async function check() {
  try {
    const { data, error } = await supabaseAdmin
      .from("payments")
      .select("*")
      .limit(1);
      
    if (error) {
      console.error("Error fetching payment:", error);
    } else {
      console.log("Columns in payments table:", Object.keys(data[0] || {}));
    }
  } catch (err) {
    console.error("Crash:", err);
  }
}

check();
