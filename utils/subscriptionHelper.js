const { supabaseAdmin } = require("../config/supabase");

async function syncExpiredSubscriptions() {
  try {
    const today = new Date().toISOString().split("T")[0];
    
    // Update any active or trial subscription whose end_date is in the past to "expired"
    const { error } = await supabaseAdmin
      .from("hall_subscriptions")
      .update({ status: "expired" })
      .in("status", ["active", "trial"])
      .lt("end_date", today);
      
    if (error) {
      console.error("Error syncing expired subscriptions:", error);
    }
  } catch (err) {
    console.error("Exception in syncExpiredSubscriptions:", err);
  }
}

module.exports = { syncExpiredSubscriptions };
