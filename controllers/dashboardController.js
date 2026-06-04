const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   HALL OWNER DASHBOARD
   Returns: bookings summary, revenue, upcoming events, recent activity
   ============================================================ */
const getDashboard = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const today = new Date().toISOString().split("T")[0];
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString().split("T")[0];

    // Run all queries in parallel
    const [
      bookingsResult,
      paymentsResult,
      customersResult,
      upcomingResult,
      recentBookingsResult,
      subscriptionResult,
    ] = await Promise.all([
      supabaseAdmin.from("bookings").select("id, status, total_amount").eq("hall_id", hall_id),
      supabaseAdmin.from("payments").select("amount, payment_date").eq("hall_id", hall_id),
      supabaseAdmin.from("customers").select("id", { count: "exact", head: true }).eq("hall_id", hall_id),
      supabaseAdmin.from("events")
        .select(`*, bookings(event_name, status, customers(customer_name, phone))`)
        .eq("hall_id", hall_id)
        .gte("event_date", today)
        .order("event_date", { ascending: true })
        .limit(5),
      supabaseAdmin.from("bookings")
        .select(`*, customers(customer_name, phone)`)
        .eq("hall_id", hall_id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabaseAdmin.from("hall_subscriptions")
        .select("status, end_date, packages(name, max_users, max_bookings)")
        .eq("hall_id", hall_id)
        .eq("status", "active")
        .gte("end_date", today)
        .maybeSingle(),
    ]);

    const bookings = bookingsResult.data || [];
    const payments = paymentsResult.data || [];

    // Booking stats
    const totalBookings = bookings.length;
    const confirmedBookings = bookings.filter((b) => b.status === "confirmed").length;
    const completedBookings = bookings.filter((b) => b.status === "completed").length;
    const cancelledBookings = bookings.filter((b) => b.status === "cancelled").length;

    // Revenue stats
    const totalRevenue = bookings.reduce((s, b) => s + (b.total_amount || 0), 0);
    const totalCollected = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const thisMonthRevenue = payments
      .filter((p) => p.payment_date >= firstOfMonth)
      .reduce((s, p) => s + (p.amount || 0), 0);

    // Days until subscription expiry
    let daysUntilExpiry = null;
    if (subscriptionResult.data?.end_date) {
      const expiry = new Date(subscriptionResult.data.end_date);
      const now = new Date();
      daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    }

    res.json({
      summary: {
        total_bookings: totalBookings,
        confirmed_bookings: confirmedBookings,
        completed_bookings: completedBookings,
        cancelled_bookings: cancelledBookings,
        total_customers: customersResult.count || 0,
      },
      revenue: {
        total_revenue: totalRevenue,
        total_collected: totalCollected,
        total_pending: totalRevenue - totalCollected,
        this_month: thisMonthRevenue,
      },
      upcoming_events: upcomingResult.data || [],
      recent_bookings: recentBookingsResult.data || [],
      subscription: subscriptionResult.data
        ? {
            status: subscriptionResult.data.status,
            end_date: subscriptionResult.data.end_date,
            days_until_expiry: daysUntilExpiry,
            plan: subscriptionResult.data.packages?.name,
            max_users: subscriptionResult.data.packages?.max_users,
            max_bookings: subscriptionResult.data.packages?.max_bookings,
          }
        : null,
    });
  } catch (err) {
    console.error("getDashboard error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getDashboard };