const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   GET ALL MUHURTHAM DATES
   Supports date-range queries: from_date and to_date
   ============================================================ */
const getMuhurthams = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;

    let query = supabaseAdmin
      .from("muhurtham_dates")
      .select("*")
      .order("date", { ascending: true });

    if (from_date && to_date) {
      query = query.gte("date", from_date).lte("date", to_date);
    } else if (from_date) {
      query = query.gte("date", from_date);
    } else if (to_date) {
      query = query.lte("date", to_date);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ message: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("getMuhurthams error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   ADD MUHURTHAM DATE (Super Admin only)
   ============================================================ */
const addMuhurtham = async (req, res) => {
  try {
    const { date, title, notes } = req.body;

    if (!date) {
      return res.status(400).json({ message: "date parameter is required" });
    }

    // Verify requesting user is super admin
    const { data: adminCheck } = await supabaseAdmin
      .from("super_admins")
      .select("id")
      .eq("auth_user_id", req.user.auth_user_id || req.user.id)
      .maybeSingle();

    if (!adminCheck && req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Forbidden: Super Admin access required" });
    }

    const { data, error } = await supabaseAdmin
      .from("muhurtham_dates")
      .insert([{ date, title: title || "Auspicious Muhurtham Date", notes }])
      .select()
      .single();

    if (error) {
      // Handle unique constraint conflict (date already exists)
      if (error.code === "23505") {
        return res.status(409).json({ message: "This date is already marked as a Muhurtham date" });
      }
      return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: "Muhurtham date added successfully", data });
  } catch (err) {
    console.error("addMuhurtham error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getMuhurthams,
  addMuhurtham,
};
