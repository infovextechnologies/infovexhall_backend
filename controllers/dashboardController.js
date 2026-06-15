const { supabaseAdmin } = require("../config/supabase");

const isSubscriptionValid = async (userId, hallId, primaryHallId) => {
  const today = new Date().toISOString().split("T")[0];
  const targetHallId = primaryHallId || hallId;
  
  if (!targetHallId || targetHallId === "all") {
    const targetHallIdReal = primaryHallId;
    if (!targetHallIdReal) return false;
    
    const [subRes, hallRes] = await Promise.all([
      supabaseAdmin.from("hall_subscriptions")
        .select("status, end_date")
        .eq("hall_id", targetHallIdReal)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin.from("marriage_halls")
        .select("status")
        .eq("id", targetHallIdReal)
        .maybeSingle()
    ]);
    
    if (hallRes.data?.status === "suspended") return false;
    return subRes.data && ["active", "trial"].includes(subRes.data.status) && subRes.data.end_date >= today;
  }
  
  const [subRes, hallRes] = await Promise.all([
    supabaseAdmin.from("hall_subscriptions")
      .select("status, end_date")
      .eq("hall_id", targetHallId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from("marriage_halls")
      .select("status")
      .eq("id", targetHallId)
      .maybeSingle()
  ]);

  if (hallRes.data?.status === "suspended") return false;
  return subRes.data && ["active", "trial"].includes(subRes.data.status) && subRes.data.end_date >= today;
};

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

    let hallIds = [hall_id];
    let subscriptionHallId = req.user.primary_hall_id || hall_id;

    if (hall_id === "all") {
      const { data: userHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      hallIds = (userHalls || []).map((uh) => uh.hall_id);
      if (hallIds.length === 0) {
        hallIds = [req.user.primary_hall_id];
      }
      subscriptionHallId = req.user.primary_hall_id;
    }

    // Run all queries in parallel
    const [
      bookingsResult,
      paymentsResult,
      customersResult,
      upcomingResult,
      recentBookingsResult,
      subscriptionResult,
      enquiriesResult,
    ] = await Promise.all([
      supabaseAdmin.from("bookings").select("id, status, total_amount, event_type, created_at").in("hall_id", hallIds),
      supabaseAdmin.from("payments").select("amount, payment_date").in("hall_id", hallIds),
      supabaseAdmin.from("customers").select("id, created_at").in("hall_id", hallIds),
      supabaseAdmin.from("events")
        .select(`*, bookings(event_name, status, customers(customer_name, phone))`)
        .in("hall_id", hallIds)
        .gte("event_date", today)
        .order("event_date", { ascending: true })
        .limit(5),
      supabaseAdmin.from("bookings")
        .select(`*, customers(customer_name, phone)`)
        .in("hall_id", hallIds)
        .order("created_at", { ascending: false })
        .limit(5),
      supabaseAdmin.from("hall_subscriptions")
        .select("status, end_date, package_id, packages(name, max_users, max_bookings)")
        .eq("hall_id", subscriptionHallId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin.from("enquiries").select("id, status, created_at, source").in("hall_id", hallIds),
    ]);

    const bookings = bookingsResult.data || [];
    const payments = paymentsResult.data || [];
    const enquiries = enquiriesResult.data || [];

    const latestSub = subscriptionResult.data;
    
    // Check if the hall itself is suspended
    const { data: hallData } = await supabaseAdmin
      .from("marriage_halls")
      .select("status")
      .eq("id", subscriptionHallId)
      .maybeSingle();
    const isHallSuspended = hallData?.status === "suspended";
    
    const isSubActive = latestSub && ["active", "trial"].includes(latestSub.status) && latestSub.end_date >= today;

    if (!isSubActive || isHallSuspended) {
      let daysUntilExpiry = null;
      if (latestSub?.end_date) {
        const expiry = new Date(latestSub.end_date);
        const now = new Date();
        daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      }

      return res.json({
        summary: {
          total_bookings: 0,
          confirmed_bookings: 0,
          completed_bookings: 0,
          cancelled_bookings: 0,
          total_customers: 0,
          total_enquiries: 0,
          active_enquiries: 0,
        },
        revenue: {
          total_revenue: 0,
          total_collected: 0,
          total_pending: 0,
          this_month: 0,
        },
        analytics: {
          enquiry_conversion_rate: 0,
          avg_order_value: 0,
          collection_rate: 0,
          growth_rate: 0,
          event_distribution: [],
          enquiry_funnel: [],
        },
        upcoming_events: [],
        recent_bookings: [],
        subscription: latestSub
          ? {
              status: isHallSuspended ? "suspended" : (latestSub.end_date < today ? "expired" : latestSub.status),
              end_date: latestSub.end_date,
              days_until_expiry: daysUntilExpiry,
              plan: latestSub.packages?.name,
              max_users: latestSub.packages?.max_users,
              max_bookings: latestSub.packages?.max_bookings,
              package_id: latestSub.package_id,
            }
          : {
              status: "expired",
              end_date: null,
              days_until_expiry: null,
              plan: "No Subscription",
              max_users: 0,
              max_bookings: 0,
            },
      });
    }

    // Booking stats
    const totalBookings = bookings.length;
    const confirmedBookings = bookings.filter((b) => b.status === "confirmed").length;
    const completedBookings = bookings.filter((b) => b.status === "completed").length;
    const cancelledBookings = bookings.filter((b) => b.status === "cancelled").length;

    // Revenue stats
    const completedPayments = payments;
    const totalRevenue = bookings.reduce((s, b) => s + (b.total_amount || 0), 0);
    const totalCollected = completedPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const thisMonthRevenue = completedPayments
      .filter((p) => p.payment_date >= firstOfMonth)
      .reduce((s, p) => s + (p.amount || 0), 0);

    // Days until subscription expiry
    let daysUntilExpiry = null;
    if (subscriptionResult.data?.end_date) {
      const expiry = new Date(subscriptionResult.data.end_date);
      const now = new Date();
      daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    }

    // 1. Calculate Enquiry Conversion Rate
    const totalEnq = enquiries.length;
    const bookedEnq = enquiries.filter(e => e.status === "booked").length;
    const enquiryConversionRate = totalEnq > 0 ? parseFloat(((bookedEnq / totalEnq) * 100).toFixed(1)) : 0;
    const totalEnquiries = totalEnq;
    const activeEnquiries = enquiries.filter(e => !["booked", "lost"].includes(e.status)).length;

    // 2. Calculate Avg. Order Value
    const activeBookings = bookings.filter(b => b.status !== "cancelled");
    const avgOrderValue = activeBookings.length > 0 ? Math.round(totalRevenue / activeBookings.length) : 0;

    // 3. Calculate Collection Rate
    const collectionRate = totalRevenue > 0 ? parseFloat(((totalCollected / totalRevenue) * 100).toFixed(1)) : 0;

    // 4. Calculate Growth Rate MoM (Comparing this month's payments vs last month's payments)
    const now = new Date();
    const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const firstOfLastMonthStr = firstOfLastMonth.toISOString().split("T")[0];

    const lastMonthPayments = completedPayments.filter(p => p.payment_date >= firstOfLastMonthStr && p.payment_date < firstOfMonth);
    const lastMonthRevenue = lastMonthPayments.reduce((s, p) => s + (p.amount || 0), 0);

    let growthRate = 0;
    if (lastMonthRevenue > 0) {
      growthRate = parseFloat((((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100).toFixed(1));
    } else if (thisMonthRevenue > 0) {
      growthRate = 100.0;
    }

    // MoM Bookings Growth
    const bookingsThisMonth = bookings.filter(b => b.created_at && b.created_at >= firstOfMonth).length;
    const bookingsLastMonth = bookings.filter(b => b.created_at && b.created_at >= firstOfLastMonthStr && b.created_at < firstOfMonth).length;
    let bookingsGrowth = 0;
    if (bookingsLastMonth > 0) {
      bookingsGrowth = parseFloat((((bookingsThisMonth - bookingsLastMonth) / bookingsLastMonth) * 100).toFixed(1));
    } else if (bookingsThisMonth > 0) {
      bookingsGrowth = 100.0;
    }

    // MoM Customers Growth
    const customers = customersResult.data || [];
    const customersThisMonth = customers.filter(c => c.created_at && c.created_at >= firstOfMonth).length;
    const customersLastMonth = customers.filter(c => c.created_at && c.created_at >= firstOfLastMonthStr && c.created_at < firstOfMonth).length;
    let customersGrowth = 0;
    if (customersLastMonth > 0) {
      customersGrowth = parseFloat((((customersThisMonth - customersLastMonth) / customersLastMonth) * 100).toFixed(1));
    } else if (customersThisMonth > 0) {
      customersGrowth = 100.0;
    }

    // MoM Pending Payments Growth
    const pendingThisMonth = bookings.filter(b => b.status !== 'cancelled' && b.created_at >= firstOfMonth).reduce((s, b) => s + (b.total_amount || 0), 0) - payments.filter(p => p.payment_date >= firstOfMonth).reduce((s, p) => s + (p.amount || 0), 0);
    const pendingLastMonth = bookings.filter(b => b.status !== 'cancelled' && b.created_at >= firstOfLastMonthStr && b.created_at < firstOfMonth).reduce((s, b) => s + (b.total_amount || 0), 0) - payments.filter(p => p.payment_date >= firstOfLastMonthStr && p.payment_date < firstOfMonth).reduce((s, p) => s + (p.amount || 0), 0);
    let pendingGrowth = 0;
    if (pendingLastMonth > 0) {
      pendingGrowth = parseFloat((((pendingThisMonth - pendingLastMonth) / pendingLastMonth) * 100).toFixed(1));
    } else if (pendingThisMonth > 0) {
      pendingGrowth = 100.0;
    }

    // 5. Calculate Event Types Distribution
    const eventTypesMap = {};
    bookings.forEach((b) => {
      const type = b.event_type || "other";
      const formattedType = type.charAt(0).toUpperCase() + type.slice(1);
      eventTypesMap[formattedType] = (eventTypesMap[formattedType] || 0) + 1;
    });
    const eventDistribution = Object.keys(eventTypesMap).map((name) => ({
      name,
      value: eventTypesMap[name],
    }));

    // 6. Calculate Enquiry Funnel
    const interestedEnq = enquiries.filter(e => ["interested", "visit_scheduled", "visited", "booked"].includes(e.status)).length;
    const visitScheduledEnq = enquiries.filter(e => ["visit_scheduled", "visited", "booked"].includes(e.status)).length;
    const visitedEnq = enquiries.filter(e => ["visited", "booked"].includes(e.status)).length;

    const enquiryFunnel = [
      { stage: "Enquiries", count: totalEnq },
      { stage: "Interested", count: interestedEnq },
      { stage: "Visit Scheduled", count: visitScheduledEnq },
      { stage: "Visited", count: visitedEnq },
      { stage: "Booked", count: bookedEnq }
    ];

    res.json({
      summary: {
        total_bookings: totalBookings,
        confirmed_bookings: confirmedBookings,
        completed_bookings: completedBookings,
        cancelled_bookings: cancelledBookings,
        total_customers: customers.length,
        total_enquiries: totalEnquiries,
        active_enquiries: activeEnquiries,
      },
      revenue: {
        total_revenue: totalRevenue,
        total_collected: totalCollected,
        total_pending: totalRevenue - totalCollected,
        this_month: thisMonthRevenue,
      },
      analytics: {
        enquiry_conversion_rate: enquiryConversionRate,
        avg_order_value: avgOrderValue,
        collection_rate: collectionRate,
        growth_rate: growthRate,
        bookings_growth: bookingsGrowth,
        customers_growth: customersGrowth,
        pending_payments_growth: pendingGrowth,
        event_distribution: eventDistribution,
        enquiry_funnel: enquiryFunnel,
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
            package_id: subscriptionResult.data.package_id,
          }
        : null,
    });
  } catch (err) {
    console.error("getDashboard error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getRevenueSummary = async (req, res) => {
  try {
    const valid = await isSubscriptionValid(req.user.id, req.user.hall_id, req.user.primary_hall_id);
    if (!valid) {
      return res.json([]);
    }
    const hall_id = req.user.hall_id;
    const { range = "30days" } = req.query;

    let hallIds = [hall_id];
    if (hall_id === "all") {
      const { data: userHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      hallIds = (userHalls || []).map((uh) => uh.hall_id);
      if (hallIds.length === 0) {
        hallIds = [req.user.primary_hall_id];
      }
    }

    const now = new Date();
    let startDate = new Date();
    let groupBy = "day";

    if (range === "30days") {
      startDate.setDate(now.getDate() - 30);
      groupBy = "day";
    } else if (range === "3months") {
      startDate.setMonth(now.getMonth() - 3);
      groupBy = "month";
    } else if (range === "6months") {
      startDate.setMonth(now.getMonth() - 6);
      groupBy = "month";
    } else if (range === "1year") {
      startDate.setFullYear(now.getFullYear() - 1);
      groupBy = "month";
    }

    const { data: payments, error } = await supabaseAdmin
      .from("payments")
      .select("amount, payment_date")
      .in("hall_id", hallIds)
      .gte("payment_date", startDate.toISOString().split("T")[0])
      .order("payment_date", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    const aggregated = {};
    
    if (groupBy === "day") {
      // Initialize last 30 days
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const label = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
        aggregated[label] = 0;
      }
      
      const completedPaymentsForChart = payments || [];
      completedPaymentsForChart?.forEach((p) => {
        const dateObj = new Date(p.payment_date);
        const label = dateObj.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
        if (aggregated[label] !== undefined) {
          aggregated[label] += parseFloat(p.amount || 0);
        }
      });
    } else {
      // Initialize months
      let monthsToCreate = 3;
      if (range === "6months") monthsToCreate = 6;
      if (range === "1year") monthsToCreate = 12;

      for (let i = monthsToCreate - 1; i >= 0; i--) {
        const d = new Date();
        d.setMonth(now.getMonth() - i);
        const label = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
        aggregated[label] = 0;
      }

      const completedPaymentsForChart = payments || [];
      completedPaymentsForChart?.forEach((p) => {
        const dateObj = new Date(p.payment_date);
        const label = dateObj.toLocaleDateString("en-US", { month: "short", year: "numeric" });
        if (aggregated[label] !== undefined) {
          aggregated[label] += parseFloat(p.amount || 0);
        }
      });
    }

    const result = Object.keys(aggregated).map((key) => ({
      date: key,
      revenue: aggregated[key]
    }));

    res.json(result);
  } catch (err) {
    console.error("getRevenueSummary error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getMonthlyBookings = async (req, res) => {
  try {
    const valid = await isSubscriptionValid(req.user.id, req.user.hall_id, req.user.primary_hall_id);
    if (!valid) {
      return res.json([]);
    }
    const hall_id = req.user.hall_id;
    const now = new Date();
    const startDate = new Date();
    startDate.setMonth(now.getMonth() - 5); // last 6 months

    let hallIds = [hall_id];
    if (hall_id === "all") {
      const { data: userHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      hallIds = (userHalls || []).map((uh) => uh.hall_id);
      if (hallIds.length === 0) {
        hallIds = [req.user.primary_hall_id];
      }
    }

    const { data: bookings, error } = await supabaseAdmin
      .from("bookings")
      .select("status, start_date")
      .in("hall_id", hallIds)
      .gte("start_date", startDate.toISOString().split("T")[0]);

    if (error) return res.status(500).json({ message: error.message });

    const aggregated = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(now.getMonth() - i);
      const monthLabel = d.toLocaleDateString("en-US", { month: "short" });
      aggregated[monthLabel] = {
        month: monthLabel,
        confirmed: 0,
        completed: 0,
        cancelled: 0,
        total: 0
      };
    }

    bookings?.forEach((b) => {
      const dateObj = new Date(b.start_date);
      const monthLabel = dateObj.toLocaleDateString("en-US", { month: "short" });
      if (aggregated[monthLabel]) {
        aggregated[monthLabel].total++;
        if (b.status === "confirmed") {
          aggregated[monthLabel].confirmed++;
        } else if (b.status === "completed") {
          aggregated[monthLabel].completed++;
        } else if (b.status === "cancelled") {
          aggregated[monthLabel].cancelled++;
        }
      }
    });

    const result = Object.values(aggregated);
    res.json(result);
  } catch (err) {
    console.error("getMonthlyBookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getUpcomingBookings = async (req, res) => {
  try {
    const valid = await isSubscriptionValid(req.user.id, req.user.hall_id, req.user.primary_hall_id);
    if (!valid) {
      return res.json([]);
    }
    const hall_id = req.user.hall_id;
    const today = new Date().toISOString().split("T")[0];
    
    let hallIds = [hall_id];
    if (hall_id === "all") {
      const { data: userHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      hallIds = (userHalls || []).map((uh) => uh.hall_id);
      if (hallIds.length === 0) {
        hallIds = [req.user.primary_hall_id];
      }
    }

    const { data, error } = await supabaseAdmin
      .from("events")
      .select(`*, bookings(event_name, status, customers(customer_name, phone))`)
      .in("hall_id", hallIds)
      .gte("event_date", today)
      .order("event_date", { ascending: true })
      .limit(5);

    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    console.error("getUpcomingBookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getRecentPayments = async (req, res) => {
  try {
    const valid = await isSubscriptionValid(req.user.id, req.user.hall_id, req.user.primary_hall_id);
    if (!valid) {
      return res.json([]);
    }
    const hall_id = req.user.hall_id;

    let hallIds = [hall_id];
    if (hall_id === "all") {
      const { data: userHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      hallIds = (userHalls || []).map((uh) => uh.hall_id);
      if (hallIds.length === 0) {
        hallIds = [req.user.primary_hall_id];
      }
    }

    const { data, error } = await supabaseAdmin
      .from("payments")
      .select(`*, bookings(event_name, customers(customer_name))`)
      .in("hall_id", hallIds)
      .order("payment_date", { ascending: false })
      .limit(10);

    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    console.error("getRecentPayments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getDashboard,
  getRevenueSummary,
  getMonthlyBookings,
  getUpcomingBookings,
  getRecentPayments
};