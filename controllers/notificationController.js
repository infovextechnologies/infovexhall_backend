const { supabaseAdmin } = require("../config/supabase");
const { getLocalDate } = require("../utils/dateHelper");

/*
  Notification types used across the system:
  - booking_created       New booking confirmed
  - booking_cancelled     Booking was cancelled
  - payment_received      Payment recorded
  - payment_pending       Balance still unpaid
  - event_tomorrow        Event happening tomorrow
  - subscription_expiring Subscription expires in ≤7 days
  - enquiry_new           New enquiry submitted
  - followup_due          Followup is overdue
*/

/* ============================================================
   CREATE NOTIFICATION (internal helper, used by other controllers)
   ============================================================ */
const createNotification = async ({ hall_id, type, title, message, entity_type, entity_id }) => {
  try {
    const { data, error } = await supabaseAdmin.from("notifications").insert([{
      hall_id,
      type,
      title,
      message,
      entity_type,   // "booking" | "payment" | "enquiry" | "subscription"
      entity_id,     // UUID of the related record
      is_read: false,
    }]);
    if (error) {
      console.error("createNotification DB error:", error);
    }
  } catch (err) {
    console.error("createNotification helper error:", err);
    // Non-critical — never throw from here
  }
};

/* ============================================================
   GET NOTIFICATIONS
   ============================================================ */
const getNotifications = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";
    const { is_read, type, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;

    // Automatically generate billing reminders for owners dynamically when retrieving notifications
    if (!isSuperAdmin && hall_id) {
      try {
        const todayStr = getLocalDate();
        // Fetch active/trial subscription for this hall
        const { data: activeSub } = await supabaseAdmin
          .from("hall_subscriptions")
          .select("id, status, end_date, packages(name)")
          .eq("hall_id", hall_id)
          .in("status", ["active", "trial"])
          .gte("end_date", todayStr)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (activeSub && activeSub.end_date) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const [yr, mo, dy] = activeSub.end_date.split("-").map(Number);
          const endDate = new Date(yr, mo - 1, dy);
          endDate.setHours(0, 0, 0, 0);

          const diffTime = endDate.getTime() - today.getTime();
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          // Check if we hit exactly 7, 3, or 1 days
          if ([7, 3, 1].includes(diffDays)) {
            const dateStr = new Date(activeSub.end_date).toLocaleDateString('en-GB');
            const message = diffDays === 1 
              ? `Your ${activeSub.packages?.name || "current"} subscription renews tomorrow (${dateStr}). 1 day remaining.`
              : `Your ${activeSub.packages?.name || "current"} subscription renews on ${dateStr}. ${diffDays} days remaining.`;

            // Check if notification already exists for this subscription and day threshold
            const { count: exists } = await supabaseAdmin
              .from("notifications")
              .select("id", { count: "exact", head: true })
              .eq("hall_id", hall_id)
              .eq("type", "subscription_expiring")
              .eq("entity_id", activeSub.id)
              .like("message", `%${diffDays} day%`);

            if (!exists || exists === 0) {
              await createNotification({
                hall_id,
                type: "subscription_expiring",
                title: "Subscription expiring soon",
                message,
                entity_type: "subscription",
                entity_id: activeSub.id,
              });
            }
          }
        }
      } catch (err) {
        console.error("Billing reminder dynamic generation error:", err);
      }
    }

    let query = supabaseAdmin
      .from("notifications")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    if (is_read !== undefined) query = query.eq("is_read", is_read === "true");
    if (type) query = query.eq("type", type);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    // Optimize: query the true table-wide unread count for the badge
    let unreadQuery = supabaseAdmin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);

    if (isSuperAdmin) {
      unreadQuery = unreadQuery.is("hall_id", null);
    } else {
      unreadQuery = unreadQuery.eq("hall_id", hall_id);
    }
    const { count: totalUnread } = await unreadQuery;

    res.json({
      data,
      unread_count: totalUnread || 0,
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getNotifications error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET UNREAD COUNT (lightweight — for notification badge)
   ============================================================ */
const getUnreadCount = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";

    let query = supabaseAdmin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    const { count, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    res.json({ unread_count: count || 0 });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   MARK NOTIFICATION AS READ
   ============================================================ */
const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";

    let query = supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("id", id);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    const { data: existing, error: fetchErr } = await query.maybeSingle();
    if (fetchErr) return res.status(500).json({ message: fetchErr.message });
    if (!existing) return res.status(404).json({ message: "Notification not found" });

    const { error } = await supabaseAdmin
      .from("notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error("markAsRead error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   MARK ALL AS READ
   ============================================================ */
const markAllAsRead = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";

    let query = supabaseAdmin
      .from("notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("is_read", false);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    const { error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("markAllAsRead error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE NOTIFICATION
   ============================================================ */
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";

    let query = supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("id", id);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    const { data: existing, error: fetchErr } = await query.maybeSingle();
    if (fetchErr) return res.status(500).json({ message: fetchErr.message });
    if (!existing) return res.status(404).json({ message: "Notification not found" });

    await supabaseAdmin.from("notifications").delete().eq("id", id);
    res.json({ message: "Notification deleted" });
  } catch (err) {
    console.error("deleteNotification error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE ALL READ NOTIFICATIONS
   ============================================================ */
const clearReadNotifications = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const isSuperAdmin = req.user.role === "super_admin";

    let query = supabaseAdmin
      .from("notifications")
      .delete()
      .eq("is_read", true);

    if (isSuperAdmin) {
      query = query.is("hall_id", null);
    } else {
      query = query.eq("hall_id", hall_id);
    }

    const { error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Read notifications cleared" });
  } catch (err) {
    console.error("clearReadNotifications error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GENERATE SYSTEM NOTIFICATIONS
   Run this on a cron/scheduled job (e.g. daily at 8am)
   Or call it from a Supabase Edge Function
   ============================================================ */
const generateSystemNotifications = async (req, res) => {
  try {
    const today = new Date();
    const todayStr = getLocalDate(today);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = getLocalDate(tomorrow);

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(today.getDate() + 7);
    const sevenDaysStr = getLocalDate(sevenDaysLater);

    let generated = 0;

    // ---- 1. Events happening tomorrow ----
    const { data: tomorrowEvents } = await supabaseAdmin
      .from("events")
      .select(`
        id, hall_id, event_title, event_date,
        bookings ( id, customers ( customer_name ) )
      `)
      .eq("event_date", tomorrowStr);

    for (const event of tomorrowEvents || []) {
      const customerName = event.bookings?.customers?.customer_name || "Customer";
      await createNotification({
        hall_id: event.hall_id,
        type: "event_tomorrow",
        title: "Event tomorrow",
        message: `${event.event_title} for ${customerName} is scheduled for tomorrow.`,
        entity_type: "booking",
        entity_id: event.bookings?.id,
      });
      generated++;
    }

    // ---- 2. Subscriptions expiring within 7 days (specifically on 7, 3, and 1 days remaining) ----
    const { data: expiringSubs } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("id, hall_id, end_date, packages(name)")
      .in("status", ["active", "trial"])
      .gte("end_date", todayStr)
      .lte("end_date", sevenDaysStr);

    for (const sub of expiringSubs || []) {
      const days = Math.ceil(
        (new Date(sub.end_date) - today) / (1000 * 60 * 60 * 24)
      );
      
      if ([7, 3, 1].includes(days)) {
        const dateStr = new Date(sub.end_date).toLocaleDateString('en-GB');
        const message = days === 1 
          ? `Your ${sub.packages?.name || "current"} subscription renews tomorrow (${dateStr}). 1 day remaining.`
          : `Your ${sub.packages?.name || "current"} subscription renews on ${dateStr}. ${days} days remaining.`;

        // Check if exists
        const { count: exists } = await supabaseAdmin
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("hall_id", sub.hall_id)
          .eq("type", "subscription_expiring")
          .eq("entity_id", sub.id)
          .like("message", `%${days} day%`);

        if (!exists || exists === 0) {
          await createNotification({
            hall_id: sub.hall_id,
            type: "subscription_expiring",
            title: "Subscription expiring soon",
            message,
            entity_type: "subscription",
            entity_id: sub.id,
          });
          generated++;
        }
      }
    }

    const { data: bookingsWithBalance } = await supabaseAdmin
      .from("bookings")
      .select(`id, hall_id, event_name, total_amount, start_date, customers(customer_name), payments(amount)`)
      .in("status", ["confirmed", "reserved"])
      .gte("start_date", todayStr)
      .lte("start_date", sevenDaysStr);
 
    for (const bk of bookingsWithBalance || []) {
      const paid = (bk.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
      const balance = (bk.total_amount || 0) - paid;
      if (balance > 0) {
        await createNotification({
          hall_id: bk.hall_id,
          type: "payment_pending",
          title: "Payment pending",
          message: `₹${balance.toLocaleString("en-IN")} pending for ${bk.event_name || "event"} on ${bk.start_date}.`,
          entity_type: "booking",
          entity_id: bk.id,
        });
        generated++;
      }
    }

    // ---- 4. Overdue followups ----
    const { data: overdueFollowups } = await supabaseAdmin
      .from("enquiry_followups")
      .select(`id, hall_id, enquiry_id, enquiries(customer_name)`)
      .eq("status", "pending")
      .lt("followup_date", todayStr);

    const hallFollowupCounts = {};
    for (const f of overdueFollowups || []) {
      hallFollowupCounts[f.hall_id] = (hallFollowupCounts[f.hall_id] || 0) + 1;
    }

    for (const [hall_id, count] of Object.entries(hallFollowupCounts)) {
      await createNotification({
        hall_id,
        type: "followup_due",
        title: `${count} overdue followup${count !== 1 ? "s" : ""}`,
        message: `You have ${count} enquiry followup${count !== 1 ? "s" : ""} that ${count !== 1 ? "are" : "is"} overdue.`,
        entity_type: "enquiry",
        entity_id: null,
      });
      generated++;
    }

    res.json({ message: `Generated ${generated} notifications`, generated });
  } catch (err) {
    console.error("generateSystemNotifications error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearReadNotifications,
  generateSystemNotifications,
};