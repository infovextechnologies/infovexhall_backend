const { supabase, supabaseAdmin } = require("../config/supabase");
const bcrypt = require("bcryptjs");

/* ============================================================
   LOGIN
   Uses Supabase Auth — returns a Supabase JWT.
   This token is used for all subsequent API calls AND
   for direct Supabase client calls (RLS uses this token).
   ============================================================ */
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ message: error.message });
    }

    const authUserId = data.user.id;

    // Check if super_admin
    const { data: admin } = await supabaseAdmin
      .from("super_admins")
      .select("id, name, email")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (admin) {
      return res.json({
        message: "Login successful",
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        role: "super_admin",
        user: { ...admin, role: "super_admin" },
      });
    }

    // Regular user
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id, name, email, role, hall_id, multi_hall_enabled, different_staff_management, status")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    // Fetch accessible halls list
    const { data: userHalls } = await supabaseAdmin
      .from("user_halls")
      .select("marriage_halls ( id, hall_name )")
      .eq("user_id", user.id);

    const accessibleHalls = (userHalls || [])
      .map((h) => h.marriage_halls)
      .filter(Boolean);

    return res.json({
      message: "Login successful",
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      role: user.role,
      user: {
        ...user,
        accessible_halls: accessibleHalls,
      },
    });
  } catch (err) {
    console.error("loginUser error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   REFRESH TOKEN
   ============================================================ */
const refreshToken = async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ message: "refresh_token is required" });
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error) {
      return res.status(401).json({ message: error.message });
    }

    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET PROFILE
   Returns the decoded user from authMiddleware
   ============================================================ */
const getProfile = async (req, res) => {
  try {
    if (req.user.role === "super_admin") {
      return res.json({
        message: "Profile fetched successfully",
        user: {
          ...req.user,
          accessible_halls: [],
        },
      });
    }

    const { data: userHalls } = await supabaseAdmin
      .from("user_halls")
      .select("marriage_halls ( id, hall_name )")
      .eq("user_id", req.user.id);

    const accessibleHalls = (userHalls || [])
      .map((h) => h.marriage_halls)
      .filter(Boolean);

    res.json({
      message: "Profile fetched successfully",
      user: {
        ...req.user,
        accessible_halls: accessibleHalls,
      },
    });
  } catch (err) {
    console.error("getProfile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CREATE SUPER ADMIN (one-time bootstrap)
   Protected by a secret key in the request body.
   Run once to create the first super admin.
   ============================================================ */
const createSuperAdmin = async (req, res) => {
  try {
    const { name, email, password, bootstrap_secret } = req.body;

    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ message: "Bootstrap super admin creation is disabled in production environment" });
    }

    // Protect this endpoint with a secret set in .env
    if (bootstrap_secret !== process.env.BOOTSTRAP_SECRET) {
      return res.status(403).json({ message: "Invalid bootstrap secret" });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, and password are required" });
    }

    // Create user in Supabase Auth
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // auto-confirm super admin
      });

    if (authError) {
      return res.status(400).json({ message: authError.message });
    }

    // Hash password for super_admins table (table has NOT NULL constraint)
    const hashedPassword = await bcrypt.hash(password, 10);

    // Store in super_admins table
    const { data, error } = await supabaseAdmin
      .from("super_admins")
      .insert([{ name, email, password: hashedPassword, auth_user_id: authData.user.id }])
      .select("id, name, email")
      .single();

    if (error) {
      // Rollback auth user if DB insert fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ message: error.message });
    }

    res.status(201).json({
      message: "Super admin created successfully",
      data,
    });
  } catch (err) {
    console.error("createSuperAdmin error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  loginUser,
  refreshToken,
  getProfile,
  createSuperAdmin,
};