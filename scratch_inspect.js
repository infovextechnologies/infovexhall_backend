require("dotenv").config();
const { supabaseAdmin } = require('./config/supabase');

async function checkColumns() {
  try {
    const { data, error } = await supabaseAdmin
      .from('hall_settings')
      .select('*');
    
    if (error) {
      console.error("Supabase query error:", error);
    } else {
      console.log("Total settings rows:", data?.length);
      if (data && data.length > 0) {
        console.log("Keys in DB row:", Object.keys(data[0]));
        console.log("invoice_template value of first row:", data[0].invoice_template);
      }
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

checkColumns();
