const { supabaseAdmin } = require("../config/supabase");

/*
  Activity log tracks every meaningful action in the system.
  Used for audit trail, debugging, and owner oversight.

  Actions tracked:
  - booking.created / booking.updated / booking.cancelled
  - payment.added / payment.deleted
  - customer.created / customer.updated / customer.deleted
  - enquiry.created / enquiry.status_changed / enquiry.converted
  - staff.added / staff.removed / staff.role_changed
  - vendor.created / vendor.updated / vendor.deleted
  - invoice.created
  - settings.updated / profile.updated
*/

/* ============================================================
   LOG ACTION (internal helper — called from other controllers)
   ============================================================ */
const logActivity = async ({
  hall_id,
  user_id,
  user_name,
  action,         // e.g. "booking.created"
  entity_type,    // e.g. "booking"
  entity_id,      // UUID of the record
  description,    // human-readable e.g. "Created booking for Ramesh Wedding"
  metadata,       // optional object with extra context
}) => {
  try {
    await supabaseAdmin.from("activity_logs").insert([{
      hall_id,
      user_id,
      user_name,
      action,
      entity_type,
      entity_id,
      description,
      metadata: metadata || {},
    }]);
  } catch (err) {
    console.error("logActivity helper error:", err);
    // Non-critical — never throw
  }
};

/* ============================================================
   GET ACTIVITY LOGS
   ============================================================ */
const getActivityLogs = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const {
      entity_type,
      entity_id,
      user_id,
      action,
      from_date,
      to_date,
      page = 1,
      limit = 30,
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("activity_logs")
      .select("*, users(name)", { count: "exact" })
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (entity_type) query = query.eq("entity_type", entity_type);
    if (entity_id) query = query.eq("entity_id", entity_id);
    if (user_id) query = query.eq("user_id", user_id);
    if (action) query = query.ilike("action", `%${action}%`);
    if (from_date) query = query.gte("created_at", from_date);
    if (to_date) query = query.lte("created_at", to_date + "T23:59:59");

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const enriched = (data || []).map(act => ({
      ...act,
      user_name: act.users?.name || "System"
    }));

    res.json({
      data: enriched,
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getActivityLogs error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ACTIVITY LOGS FOR A SPECIFIC ENTITY
   e.g. GET /activity-logs/booking/:id — all actions on one booking
   ============================================================ */
const getEntityLogs = async (req, res) => {
  try {
    const { entity_type, entity_id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("activity_logs")
      .select("*")
      .eq("hall_id", hall_id)
      .eq("entity_type", entity_type)
      .eq("entity_id", entity_id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });

    res.json(data);
  } catch (err) {
    console.error("getEntityLogs error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET RECENT ACTIVITY (dashboard widget)
   Last 20 actions across all entities
   ============================================================ */
const getRecentActivity = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { limit = 20 } = req.query;

    const { data, error } = await supabaseAdmin
      .from("activity_logs")
      .select("id, action, entity_type, entity_id, description, created_at, users(name)")
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (error) return res.status(500).json({ message: error.message });

    const enriched = (data || []).map(act => ({
      id: act.id,
      action: act.action,
      entity_type: act.entity_type,
      entity_id: act.entity_id,
      description: act.description,
      created_at: act.created_at,
      user_name: act.users?.name || "System"
    }));

    res.json(enriched);
  } catch (err) {
    console.error("getRecentActivity error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ACTIVITY SUMMARY (for admin / owner overview)
   Count of actions per type in last N days
   ============================================================ */
const getActivitySummary = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { days = 30 } = req.query;

    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));

    const { data, error } = await supabaseAdmin
      .from("activity_logs")
      .select("action, created_at, users(name)")
      .eq("hall_id", hall_id)
      .gte("created_at", since.toISOString());

    if (error) return res.status(500).json({ message: error.message });

    // Group by action
    const byAction = (data || []).reduce((acc, log) => {
      acc[log.action] = (acc[log.action] || 0) + 1;
      return acc;
    }, {});

    // Group by user
    const byUser = (data || []).reduce((acc, log) => {
      const userName = log.users?.name || "System";
      acc[userName] = (acc[userName] || 0) + 1;
      return acc;
    }, {});

    // Daily counts for sparkline
    const byDay = data.reduce((acc, log) => {
      const day = log.created_at.split("T")[0];
      acc[day] = (acc[day] || 0) + 1;
      return acc;
    }, {});

    res.json({
      total_actions: data.length,
      period_days: parseInt(days),
      by_action: byAction,
      by_user: byUser,
      by_day: byDay,
    });
  } catch (err) {
    console.error("getActivitySummary error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  logActivity,
  getActivityLogs,
  getEntityLogs,
  getRecentActivity,
  getActivitySummary,
};