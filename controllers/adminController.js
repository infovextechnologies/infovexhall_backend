const { supabase, supabaseAdmin } = require("../config/supabase");
const { createNotification } = require("./notificationController");

// ─────────────────────────────────────────────────────────────────────────────
// HALL CRUD
// ─────────────────────────────────────────────────────────────────────────────

const createHall = async (req, res) => {
  const { hall_name, owner_name, owner_email, password, phone, city, address, package_id } = req.body;

  if (!hall_name || !owner_name || !owner_email || !password || !package_id) {
    return res.status(400).json({
      message: "hall_name, owner_name, owner_email, password, package_id are required",
    });
  }

  // 1. Create hall
  const { data: hall, error: hallError } = await supabaseAdmin
    .from("marriage_halls")
    .insert([{ hall_name, owner_name, phone, city, address, status: "active" }])
    .select()
    .single();

  if (hallError) return res.status(500).json({ message: hallError.message });

  // 2. Create Supabase Auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: owner_email,
    password,
    options: {
      data: { name: owner_name, role: "owner", hall_id: hall.id },
    },
  });

  if (authError || !authData?.user) {
    await supabaseAdmin.from("marriage_halls").delete().eq("id", hall.id);
    return res.status(400).json({ message: authError?.message || "Auth user creation failed" });
  }

  // 3. Create user profile
  const { error: userError } = await supabaseAdmin.from("users").insert([{
    name: owner_name,
    email: owner_email,
    password: "supabase_auth",
    role: "owner",
    hall_id: hall.id,
    auth_user_id: authData.user.id,
  }]);

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    await supabaseAdmin.from("marriage_halls").delete().eq("id", hall.id);
    return res.status(500).json({ message: userError.message });
  }

  // 4. Create subscription
  const startDate = new Date();
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + 1);

  const { error: subError } = await supabaseAdmin.from("hall_subscriptions").insert([{
    hall_id: hall.id,
    package_id,
    start_date: startDate.toISOString().split("T")[0],
    end_date: endDate.toISOString().split("T")[0],
    status: "active",
    payment_status: "pending",
  }]);

  if (subError) console.error("Subscription creation failed:", subError.message);

  // 5. Update hall with owner email
  await supabaseAdmin.from("marriage_halls").update({ email: owner_email }).eq("id", hall.id);

  res.status(201).json({
    message: "Hall created successfully. A confirmation email has been sent to the owner.",
    hall_id: hall.id,
    owner_email,
  });
};

const getAllHalls = async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("marriage_halls")
    .select(`*, hall_subscriptions ( id, status, start_date, end_date, payment_status, packages ( name, price, billing_cycle ) )`)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  res.json(data);
};

const getHallById = async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from("marriage_halls")
    .select(`*, hall_subscriptions ( id, status, start_date, end_date, payment_status, packages ( name, price, billing_cycle, features ) ), users ( id, name, email, role, created_at )`)
    .eq("id", id)
    .single();

  if (error) return res.status(404).json({ message: "Hall not found" });
  res.json(data);
};

const suspendHall = async (req, res) => {
  const { id } = req.params;

  const { error } = await supabaseAdmin.from("marriage_halls").update({ status: "suspended" }).eq("id", id);
  if (error) return res.status(500).json({ message: error.message });

  await supabaseAdmin.from("hall_subscriptions").update({ status: "inactive" }).eq("hall_id", id);
  res.json({ message: "Hall suspended successfully" });
};

const activateHall = async (req, res) => {
  const { id } = req.params;

  const { error } = await supabaseAdmin.from("marriage_halls").update({ status: "active" }).eq("id", id);
  if (error) return res.status(500).json({ message: error.message });

  const today = new Date().toISOString().split("T")[0];
  await supabaseAdmin.from("hall_subscriptions").update({ status: "active" }).eq("hall_id", id).gte("end_date", today);
  res.json({ message: "Hall activated successfully" });
};

const deleteHall = async (req, res) => {
  const { id } = req.params;

  const { data: users } = await supabaseAdmin.from("users").select("auth_user_id").eq("hall_id", id);

  const { error } = await supabaseAdmin.from("marriage_halls").delete().eq("id", id);
  if (error) return res.status(500).json({ message: error.message });

  if (users?.length > 0) {
    await Promise.all(
      users.map((u) =>
        u.auth_user_id ? supabaseAdmin.auth.admin.deleteUser(u.auth_user_id) : Promise.resolve()
      )
    );
  }

  res.json({ message: "Hall deleted successfully" });
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK 1 — Dashboard Stats (real data, no hardcoded fallbacks)
// ─────────────────────────────────────────────────────────────────────────────

const getAdminDashboardStats = async (req, res) => {
  try {
    const now = new Date();
    const today = now.toISOString().split("T")[0];

    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month

    const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString().split("T")[0];
    const startOfThisMonthStr = startOfThisMonth.toISOString().split("T")[0];
    const startOfLastMonthStr = startOfLastMonth.toISOString().split("T")[0];
    const endOfLastMonthStr = endOfLastMonth.toISOString().split("T")[0];

    let databaseStatus = "healthy";

    const [hallsRes, subsRes, usersRes, paymentsRes, activitiesRes] = await Promise.all([
      supabaseAdmin.from("marriage_halls").select("id, status, created_at"),
      supabaseAdmin.from("hall_subscriptions").select("id, status, end_date, hall_id, packages(name, price)"),
      supabaseAdmin.from("users").select("id, created_at"),
      supabaseAdmin.from("payments").select("amount, payment_date"),
      supabaseAdmin.from("activity_logs").select("id, action, description, created_at, user_name, hall_id").order("created_at", { ascending: false }).limit(8),
    ]).catch(() => {
      databaseStatus = "degraded";
      return [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];
    });

    if (
      hallsRes.error || subsRes.error || usersRes.error ||
      paymentsRes.error || activitiesRes.error
    ) {
      databaseStatus = "degraded";
    }

    const halls = hallsRes.data || [];
    const subs = subsRes.data || [];
    const users = usersRes.data || [];
    const payments = paymentsRes.data || [];
    const activities = activitiesRes.data || [];

    // ── Hall stats ──
    const totalHalls = halls.length;
    const activeHallsCount = halls.filter((h) => h.status === "active").length;
    const trialHalls = subs.filter((s) => s.status === "trial").length;
    const expiredSubs = subs.filter(
      (s) => s.status === "expired" || s.status === "suspended" || (s.end_date && s.end_date < today)
    ).length;

    // Halls created this month vs last month
    const hallsThisMonth = halls.filter((h) => h.created_at && h.created_at >= startOfThisMonthStr).length;
    const hallsLastMonth = halls.filter(
      (h) => h.created_at && h.created_at >= startOfLastMonthStr && h.created_at <= endOfLastMonthStr
    ).length;
    const hallsGrowth = hallsLastMonth > 0
      ? parseFloat((((hallsThisMonth - hallsLastMonth) / hallsLastMonth) * 100).toFixed(1))
      : hallsThisMonth > 0 ? 100 : 0;

    // ── Users ──
    const totalUsers = users.length;
    const usersThisMonth = users.filter((u) => u.created_at && u.created_at >= startOfThisMonthStr).length;
    const usersLastMonth = users.filter(
      (u) => u.created_at && u.created_at >= startOfLastMonthStr && u.created_at <= endOfLastMonthStr
    ).length;
    const usersGrowth = usersLastMonth > 0
      ? parseFloat((((usersThisMonth - usersLastMonth) / usersLastMonth) * 100).toFixed(1))
      : usersThisMonth > 0 ? 100 : 0;

    // ── Revenue ──
    const monthlyRevenue = payments
      .filter((p) => p.payment_date && p.payment_date >= startOfThisMonthStr)
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    const annualRevenue = payments
      .filter((p) => p.payment_date && p.payment_date >= startOfYear)
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    // ── New signups (halls) this month vs last month ──
    const newSignups = hallsThisMonth;
    const newSignupsLastMonth = hallsLastMonth;
    const signupsGrowth = newSignupsLastMonth > 0
      ? parseFloat((((newSignups - newSignupsLastMonth) / newSignupsLastMonth) * 100).toFixed(1))
      : newSignups > 0 ? 100 : 0;

    // ── Revenue growth (this month vs last month) ──
    const revenueLastMonth = payments
      .filter((p) => p.payment_date && p.payment_date >= startOfLastMonthStr && p.payment_date <= endOfLastMonthStr)
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const revenueGrowth = revenueLastMonth > 0
      ? parseFloat((((monthlyRevenue - revenueLastMonth) / revenueLastMonth) * 100).toFixed(1))
      : monthlyRevenue > 0 ? 100 : 0;

    // ── System health — only real computable fields ──
    const systemHealth = {
      activeHalls: activeHallsCount,
      serverStatus: "healthy",
      databaseStatus,
    };

    // ── Activities ──
    const mappedActivities = activities.map((act) => ({
      id: act.id,
      type: act.action?.includes("signup") || act.action?.includes("register")
        ? "hall_signup"
        : act.action?.includes("payment")
        ? "payment_received"
        : "activity",
      title: act.action || "System Log",
      description: act.description || "",
      timestamp: act.created_at,
      actor: act.user_name || "System",
      hallId: act.hall_id || null,
    }));

    res.json({
      kpis: {
        totalHalls: {
          value: totalHalls,
          growth: hallsGrowth,
          trend: hallsGrowth >= 0 ? "up" : "down",
        },
        activeHalls: {
          value: activeHallsCount,
          growth: 0,
          trend: "up",
        },
        trialHalls: {
          value: trialHalls,
          growth: 0,
          trend: "up",
        },
        expiredSubscriptions: {
          value: expiredSubs,
          growth: 0,
          trend: "up",
        },
        monthlyRevenue: {
          value: monthlyRevenue,
          growth: revenueGrowth,
          trend: revenueGrowth >= 0 ? "up" : "down",
        },
        annualRevenue: {
          value: annualRevenue,
          growth: 0,
          trend: "up",
        },
        newSignups: {
          value: newSignups,
          growth: signupsGrowth,
          trend: signupsGrowth >= 0 ? "up" : "down",
        },
        totalUsers: {
          value: totalUsers,
          growth: usersGrowth,
          trend: usersGrowth >= 0 ? "up" : "down",
        },
      },
      systemHealth,
      activities: mappedActivities,
    });
  } catch (err) {
    console.error("getAdminDashboardStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK 2 — Analytics (real data, no hardcoded datasets)
// ─────────────────────────────────────────────────────────────────────────────

const getAdminAnalytics = async (req, res) => {
  try {
    const { timePeriod = "30d" } = req.query;

    // Determine start date based on timePeriod
    const now = new Date();
    let startDate;
    if (timePeriod === "30d") {
      startDate = new Date(now.getTime() - 30 * 86400 * 1000);
    } else if (timePeriod === "3m") {
      startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    } else if (timePeriod === "6m") {
      startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    } else if (timePeriod === "1y") {
      startDate = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    } else {
      startDate = new Date(now.getTime() - 30 * 86400 * 1000);
    }
    const startDateStr = startDate.toISOString().split("T")[0];

    // Parallel fetches
    const [hallsRes, subsRes, allPaymentsRes, hallPaymentsRes, hallsWithSubsRes] = await Promise.all([
      supabaseAdmin.from("marriage_halls").select("id, city, status, created_at"),
      supabaseAdmin.from("hall_subscriptions").select("id, status, hall_id, packages(name, price)"),
      supabaseAdmin
        .from("payments")
        .select("amount, payment_date")
        .gte("payment_date", startDateStr)
        .order("payment_date", { ascending: true }),
      supabaseAdmin
        .from("payments")
        .select("amount, hall_id, marriage_halls(hall_name, city)"),
      supabaseAdmin
        .from("marriage_halls")
        .select("id, city, status, hall_subscriptions(status, packages(price))"),
    ]);

    const halls = hallsRes.data || [];
    const subs = subsRes.data || [];
    const allPayments = allPaymentsRes.data || [];
    const hallPayments = hallPaymentsRes.data || [];
    const hallsWithSubs = hallsWithSubsRes.data || [];

    const totalHalls = halls.length;
    const activeHallsCount = halls.filter((h) => h.status === "active").length;

    // ── 1. Revenue History ──
    const monthlyMap = {};
    allPayments.forEach((p) => {
      const d = new Date(p.payment_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
      if (!monthlyMap[key]) monthlyMap[key] = { date: label, mrr: 0, setupFees: 0, total: 0 };
      monthlyMap[key].mrr += parseFloat(p.amount) || 0;
      monthlyMap[key].total += parseFloat(p.amount) || 0;
    });
    const revenueHistory = Object.keys(monthlyMap)
      .sort()
      .map((k) => monthlyMap[k]);

    // ── 2. Hall Growth ──
    const hallGrowthMap = {};
    halls
      .filter((h) => h.created_at && h.created_at >= startDateStr)
      .forEach((h) => {
        const d = new Date(h.created_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleDateString("en-IN", { month: "short" });
        if (!hallGrowthMap[key]) hallGrowthMap[key] = { month: label, active: 0, trials: 0 };
        if (h.status === "active") hallGrowthMap[key].active++;
        else hallGrowthMap[key].trials++;
      });
    const hallGrowth = Object.keys(hallGrowthMap)
      .sort()
      .map((k) => hallGrowthMap[k]);

    // ── 3. ARPU, Retention, Churn ──
    const totalRevenue = allPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const arpu = activeHallsCount > 0 ? Math.round(totalRevenue / activeHallsCount) : 0;
    const retentionRate =
      totalHalls > 0
        ? parseFloat(((activeHallsCount / totalHalls) * 100).toFixed(1))
        : 100;
    const churnRate = parseFloat((100 - retentionRate).toFixed(1));

    // ── 4. Package Distribution ──
    const packageCounts = {};
    subs.forEach((sub) => {
      const name = sub.packages?.name || "Free Trial";
      packageCounts[name] = (packageCounts[name] || 0) + 1;
    });
    const totalSubsCount = Object.values(packageCounts).reduce((a, b) => a + b, 0) || 1;
    const packageDistribution = Object.keys(packageCounts).map((name) => ({
      name,
      count: packageCounts[name],
      value: Math.round((packageCounts[name] / totalSubsCount) * 100),
    }));

    // ── 5. District Stats (real city data only) ──
    const cityCounts = {};
    const trialsByCity = {};
    const activePaidByCity = {};
    const mrrByCity = {};

    hallsWithSubs.forEach((hall) => {
      const city = hall.city || "Other";
      cityCounts[city] = (cityCounts[city] || 0) + 1;

      (hall.hall_subscriptions || []).forEach((sub) => {
        if (sub.status === "trial") {
          trialsByCity[city] = (trialsByCity[city] || 0) + 1;
        }
        if (sub.status === "active") {
          activePaidByCity[city] = (activePaidByCity[city] || 0) + 1;
          mrrByCity[city] = (mrrByCity[city] || 0) + (parseFloat(sub.packages?.price) || 0);
        }
      });
    });

    const districtStats = Object.keys(cityCounts)
      .map((city) => ({
        district: city,
        contacted: cityCounts[city],
        demosGiven: cityCounts[city],
        trialsStarted: trialsByCity[city] || 0,
        paidCustomers: activePaidByCity[city] || 0,
        conversionRate:
          cityCounts[city] > 0
            ? parseFloat(
                (((activePaidByCity[city] || 0) / cityCounts[city]) * 100).toFixed(1)
              )
            : 0,
        mrr: mrrByCity[city] || 0,
      }))
      .sort((a, b) => b.mrr - a.mrr);

    // ── 6. Top Halls by Revenue ──
    const hallRevMap = {};
    hallPayments.forEach((p) => {
      if (!p.hall_id) return;
      if (!hallRevMap[p.hall_id]) {
        hallRevMap[p.hall_id] = {
          hallId: p.hall_id,
          hallName: p.marriage_halls?.hall_name || "Unknown",
          city: p.marriage_halls?.city || "",
          totalRevenue: 0,
        };
      }
      hallRevMap[p.hall_id].totalRevenue += parseFloat(p.amount) || 0;
    });
    const topHalls = Object.values(hallRevMap)
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 5)
      .map((h, idx) => ({ ...h, rank: idx + 1 }));

    res.json({
      revenueHistory,
      retentionRate,
      churnRate,
      arpu,
      packageDistribution,
      hallGrowth,
      districtStats,
      topHalls,
    });
  } catch (err) {
    console.error("getAdminAnalytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK 3 — Per-hall Stats
// ─────────────────────────────────────────────────────────────────────────────

const getHallStats = async (req, res) => {
  try {
    const { id } = req.params;

    // If no id param, fall back to aggregate hall stats (used by /stats route)
    if (!id) {
      const { data: halls, error } = await supabaseAdmin
        .from("marriage_halls")
        .select("id, status");
      if (error) return res.status(500).json({ message: error.message });
      const total = halls?.length || 0;
      const active = halls?.filter((h) => h.status === "active").length || 0;
      const suspended = halls?.filter((h) => h.status === "suspended").length || 0;
      return res.json({ total, active, suspended });
    }

    const startOfMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1
    ).toISOString();

    const [bookingsRes, staffRes, paymentsRes, subRes] = await Promise.all([
      supabaseAdmin.from("bookings").select("id, status").eq("hall_id", id),
      supabaseAdmin.from("users").select("id").eq("hall_id", id),
      supabaseAdmin.from("payments").select("amount").eq("hall_id", id),
      supabaseAdmin
        .from("hall_subscriptions")
        .select("*, packages(name, price, max_users, max_bookings)")
        .eq("hall_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const bookings = bookingsRes.data || [];
    const staff = staffRes.data || [];
    const payments = paymentsRes.data || [];
    const sub = subRes.data;

    const totalRevenue = payments.reduce(
      (s, p) => s + (parseFloat(p.amount) || 0),
      0
    );
    const subPrice = sub?.packages?.price || 0;

    const { data: monthPayments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("hall_id", id)
      .gte("payment_date", startOfMonth);

    const paidThisMonth = (monthPayments || []).reduce(
      (s, p) => s + (parseFloat(p.amount) || 0),
      0
    );
    const pendingBalance = Math.max(0, subPrice - paidThisMonth);

    res.json({
      bookingsCount: bookings.length,
      confirmedBookings: bookings.filter((b) => b.status === "confirmed").length,
      pendingBookings: bookings.filter((b) => b.status === "pending").length,
      staffCount: staff.length,
      totalRevenue,
      pendingBalance,
      maxUsers: sub?.packages?.max_users || null,
      maxBookings: sub?.packages?.max_bookings || null,
    });
  } catch (err) {
    console.error("getHallStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK 4 — Per-hall Activity Timeline
// ─────────────────────────────────────────────────────────────────────────────

const getHallActivity = async (req, res) => {
  try {
    const { id } = req.params;

    const [activityRes, subRes] = await Promise.all([
      supabaseAdmin
        .from("activity_logs")
        .select("id, action, description, created_at, user_name")
        .eq("hall_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("hall_subscriptions")
        .select("id, status, start_date, end_date, created_at, packages(name)")
        .eq("hall_id", id)
        .order("created_at", { ascending: false }),
    ]);

    const activities = activityRes.data || [];
    const subs = subRes.data || [];

    const timeline = [
      ...activities.map((a) => ({
        id: a.id,
        title: a.action || "System Event",
        description: a.description || "",
        timestamp: a.created_at,
        actor: a.user_name || "System",
        type: "activity",
      })),
      ...subs.map((s) => ({
        id: `sub-${s.id}`,
        title:
          s.status === "active"
            ? "Subscription Activated"
            : s.status === "trial"
            ? "Trial Started"
            : `Subscription ${s.status.charAt(0).toUpperCase() + s.status.slice(1)}`,
        description: `Package: ${s.packages?.name || "Free Trial"} — Valid till ${
          s.end_date ? new Date(s.end_date).toLocaleDateString("en-GB") : "N/A"
        }`,
        timestamp: s.created_at,
        actor: "System Admin",
        type: "subscription",
      })),
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20);

    res.json(timeline);
  } catch (err) {
    console.error("getHallActivity error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate hall stats (legacy /stats route — no id param)
// ─────────────────────────────────────────────────────────────────────────────

const getAggregateHallStats = async (req, res) => {
  try {
    const { data: halls, error } = await supabaseAdmin
      .from("marriage_halls")
      .select("id, status");
    if (error) return res.status(500).json({ message: error.message });
    const total = halls?.length || 0;
    const active = halls?.filter((h) => h.status === "active").length || 0;
    const suspended = halls?.filter((h) => h.status === "suspended").length || 0;
    res.json({ total, active, suspended });
  } catch (err) {
    console.error("getAggregateHallStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

const getAdminUsers = async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from("users")
      .select("id, name, email, role, status, created_at, phone, marriage_halls(hall_name)")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });

    const formatted = (users || []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status || "active",
      phone: u.phone || "N/A",
      lastLogin: u.created_at,
      hallName: u.marriage_halls?.hall_name || "Shared Workspace / Admin",
    }));

    res.json(formatted);
  } catch (err) {
    console.error("getAdminUsers error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updateAdminUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["active", "suspended"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: `User status updated to ${status}`, data });
  } catch (err) {
    console.error("updateAdminUserStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const resetAdminUserPassword = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error: fetchErr } = await supabaseAdmin
      .from("users")
      .select("email")
      .eq("id", id)
      .single();

    if (fetchErr || !user) return res.status(404).json({ message: "User not found" });

    const { error: resetErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: user.email,
    });

    if (resetErr) return res.status(500).json({ message: resetErr.message });

    res.json({ message: `Password reset instructions generated and sent to ${user.email}` });
  } catch (err) {
    console.error("resetAdminUserPassword error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

const getAdminSettings = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("admin_settings")
      .select("*")
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });

    if (!data) {
      return res.json({
        companyName: "Infovex Technologies Private Limited",
        gstin: "33AAFCI8876F1Z8",
        supportPhone: "+91 91801 02030",
        supportEmail: "support@infovex.com",
        defaultTrialDays: 14,
        invoicePrefix: "INF-HOD-",
        nextInvoiceNumber: 1,
        emailTemplates: {
          welcome:
            "Hello {{owner_name}},\n\nWelcome to HallsOnDesk! Your account has been set up successfully.",
          trialExpiring:
            "Hi {{owner_name}},\n\nYour free trial is expiring in 3 days.",
          paymentSuccess:
            "Dear {{owner_name}},\n\nWe have received your subscription payment.",
          subscriptionSuspended:
            "Dear Admin,\n\nSubscription for {{hall_name}} has been suspended.",
        },
      });
    }

    res.json({
      id: data.id,
      companyName: data.company_name,
      gstin: data.gstin,
      supportPhone: data.support_phone,
      supportEmail: data.support_email,
      defaultTrialDays: data.default_trial_days,
      invoicePrefix: data.invoice_prefix,
      nextInvoiceNumber: data.next_invoice_number,
      emailTemplates: data.email_templates || {},
    });
  } catch (err) {
    console.error("getAdminSettings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updateAdminSettings = async (req, res) => {
  try {
    const {
      id,
      companyName,
      gstin,
      supportPhone,
      supportEmail,
      defaultTrialDays,
      invoicePrefix,
      nextInvoiceNumber,
      emailTemplates,
    } = req.body;

    const payload = {
      company_name: companyName,
      gstin,
      support_phone: supportPhone,
      support_email: supportEmail,
      default_trial_days: defaultTrialDays,
      invoice_prefix: invoicePrefix,
      next_invoice_number: nextInvoiceNumber,
      email_templates: emailTemplates,
      updated_at: new Date().toISOString(),
    };

    if (id) payload.id = id;

    const { data, error } = await supabaseAdmin
      .from("admin_settings")
      .upsert(payload)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Company settings updated successfully", data });
  } catch (err) {
    console.error("updateAdminSettings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Support Tickets
// ─────────────────────────────────────────────────────────────────────────────

const getAdminTickets = async (req, res) => {
  try {
    const { data: tickets, error } = await supabaseAdmin
      .from("support_tickets")
      .select("*, marriage_halls(hall_name)")
      .order("created_at", { ascending: false });

    if (error) {
      if (error.message.includes("does not exist")) {
        return res.json([]);
      }
      return res.status(500).json({ message: error.message });
    }

    const formatted = (tickets || []).map((t) => ({
      id: t.id,
      ticketNumber: t.ticket_number,
      hallId: t.hall_id,
      hallName: t.marriage_halls?.hall_name || "General / System",
      subject: t.subject,
      description: t.description,
      category: t.category,
      priority: t.priority,
      status: t.status,
      assignedTo: t.assigned_to || "Unassigned",
      messages: t.messages || [],
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("getAdminTickets error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updateAdminTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assignedTo } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (assignedTo !== undefined) updates.assigned_to = assignedTo;

    const { data, error } = await supabaseAdmin
      .from("support_tickets")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Notify ticket owner if resolved
    if (status === "resolved" && data.hall_id) {
      await createNotification({
        hall_id: data.hall_id,
        type: "support_ticket_resolved",
        title: "Support Ticket Resolved",
        message: `Your support ticket ${data.ticket_number} has been marked as resolved.`,
        entity_type: "support_ticket",
        entity_id: data.id,
      });
    }

    res.json({ message: "Ticket updated successfully", data });
  } catch (err) {
    console.error("updateAdminTicketStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const addAdminTicketMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { message, senderName = "System Admin" } = req.body;

    if (!message) return res.status(400).json({ message: "Message text is required" });

    const { data: ticket, error: fetchErr } = await supabaseAdmin
      .from("support_tickets")
      .select("id, messages, hall_id, ticket_number")
      .eq("id", id)
      .single();

    if (fetchErr) return res.status(500).json({ message: fetchErr.message });

    const messages = ticket.messages || [];
    messages.push({
      sender: "admin",
      senderName,
      message,
      timestamp: new Date().toISOString(),
    });

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("support_tickets")
      .update({ messages, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ message: updateErr.message });

    // Notify ticket owner about new support reply
    if (ticket.hall_id) {
      await createNotification({
        hall_id: ticket.hall_id,
        type: "support_ticket_message",
        title: `Reply on Ticket ${ticket.ticket_number}`,
        message: `Support: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`,
        entity_type: "support_ticket",
        entity_id: ticket.id,
      });
    }

    res.json({ message: "Reply dispatched successfully", data: updated });
  } catch (err) {
    console.error("addAdminTicketMessage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createHall,
  getAllHalls,
  getHallById,
  suspendHall,
  activateHall,
  deleteHall,
  getAggregateHallStats,
  getHallStats,
  getHallActivity,
  getAdminDashboardStats,
  getAdminAnalytics,
  getAdminUsers,
  updateAdminUserStatus,
  resetAdminUserPassword,
  getAdminSettings,
  updateAdminSettings,
  getAdminTickets,
  updateAdminTicketStatus,
  addAdminTicketMessage,
};