const { supabase, supabaseAdmin } = require("../config/supabase");
const { getLocalDate } = require("../utils/dateHelper");
const { createNotification } = require("./notificationController");

// ─────────────────────────────────────────────────────────────────────────────
// HALL CRUD
// ─────────────────────────────────────────────────────────────────────────────

const createHall = async (req, res) => {
  const {
    hall_name,
    owner_name,
    owner_email,
    password,
    phone,
    city,
    address,
    package_id,
    setup_fee_amount,
    amount_paid,
    setup_fee_status,
    payment_method,
    transaction_ref_no,
    notes
  } = req.body;

  if (!hall_name || !owner_name || !owner_email || !password || !package_id) {
    return res.status(400).json({
      message: "hall_name, owner_name, owner_email, password, package_id are required",
    });
  }

  // Check if email is already in use
  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", owner_email)
    .maybeSingle();

  if (existingUser) {
    return res.status(400).json({ message: "Email is already registered" });
  }

  const { data: existingAdmin } = await supabaseAdmin
    .from("super_admins")
    .select("id")
    .eq("email", owner_email)
    .maybeSingle();

  if (existingAdmin) {
    return res.status(400).json({ message: "Email is already registered as an administrator" });
  }

  // 1. Create hall
  const { data: hall, error: hallError } = await supabaseAdmin
    .from("marriage_halls")
    .insert([{ hall_name, owner_name, phone, city, address, status: "active" }])
    .select()
    .single();

  if (hallError) return res.status(500).json({ message: hallError.message });

  // 2. Create Supabase Auth user directly via admin client (email confirmation is disabled)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: owner_email,
    password,
    email_confirm: true,
    user_metadata: { name: owner_name, role: "owner", hall_id: hall.id }
  });

  if (authError || !authData?.user) {
    await supabaseAdmin.from("marriage_halls").delete().eq("id", hall.id);
    return res.status(400).json({ message: authError?.message || "Auth user creation failed" });
  }

  // 3. Create user profile
  const cryptoHelper = require("../utils/cryptoHelper");
  const backup_password_enc = cryptoHelper.encrypt(password);

  const { data: newUser, error: userError } = await supabaseAdmin.from("users").insert([{
    name: owner_name,
    email: owner_email,
    password: "supabase_auth",
    role: "owner",
    hall_id: hall.id,
    auth_user_id: authData.user.id,
    backup_password_enc,
  }]).select().single();

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    await supabaseAdmin.from("marriage_halls").delete().eq("id", hall.id);
    return res.status(500).json({ message: userError.message });
  }

  // Link owner to the new hall in user_halls
  if (newUser) {
    await supabaseAdmin.from("user_halls").insert([{
      user_id: newUser.id,
      hall_id: hall.id,
    }]);
  }

  // 4. Create subscription
  const { data: pkg } = await supabaseAdmin
    .from("packages")
    .select("name, setup_fee")
    .eq("id", package_id)
    .maybeSingle();

  let trialDays = 30;
  const packageSetupFee = parseFloat(pkg?.setup_fee || 0);
  const setupFee = setup_fee_amount !== undefined ? parseFloat(setup_fee_amount) : packageSetupFee;
  const amtPaid = amount_paid !== undefined ? parseFloat(amount_paid) : 0;
  
  let status = "unpaid";
  if (setup_fee_status) {
    status = setup_fee_status;
  } else {
    if (setupFee <= 0 || amtPaid >= setupFee) {
      status = "paid";
    } else if (amtPaid > 0) {
      status = "partially_paid";
    }
  }

  let paymentNotes = notes;
  if (!paymentNotes) {
    if (status === "paid") {
      paymentNotes = "Setup fee paid in full during registration.";
    } else if (status === "partially_paid") {
      paymentNotes = `Partial setup fee payment of ₹${amtPaid} recorded during registration.`;
    } else {
      paymentNotes = setupFee > 0 ? "Pending collection of setup fee." : "No setup fee applicable.";
    }
  }

  if (pkg) {
    const nameLower = pkg.name.toLowerCase();
    if (nameLower.includes("basic")) {
      trialDays = 30;
    } else {
      trialDays = 60;
    }
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + trialDays);

  const { error: subError } = await supabaseAdmin.from("hall_subscriptions").insert([{
    hall_id: hall.id,
    package_id,
    start_date: getLocalDate(startDate),
    end_date: getLocalDate(endDate),
    status: "trial",
    payment_status: "pending",
  }]);

  if (subError) console.error("Subscription creation failed:", subError.message);

  // 4b. Create setup fee payment record
  const { error: setupFeeError } = await supabaseAdmin.from("setup_fee_payments").insert([{
    hall_id: hall.id,
    package_id,
    setup_fee_amount: setupFee,
    amount_paid: amtPaid,
    status,
    due_date: getLocalDate(endDate),
    payment_method: payment_method || "none",
    transaction_ref_no: transaction_ref_no || "",
    notes: paymentNotes
  }]);

  if (setupFeeError) console.error("Setup fee payment creation failed:", setupFeeError.message);

  // 5. Update hall with owner email
  await supabaseAdmin.from("marriage_halls").update({ email: owner_email }).eq("id", hall.id);

  res.status(201).json({
    message: "Hall created successfully.",
    hall_id: hall.id,
    owner_email,
  });
};

const getAllHalls = async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("marriage_halls")
    .select(`*, hall_subscriptions ( id, status, start_date, end_date, payment_status, packages ( name, price, billing_cycle, setup_fee ) )`)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  res.json(data);
};

const getHallById = async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from("marriage_halls")
    .select(`*, hall_subscriptions ( id, status, start_date, end_date, payment_status, packages ( name, price, billing_cycle, features, setup_fee ) ), users ( id, name, email, role, created_at, backup_password_enc ), setup_fee_payments ( id, setup_fee_amount, amount_paid, status, payment_method, transaction_ref_no, notes, updated_at, due_date )`)
    .eq("id", id)
    .single();

  if (error) return res.status(404).json({ message: "Hall not found" });

  if (data && data.users && Array.isArray(data.users)) {
    const cryptoHelper = require("../utils/cryptoHelper");
    data.users = data.users.map(u => {
      const decrypted = u.backup_password_enc ? cryptoHelper.decrypt(u.backup_password_enc) : null;
      return {
        ...u,
        backupPassword: decrypted,
        backup_password_enc: undefined
      };
    });
  }

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

  const today = getLocalDate();
  await supabaseAdmin.from("hall_subscriptions").update({ status: "active" }).eq("hall_id", id).gte("end_date", today);
  res.json({ message: "Hall activated successfully" });
};

const deleteHall = async (req, res) => {
  const { id } = req.params;

  // 1. Fetch user auth IDs before we delete the users table rows
  const { data: users } = await supabaseAdmin.from("users").select("auth_user_id").eq("hall_id", id);

  // 2. Defensively clean up records from referencing tables to bypass foreign key constraint errors
  const tablesToDelete = [
    "activity_logs",
    "booking_vendors",
    "invoices",
    "payments",
    "subscription_payments",
    "setup_fee_payments",
    "support_tickets",
    "enquiry_followups",
    "notifications",
    "events",
    "user_halls",
    "bookings",
    "enquiries",
    "vendors",
    "customers",
    "hall_subscriptions",
    "hall_settings",
    "hall_profiles",
    "users"
  ];

  for (const table of tablesToDelete) {
    try {
      await supabaseAdmin.from(table).delete().eq("hall_id", id);
    } catch (err) {
      console.warn(`Defensive warning: Failed to delete from ${table}:`, err.message);
    }
  }

  // 3. Delete the main marriage_halls record
  const { error } = await supabaseAdmin.from("marriage_halls").delete().eq("id", id);
  if (error) return res.status(500).json({ message: error.message });

  // 4. Delete auth credentials from Supabase Auth
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
    const today = getLocalDate(now);

    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month

    const startOfYear = getLocalDate(new Date(now.getFullYear(), 0, 1));
    const startOfThisMonthStr = getLocalDate(startOfThisMonth);
    const startOfLastMonthStr = getLocalDate(startOfLastMonth);
    const endOfLastMonthStr = getLocalDate(endOfLastMonth);

    let databaseStatus = "healthy";

    const [hallsRes, subsRes, usersRes, paymentsRes, activitiesRes] = await Promise.all([
      supabaseAdmin.from("marriage_halls").select("id, status, created_at"),
      supabaseAdmin.from("hall_subscriptions").select("id, status, end_date, hall_id, packages(name, price, setup_fee)"),
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
    const startDateStr = getLocalDate(startDate);

    // Parallel fetches
    const [hallsRes, subsRes, allPaymentsRes, hallPaymentsRes, hallsWithSubsRes] = await Promise.all([
      supabaseAdmin.from("marriage_halls").select("id, city, status, created_at"),
      supabaseAdmin.from("hall_subscriptions").select("id, status, hall_id, packages(name, price, setup_fee)"),
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
        .select("id, city, status, hall_subscriptions(status, packages(price, setup_fee))"),
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
      const name = sub.packages?.name || "Onboarding Setup";
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
        .select("*, packages(name, price, max_users, max_bookings, setup_fee)")
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
        .select("id, status, start_date, end_date, created_at, packages(name, setup_fee)")
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
            ? "Setup Mode Activated"
            : `Subscription ${s.status.charAt(0).toUpperCase() + s.status.slice(1)}`,
        description: `Package: ${s.packages?.name || "Onboarding Setup"} — Valid till ${
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
      .select("id, name, email, role, status, created_at, phone, backup_password_enc, marriage_halls(hall_name)")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });

    const cryptoHelper = require("../utils/cryptoHelper");
    const formatted = (users || []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status || "active",
      phone: u.phone || "N/A",
      lastLogin: u.created_at,
      hallName: u.marriage_halls?.hall_name || "Shared Workspace / Admin",
      backupPassword: u.backup_password_enc ? cryptoHelper.decrypt(u.backup_password_enc) : null,
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
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });

    if (!data) {
      return res.json({
        companyName: "Infovex Technologies Private Limited",
        gstin: "33AAFCI8876F1Z8",
        supportPhone: "+91 8681831689",
        supportEmail: "contact@infovextech.com",
        defaultTrialDays: 14,
        invoicePrefix: "INF-HALLS-",
        nextInvoiceNumber: 1,
        subscriptionQrEnabled: true,
        subscriptionQrUpiId: "billing@infovex.com",
        emailTemplates: {
          welcome:
            "Hello {{owner_name}},\n\nWelcome to Infovex Halls! Your account has been set up successfully.",
          trialExpiring:
            "Hi {{owner_name}},\n\nYour onboarding setup phase is ending in 3 days.",
          paymentSuccess:
            "Dear {{owner_name}},\n\nWe have received your subscription payment.",
          subscriptionSuspended:
            "Dear Admin,\n\nSubscription for {{hall_name}} has been suspended.",
        },
        testimonials: [],
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
      subscriptionQrEnabled: data.subscription_qr_enabled !== undefined ? data.subscription_qr_enabled : true,
      subscriptionQrUpiId: data.subscription_qr_upi_id || "billing@infovex.com",
      emailTemplates: data.email_templates || {},
      founderSlotsClaimed: data.founder_slots_claimed !== undefined ? data.founder_slots_claimed : 14,
      founderSlotsTotal: data.founder_slots_total !== undefined ? data.founder_slots_total : 20,
      testimonials: data.testimonials || [],
    });
  } catch (err) {
    console.error("getAdminSettings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updateAdminSettings = async (req, res) => {
  try {
    let {
      id,
      companyName,
      gstin,
      supportPhone,
      supportEmail,
      defaultTrialDays,
      invoicePrefix,
      nextInvoiceNumber,
      subscriptionQrEnabled,
      subscriptionQrUpiId,
      emailTemplates,
      founderSlotsClaimed,
      founderSlotsTotal,
      testimonials,
    } = req.body;

    // Fetch existing settings row to get its ID if not provided, ensuring single-row state
    if (!id) {
      const { data: existing } = await supabaseAdmin
        .from("admin_settings")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        id = existing.id;
      }
    }

    // Check if the columns exist in DB first to be resilient to migration timing
    const { data: testData } = await supabaseAdmin
      .from("admin_settings")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const hasQrFields = testData && ('subscription_qr_enabled' in testData);
    const hasTestimonials = testData && ('testimonials' in testData);

    const payload = {
      company_name: companyName,
      gstin,
      support_phone: supportPhone,
      support_email: supportEmail,
      default_trial_days: defaultTrialDays,
      invoice_prefix: invoicePrefix,
      next_invoice_number: nextInvoiceNumber,
      email_templates: emailTemplates,
      founder_slots_claimed: founderSlotsClaimed !== undefined ? Number(founderSlotsClaimed) : 14,
      founder_slots_total: founderSlotsTotal !== undefined ? Number(founderSlotsTotal) : 20,
      updated_at: new Date().toISOString(),
    };

    if (hasQrFields) {
      payload.subscription_qr_enabled = subscriptionQrEnabled !== undefined ? subscriptionQrEnabled : true;
      payload.subscription_qr_upi_id = subscriptionQrUpiId || "billing@infovex.com";
    }

    if (hasTestimonials) {
      payload.testimonials = testimonials || [];
    }

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

const getPendingSubscriptionPayments = async (req, res) => {
  try {
    const { status = "pending" } = req.query;

    const { data, error } = await supabaseAdmin
      .from("subscription_payments")
      .select(`
        *,
        marriage_halls(hall_name, owner_name),
        packages(name, price, billing_cycle, setup_fee)
      `)
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("getPendingSubscriptionPayments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const verifySubscriptionPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, rejection_reason = "" } = req.body;
    const { logActivity } = require("./activityLogController");

    if (!action || (action !== "approve" && action !== "reject")) {
      return res.status(400).json({ message: "Action must be either 'approve' or 'reject'" });
    }

    // 1. Fetch payment
    const { data: payment, error: fetchErr } = await supabaseAdmin
      .from("subscription_payments")
      .select("*, packages(name, price, billing_cycle, setup_fee)")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !payment) {
      return res.status(404).json({ message: "Payment verification record not found" });
    }

    if (payment.status !== "pending") {
      return res.status(400).json({ message: "This payment has already been verified and processed" });
    }

    if (action === "approve") {
      // Approve flow
      const today = new Date();
      let newEndDate = new Date();

      // Check existing active subscription to extend it if still active
      const { data: activeSub } = await supabaseAdmin
        .from("hall_subscriptions")
        .select("end_date, status")
        .eq("hall_id", payment.hall_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const todayStr = getLocalDate(today);
      if (activeSub && (activeSub.status === "active" || activeSub.status === "trial") && activeSub.end_date >= todayStr) {
        // Extend from the current end date
        newEndDate = new Date(activeSub.end_date);
      }

      // Add days based on package billing cycle
      const cycle = payment.packages?.billing_cycle || "monthly";
      if (cycle === "annual" || cycle === "yearly") {
        newEndDate.setFullYear(newEndDate.getFullYear() + 1);
      } else {
        newEndDate.setMonth(newEndDate.getMonth() + 1);
      }

      const startDateStr = todayStr;
      const endDateStr = getLocalDate(newEndDate);

      // Update payment
      const { error: updPayErr } = await supabaseAdmin
        .from("subscription_payments")
        .update({
          status: "approved",
          verified_at: today.toISOString(),
          verified_by: req.user.id
        })
        .eq("id", id);

      if (updPayErr) return res.status(500).json({ message: updPayErr.message });

      // Upsert hall_subscriptions record (or create a new row)
      const { error: insSubErr } = await supabaseAdmin
        .from("hall_subscriptions")
        .insert([{
          hall_id: payment.hall_id,
          package_id: payment.package_id,
          start_date: startDateStr,
          end_date: endDateStr,
          status: "active",
          payment_status: "paid"
        }]);

      if (insSubErr) {
        console.error("verifySubscriptionPayment insert subscription error:", insSubErr);
        return res.status(500).json({ message: insSubErr.message });
      }

      // Reactivate marriage_hall status if suspended
      await supabaseAdmin
        .from("marriage_halls")
        .update({ status: "active" })
        .eq("id", payment.hall_id);

      // Create owner notification
      await createNotification({
        hall_id: payment.hall_id,
        type: "subscription_payment_approved",
        title: "Subscription Activated",
        message: `Your payment of ₹${payment.amount} has been verified. Plan "${payment.packages?.name}" is active until ${newEndDate.toLocaleDateString("en-GB")}.`,
        entity_type: "subscription",
        entity_id: payment.id
      });

      // Log activity
      await logActivity({
        hall_id: payment.hall_id,
        user_id: req.user.id,
        user_name: req.user.name,
        action: "subscription.payment_approved",
        entity_type: "subscription_payment",
        description: `Approved subscription payment of ₹${payment.amount} (UTR: ${payment.transaction_ref_no}).`,
        metadata: { payment_id: id, amount: payment.amount, ref_no: payment.transaction_ref_no }
      });

      res.json({ message: "Subscription payment approved and plan activated successfully" });
    } else {
      // Reject flow
      if (!rejection_reason) {
        return res.status(400).json({ message: "Rejection reason is required" });
      }

      // Update payment status
      const { error: updPayErr } = await supabaseAdmin
        .from("subscription_payments")
        .update({
          status: "rejected",
          rejection_reason,
          verified_at: new Date().toISOString(),
          verified_by: req.user.id
        })
        .eq("id", id);

      if (updPayErr) return res.status(500).json({ message: updPayErr.message });

      // Create owner notification
      await createNotification({
        hall_id: payment.hall_id,
        type: "subscription_payment_rejected",
        title: "Subscription Payment Rejected",
        message: `Your billing verification request of ₹${payment.amount} (UTR: ${payment.transaction_ref_no}) was rejected. Reason: ${rejection_reason}`,
        entity_type: "subscription",
        entity_id: payment.id
      });

      // Log activity
      await logActivity({
        hall_id: payment.hall_id,
        user_id: req.user.id,
        user_name: req.user.name,
        action: "subscription.payment_rejected",
        entity_type: "subscription_payment",
        description: `Rejected subscription payment of ₹${payment.amount} (UTR: ${payment.transaction_ref_no}). Reason: ${rejection_reason}`,
        metadata: { payment_id: id, amount: payment.amount, ref_no: payment.transaction_ref_no, reason: rejection_reason }
      });

      res.json({ message: "Subscription payment rejected successfully" });
    }
  } catch (err) {
    console.error("verifySubscriptionPayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const sendTestEmail = async (req, res) => {
  try {
    const { email } = req.body;
    const { sendHallOwnerEmail } = require("../utils/emailHelper");

    if (!email) {
      return res.status(400).json({ message: "email parameter is required" });
    }

    const result = await sendHallOwnerEmail({
      to: email,
      owner_name: "Super Admin Tester",
      hall_name: "Infovex Test Hall",
      city: "Chennai",
      package_name: "Premium Enterprise Plan",
      temp_password: "TEST-PASSWORD-123",
      verification_link: "https://infovexhalls.com/verify-test"
    });

    if (result.success) {
      return res.json({ success: true, message: `Test email successfully dispatched to ${email}` });
    } else {
      return res.status(500).json({ success: false, message: "Email dispatch failed", error: result.error });
    }
  } catch (err) {
    console.error("sendTestEmail error:", err);
    res.status(500).json({ message: "Server error calling email edge function", error: err.message });
  }
};

const getHallSubscriptionPayments = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("subscription_payments")
      .select("*, packages(name, price, billing_cycle)")
      .eq("hall_id", id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("getHallSubscriptionPayments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const recordManualSubscriptionPayment = async (req, res) => {
  try {
    const { id: hall_id } = req.params;
    const { package_id, amount, payment_method = "bank_transfer", transaction_ref_no, notes = "", tax_enabled = false } = req.body;

    if (!package_id || !amount) {
      return res.status(400).json({ message: "package_id and amount are required" });
    }

    // 1. Get package details for billing cycle info
    const { data: pkg, error: pkgErr } = await supabaseAdmin
      .from("packages")
      .select("name, billing_cycle")
      .eq("id", package_id)
      .maybeSingle();

    if (pkgErr || !pkg) {
      return res.status(404).json({ message: "Selected package plan not found" });
    }

    // 2. Insert subscription payment record directly as approved
    const generatedRef = transaction_ref_no || `INF-MANUAL-${Date.now().toString().slice(-6)}`;
    const today = new Date();
    const todayStr = getLocalDate(today);

    const { data: newPayment, error: payErr } = await supabaseAdmin
      .from("subscription_payments")
      .insert([{
        hall_id,
        package_id,
        amount: parseFloat(amount),
        payment_method,
        transaction_ref_no: generatedRef,
        status: "approved",
        notes: notes || "Recorded manually by Infovex Admin.",
        verified_at: today.toISOString(),
        verified_by: req.user.id,
        tax_enabled: !!tax_enabled
      }])
      .select()
      .single();

    if (payErr) {
      console.error("recordManualSubscriptionPayment insert payment error:", payErr);
      return res.status(500).json({ message: payErr.message });
    }

    // 3. Compute extended subscription end date
    let newEndDate = new Date();

    const { data: activeSub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("end_date, status")
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeSub && (activeSub.status === "active" || activeSub.status === "trial") && activeSub.end_date >= todayStr) {
      newEndDate = new Date(activeSub.end_date);
    }

    const cycle = pkg.billing_cycle || "monthly";
    if (cycle === "annual" || cycle === "yearly") {
      newEndDate.setFullYear(newEndDate.getFullYear() + 1);
    } else {
      newEndDate.setMonth(newEndDate.getMonth() + 1);
    }

    const startDateStr = todayStr;
    const endDateStr = getLocalDate(newEndDate);

    // 4. Create new subscription contract contract
    const { error: subErr } = await supabaseAdmin
      .from("hall_subscriptions")
      .insert([{
        hall_id: hall_id,
        package_id: package_id,
        start_date: startDateStr,
        end_date: endDateStr,
        status: "active",
        payment_status: "paid"
      }]);

    if (subErr) {
      console.error("recordManualSubscriptionPayment create subscription error:", subErr);
      return res.status(500).json({ message: subErr.message });
    }

    // 5. Ensure hall is marked active
    await supabaseAdmin
      .from("marriage_halls")
      .update({ status: "active" })
      .eq("id", hall_id);

    // 6. Log operator activity
    const { logActivity } = require("./activityLogController");
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "subscription.manual_payment_recorded",
      entity_type: "subscription_payment",
      description: `Manually recorded subscription payment of ₹${amount} for plan "${pkg.name}". Reference: ${generatedRef}.`,
      metadata: { payment_id: newPayment.id, amount, transaction_ref_no: generatedRef }
    });

    res.status(201).json({
      message: "Manual payment recorded and subscription contract extended successfully.",
      data: newPayment
    });

  } catch (err) {
    console.error("recordManualSubscriptionPayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Get all setup fee payments
const getSetupFeePayments = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("setup_fee_payments")
      .select("*, marriage_halls(hall_name), packages(name)")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("getSetupFeePayments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Update a setup fee payment (Record a payment collection)
const updateSetupFeePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_paid, payment_method, transaction_ref_no, notes = "" } = req.body;

    if (amount_paid === undefined || amount_paid < 0) {
      return res.status(400).json({ message: "Valid amount_paid is required" });
    }

    // Get current record
    const { data: record, error: getErr } = await supabaseAdmin
      .from("setup_fee_payments")
      .select("setup_fee_amount, amount_paid")
      .eq("id", id)
      .maybeSingle();

    if (getErr || !record) {
      return res.status(404).json({ message: "Setup fee payment record not found" });
    }

    const newAmountPaid = parseFloat(amount_paid);
    const setupFeeAmount = parseFloat(record.setup_fee_amount);

    let status = "unpaid";
    if (newAmountPaid >= setupFeeAmount) {
      status = "paid";
    } else if (newAmountPaid > 0) {
      status = "partially_paid";
    }

    const { data: updatedRecord, error: updErr } = await supabaseAdmin
      .from("setup_fee_payments")
      .update({
        amount_paid: newAmountPaid,
        status,
        payment_method,
        transaction_ref_no,
        notes: notes || "Recorded manually by Admin.",
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (updErr) return res.status(500).json({ message: updErr.message });

    res.json({
      message: "Setup fee payment updated successfully.",
      data: updatedRecord
    });
  } catch (err) {
    console.error("updateSetupFeePayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const generateCustomAdminInvoice = async (req, res) => {
  try {
    const {
      hall_id,
      invoice_no,
      invoice_date,
      due_date,
      items = [],
      tax_enabled = false,
      tax_percentage = 18,
      payment_method = "bank_transfer",
      transaction_ref_no = "",
      notes = "",
      amount_paid = 0,
      balance_due,
      bill_to_name,
      bill_to_phone,
      bill_to_email,
      bill_to_address
    } = req.body;

    if (!hall_id || items.length === 0) {
      return res.status(400).send("<h3>Missing required parameters (hall_id, items)</h3>");
    }

    // Fetch hall profile and info
    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name, owner_name")
      .eq("id", hall_id)
      .maybeSingle();

    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("*")
      .eq("hall_id", hall_id)
      .maybeSingle();

    // Fetch admin settings
    const { data: settings } = await supabaseAdmin
      .from("admin_settings")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const companyName = "Infovex Technologies";
    const companyGstin = settings?.gstin || "33AAFCI8876F1Z8";
    const supportPhone = "+91 8681831689";
    const supportEmail = "contact@infovextech.com";
    const invoicePrefix = settings?.invoice_prefix || "INF-GEN-";

    const hallName = hall?.hall_name || "Venue Host";
    const ownerName = bill_to_name || hall?.owner_name || "Hall Owner";
    const clientAddress = bill_to_address || profile?.address || "";
    const clientCity = !bill_to_address ? (profile?.city || "") : "";
    const clientState = !bill_to_address ? (profile?.state || "") : "";
    const clientGstin = profile?.gst_number || "N/A";

    const invNo = invoice_no || `${invoicePrefix}${Date.now().toString().slice(-6)}`;
    const invDate = invoice_date ? new Date(invoice_date).toLocaleDateString("en-GB") : new Date().toLocaleDateString("en-GB");
    const dueDateFormatted = due_date ? new Date(due_date).toLocaleDateString("en-GB") : "";

    // Calculations
    let subtotal = 0;
    const computedItems = items.map(item => {
      const rate = parseFloat(item.rate || 0);
      const qty = parseFloat(item.qty || 1);
      const amount = rate * qty;
      subtotal += amount;
      return {
        description: item.description,
        qty,
        rate,
        amount
      };
    });

    const taxEnabled = !!tax_enabled;
    const taxRatePercent = parseFloat(tax_percentage !== undefined ? tax_percentage : 18);
    const taxRate = taxRatePercent / 100;
    let cgst = 0;
    let sgst = 0;
    let totalAmount = subtotal;

    if (taxEnabled) {
      cgst = subtotal * (taxRate / 2);
      sgst = subtotal * (taxRate / 2);
      totalAmount = subtotal + cgst + sgst;
    }

    const amtPaidVal = parseFloat(amount_paid || 0);
    const balDueVal = balance_due !== undefined ? parseFloat(balance_due) : Math.max(0, totalAmount - amtPaidVal);

    const symbol = "₹";
    const fmt = (val) => `${symbol}${Number(val).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let taxRows = "";
    if (taxEnabled) {
      taxRows = `
        <tr>
          <td style="padding: 6px 0; color: #64748b;">CGST (${taxRatePercent / 2}%):</td>
          <td style="padding: 6px 0; text-align: right; font-family: monospace; color: #334155; font-weight: 600;">${fmt(cgst)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">SGST (${taxRatePercent / 2}%):</td>
          <td style="padding: 6px 0; text-align: right; font-family: monospace; color: #334155; font-weight: 600;">${fmt(sgst)}</td>
        </tr>
      `;
    }

    const itemsRowsHtml = computedItems.map(item => `
      <tr>
        <td>
          <div class="item-desc">${item.description}</div>
        </td>
        <td style="text-align: right;">${item.qty}</td>
        <td style="text-align: right; font-family: monospace;">${fmt(item.rate)}</td>
        <td style="text-align: right; font-weight: 600; font-family: monospace;">${fmt(item.amount)}</td>
      </tr>
    `).join("");

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Invoice - ${invNo}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    
    @page {
      size: auto;
      margin: 10mm;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      color: #0f172a;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
      line-height: 1.4;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .invoice-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 15px;
    }

    .brand-accent-bar {
      height: 6px;
      background: linear-gradient(90deg, #4f46e5 0%, #062089 100%);
      border-radius: 4px;
      margin-bottom: 24px;
    }

    .header-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }

    .header-table td {
      vertical-align: top;
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-badge {
      height: 36px;
      width: 36px;
      background: #062089;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-weight: 800;
      font-size: 18px;
    }

    .logo-text-block {
      display: flex;
      flex-direction: column;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 800;
      color: #062089;
      line-height: 1.1;
      letter-spacing: -0.5px;
    }

    .logo-sub {
      font-size: 9px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .invoice-title-block {
      text-align: right;
    }

    .invoice-title {
      font-size: 24px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 6px 0;
    }

    .meta-details {
      font-size: 11px;
      color: #475569;
      font-weight: 500;
      line-height: 1.6;
    }

    .meta-details strong {
      color: #0f172a;
    }

    .status-badge-container {
      margin-top: 8px;
    }

    .status-badge-paid {
      background: #dcfce7;
      color: #15803d;
      border: 1px solid #bbf7d0;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: 800;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-block;
    }

    .status-badge-partial {
      background: #fef3c7;
      color: #b45309;
      border: 1px solid #fde68a;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: 800;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-block;
    }

    .status-badge-unpaid {
      background: #ffe4e6;
      color: #b91c1c;
      border: 1px solid #fecdd3;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: 800;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-block;
    }

    .address-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 28px;
    }

    .address-table td {
      width: 50%;
      vertical-align: top;
    }

    .address-block-left {
      border-left: 3px solid #062089;
      padding-left: 14px;
      margin-right: 14px;
    }

    .address-block-right {
      border-left: 3px solid #64748b;
      padding-left: 14px;
      margin-left: 14px;
    }

    .address-title {
      font-size: 10px;
      font-weight: 800;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }

    .address-name {
      font-size: 13px;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 4px 0;
    }

    .address-text {
      font-size: 11px;
      color: #475569;
      margin: 0;
      font-weight: 500;
      line-height: 1.5;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }

    .items-table th {
      background-color: #f8fafc;
      color: #475569;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 10px 14px;
      text-align: left;
      border-bottom: 2px solid #e2e8f0;
    }

    .items-table td {
      padding: 14px;
      font-size: 11px;
      border-bottom: 1px solid #f1f5f9;
      color: #334155;
    }

    .item-desc {
      font-weight: 700;
      color: #0f172a;
    }

    .payment-info-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px;
      font-size: 11px;
      color: #475569;
      line-height: 1.6;
    }

    .payment-info-title {
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      margin-bottom: 8px;
      font-size: 10px;
      letter-spacing: 0.5px;
    }

    .totals-table {
      width: 100%;
      border-collapse: collapse;
    }

    .totals-table td {
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 500;
      color: #475569;
    }

    .totals-table tr.total-billed-row {
      border-top: 1px solid #cbd5e1;
      font-size: 12px;
      font-weight: bold;
    }

    .totals-table tr.total-billed-row td {
      padding-top: 10px;
      color: #0f172a;
      font-weight: 800;
    }

    .totals-table tr.amount-paid-row td {
      color: #16a34a;
      font-weight: 700;
    }

    .totals-table tr.balance-due-row td {
      font-weight: 800;
    }

    .balance-due-pill {
      background: #ffe4e6;
      color: #b91c1c;
      border: 1px solid #fecdd3;
      padding: 4px 10px;
      border-radius: 6px;
      display: inline-block;
      font-family: monospace;
    }

    .balance-due-pill.paid {
      background: #dcfce7;
      color: #15803d;
      border: 1px solid #bbf7d0;
    }

    .footer-note {
      font-size: 10px;
      color: #94a3b8;
      text-align: center;
      margin-top: 48px;
      font-weight: 600;
      border-top: 1px solid #f1f5f9;
      padding-top: 12px;
    }

    @media print {
      body {
        margin: 0;
        background-color: #ffffff;
      }
      .invoice-container {
        padding: 0;
      }
      .brand-accent-bar {
        height: 4px;
      }
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <div class="brand-accent-bar"></div>

    <table class="header-table">
      <tr>
        <td>
          <div class="logo-container">
            <img src="/logo.png" alt="Infovex Halls Logo" style="height: 40px; object-fit: contain;">
          </div>
        </td>
        <td class="invoice-title-block">
          <div class="invoice-title">Tax Invoice</div>
          <div class="meta-details">
            <div>Invoice No: <strong>${invNo}</strong></div>
            <div>Date: <strong>${invDate}</strong></div>
            ${dueDateFormatted ? `<div>Due Date: <strong>${dueDateFormatted}</strong></div>` : ""}
            <div class="status-badge-container">
              ${(() => {
                if (balDueVal <= 0) {
                  return '<span class="status-badge-paid">Paid</span>';
                } else if (amtPaidVal > 0) {
                  return '<span class="status-badge-partial">Partially Paid</span>';
                } else {
                  return '<span class="status-badge-unpaid">Unpaid</span>';
                }
              })()}
            </div>
          </div>
        </td>
      </tr>
    </table>

    <table class="address-table">
      <tr>
        <td>
          <div class="address-block-left">
            <div class="address-title">Billed By</div>
            <div class="address-name">${companyName}</div>
            <div class="address-text">
              Email: ${supportEmail}<br>
              Phone: ${supportPhone}
            </div>
          </div>
        </td>
        <td>
          <div class="address-block-right">
            <div class="address-title">Billed To</div>
            <div class="address-name">${hallName}</div>
            <div class="address-text">
              Proprietor: ${ownerName}<br>
              ${bill_to_phone ? `Phone: ${bill_to_phone}<br>` : ""}
              ${bill_to_email ? `Email: ${bill_to_email}<br>` : ""}
              ${clientAddress ? `${clientAddress}, ` : ""}${clientCity ? `${clientCity}, ` : ""}${clientState}<br>
              GSTIN: ${clientGstin}
            </div>
          </div>
        </td>
      </tr>
    </table>

    <table class="items-table">
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align: right; width: 80px;">Qty</th>
          <th style="text-align: right; width: 130px;">Rate</th>
          <th style="text-align: right; width: 130px;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRowsHtml}
      </tbody>
    </table>

    <table style="width: 100%; border-collapse: collapse;">
      <tr>
        <td style="width: 52%; vertical-align: top;">
          <div class="payment-info-card">
            <div class="payment-info-title">Transaction & Remittance Details</div>
            <div style="margin-bottom: 4px;">Payment Method: <strong style="text-transform: uppercase; color: #0f172a;">${payment_method.replace('_', ' ')}</strong></div>
            ${transaction_ref_no ? `<div style="margin-bottom: 4px;">Reference / UTR: <strong style="font-family: monospace; color: #0f172a;">${transaction_ref_no}</strong></div>` : ""}
            ${notes ? `<div style="margin-top: 8px; font-style: italic; color: #475569; border-left: 2px solid #cbd5e1; padding-left: 8px;">Notes: ${notes}</div>` : ""}
          </div>
        </td>
        <td style="width: 48%; vertical-align: top;">
          <table class="totals-table">
            <tr>
              <td style="color: #64748b;">Subtotal:</td>
              <td style="text-align: right; font-family: monospace; color: #334155; font-weight: 600;">${fmt(subtotal)}</td>
            </tr>
            ${taxRows}
            <tr class="total-billed-row">
              <td>Total Billed:</td>
              <td style="text-align: right; font-family: monospace; font-size: 13px;">${fmt(totalAmount)}</td>
            </tr>
            <tr class="amount-paid-row">
              <td style="color: #16a34a; font-weight: bold;">Amount Received:</td>
              <td style="text-align: right; font-family: monospace; font-weight: bold;">${fmt(amtPaidVal)}</td>
            </tr>
            <tr class="balance-due-row">
              <td style="font-weight: 800; color: #0f172a; padding-top: 8px;">Balance Due:</td>
              <td style="text-align: right; padding-top: 8px;">
                <span class="balance-due-pill ${balDueVal <= 0 ? 'paid' : ''}">
                  ${fmt(balDueVal)}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <div class="footer-note">
      Powered by Infovex Halls — India's First dedicated Venue CRM by Infovex Technologies
    </div>
  </div>
</body>
</html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(htmlContent);
  } catch (err) {
    console.error("generateCustomAdminInvoice error:", err);
    res.status(500).send("<h3>Internal Server Error</h3>");
  }
};

const changeUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    // 1. Get user profile
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("auth_user_id, email, hall_id")
      .eq("id", id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Update Supabase Auth user password
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      user.auth_user_id,
      { password: password }
    );

    if (authError) {
      return res.status(400).json({ message: `Auth update failed: ${authError.message}` });
    }

    // 3. Encrypt and save backup_password_enc
    const cryptoHelper = require("../utils/cryptoHelper");
    const backup_password_enc = cryptoHelper.encrypt(password);

    const { error: updateError } = await supabaseAdmin
      .from("users")
      .update({ backup_password_enc, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ message: `Failed to update local user backup: ${updateError.message}` });
    }

    // 4. Log activity notification
    try {
      await createNotification({
        hall_id: user.hall_id,
        type: "alert",
        title: "Password Changed by Admin",
        message: `Super Admin manually changed password for user ${user.email}.`,
      });
    } catch (notifyErr) {
      console.warn("Failed to create password change notification:", notifyErr.message);
    }

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("changeUserPassword error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const adjustHallSubscription = async (req, res) => {
  try {
    const { id } = req.params; // this can be subscription ID or hall ID
    const { end_date, grace_days, status } = req.body;

    // First, find the subscription row by subscription ID
    let { data: sub, error: fetchError } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fetchError || !sub) {
      // Try fetching by hall_id just in case the client sent the hall_id
      const { data: subByHall, error: fetchByHallError } = await supabaseAdmin
        .from("hall_subscriptions")
        .select("*")
        .eq("hall_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subByHall) {
        sub = subByHall;
      } else {
        return res.status(404).json({ message: "Subscription record not found" });
      }
    }

    const updates = {};
    if (end_date) {
      updates.end_date = end_date;
    }
    if (grace_days) {
      const currentEndDate = new Date(sub.end_date);
      const baseDate = isNaN(currentEndDate.getTime()) || currentEndDate < new Date() ? new Date() : currentEndDate;
      baseDate.setDate(baseDate.getDate() + parseInt(grace_days));
      updates.end_date = baseDate.toISOString().split("T")[0];
    }
    if (status) {
      updates.status = status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No adjust parameters provided" });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updatedSub, error: updateError } = await supabaseAdmin
      .from("hall_subscriptions")
      .update(updates)
      .eq("id", sub.id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ message: updateError.message });
    }

    // If status is active, also ensure the hall status is set to active
    if (status === "active" || updates.status === "active") {
      await supabaseAdmin
        .from("marriage_halls")
        .update({ status: "active" })
        .eq("id", sub.hall_id);
    }

    res.json({ message: "Subscription adjusted successfully", data: updatedSub });
  } catch (err) {
    console.error("adjustHallSubscription error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

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
  getPendingSubscriptionPayments,
  verifySubscriptionPayment,
  sendTestEmail,
  getHallSubscriptionPayments,
  recordManualSubscriptionPayment,
  getSetupFeePayments,
  updateSetupFeePayment,
  generateCustomAdminInvoice,
  changeUserPassword,
  adjustHallSubscription,
};

const exportSaaSgstr1Report = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;

    if (!from_date || !to_date) {
      return res.status(400).json({ message: "from_date and to_date are required" });
    }

    const { data: payments, error } = await supabaseAdmin
      .from("subscription_payments")
      .select(`
        *,
        marriage_halls ( hall_name )
      `)
      .eq("status", "approved")
      .gte("verified_at", `${from_date}T00:00:00.000Z`)
      .lte("verified_at", `${to_date}T23:59:59.999Z`)
      .order("verified_at", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    const hallIds = [...new Set((payments || []).map(p => p.hall_id))];
    let profilesMap = {};
    if (hallIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("hall_profiles")
        .select("hall_id, gst_number, state")
        .in("hall_id", hallIds);
      
      (profiles || []).forEach(p => {
        profilesMap[p.hall_id] = p;
      });
    }

    let csvContent = "Invoice/Transaction ID,Verification Date,Hall Name,Customer GSTIN,Subtotal,CGST Rate %,CGST Amount,SGST Rate %,SGST Amount,Total Amount,Payment Method,UTR Reference,Place of Supply\n";

    (payments || []).forEach(pay => {
      const txId = pay.id.slice(0, 8).toUpperCase();
      const date = pay.verified_at ? pay.verified_at.split("T")[0] : "";
      const hallName = pay.marriage_halls?.hall_name || "Unknown Hall";
      const profile = profilesMap[pay.hall_id];
      const customerGstin = profile?.gst_number || "URP";
      const totalVal = parseFloat(pay.amount) || 0;
      
      const taxEnabled = pay.tax_enabled !== false;
      const subtotalVal = taxEnabled ? Math.round((totalVal / 1.18) * 100) / 100 : totalVal;
      const taxAmount = taxEnabled ? Math.round((totalVal - subtotalVal) * 100) / 100 : 0;
      const cgstAmt = taxAmount / 2;
      const sgstAmt = taxAmount / 2;
      const cgstRate = taxEnabled ? 9 : 0;
      const sgstRate = taxEnabled ? 9 : 0;
      const placeOfSupply = profile?.state || "Local";

      csvContent += `"${txId}","${date}","${hallName.replace(/"/g, '""')}","${customerGstin}",${subtotalVal},${cgstRate}%,${cgstAmt},${sgstRate}%,${sgstAmt},${totalVal},"${pay.payment_method}","${pay.transaction_ref_no}","${placeOfSupply}"\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=SaaS_GSTR1_Report_${from_date}_to_${to_date}.csv`);
    res.status(200).send(csvContent);
  } catch (err) {
    console.error("exportSaaSgstr1Report error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getPublicFounderSlots = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("admin_settings")
      .select("founder_slots_claimed, founder_slots_total, testimonials, support_phone, support_email, company_name")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });

    res.json({
      slotsClaimed: data?.founder_slots_claimed ?? 14,
      totalSlots: data?.founder_slots_total ?? 20,
      testimonials: data?.testimonials ?? [],
      supportPhone: data?.support_phone ?? "+91 8681831689",
      supportEmail: data?.support_email ?? "contact@infovextech.com",
      companyName: data?.company_name ?? "Infovex Technologies",
    });
  } catch (err) {
    console.error("getPublicFounderSlots error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

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
  getPendingSubscriptionPayments,
  verifySubscriptionPayment,
  sendTestEmail,
  getHallSubscriptionPayments,
  recordManualSubscriptionPayment,
  getSetupFeePayments,
  updateSetupFeePayment,
  generateCustomAdminInvoice,
  changeUserPassword,
  adjustHallSubscription,
  exportSaaSgstr1Report,
  getPublicFounderSlots,
};