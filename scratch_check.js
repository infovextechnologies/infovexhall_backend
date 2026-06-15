require("dotenv").config();
const { supabaseAdmin } = require("./config/supabase");

async function run() {
  console.log("Checking invoices table columns...");
  const { data, error } = await supabaseAdmin
    .from("invoices")
    .select("*")
    .limit(1);

  if (error) {
    console.error("Database query failed:", error);
  } else {
    console.log("Success! Columns present:", data.length > 0 ? Object.keys(data[0]) : "Table is empty, trying mockup insert...");
    
    // Attempt mockup insert to check for schema cache / validation errors
    const { data: insertData, error: insertError } = await supabaseAdmin
      .from("invoices")
      .insert([{
        invoice_number: "TEST-MOCK-9999",
        status: "unpaid"
      }])
      .select();
      
    if (insertError) {
      console.error("Mock insert failed with error:", insertError.message);
    } else {
      console.log("Mock insert succeeded!", insertData);
      // Clean up mock row
      await supabaseAdmin.from("invoices").delete().eq("invoice_number", "TEST-MOCK-9999");
    }
  }
  process.exit(0);
}

run();
