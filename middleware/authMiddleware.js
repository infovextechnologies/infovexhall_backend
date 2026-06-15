const { supabaseAdmin } = require("../config/supabase");
const { syncExpiredSubscriptions } = require("../utils/subscriptionHelper");

/**
 * Verifies Supabase JWT token from Authorization header.
 * Attaches req.user = { id, email, role, hall_id, ... }
 */
module.exports = async (req, res, next) => {
  // Sync expired subscriptions first
  await syncExpiredSubscriptions();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify with Supabase Auth — this validates the JWT signature
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    // Fetch full user profile from our users table using auth_user_id
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id, name, email, role, hall_id, auth_user_id, multi_hall_enabled, different_staff_management, status")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (profileError) {
      return res.status(500).json({ message: "Error fetching user profile" });
    }

    const activeHallId = req.headers["x-active-hall-id"] || req.headers["x-active-hall-id".toLowerCase()];

    if (!profile) {
      // Could be super_admin — check super_admins table
      const { data: adminProfile } = await supabaseAdmin
        .from("super_admins")
        .select("id, name, email")
        .eq("auth_user_id", user.id)
        .maybeSingle();

      if (!adminProfile) {
        return res.status(401).json({ message: "User profile not found" });
      }

      req.user = { ...adminProfile, role: "super_admin" };
      if (activeHallId) {
        req.user.hall_id = activeHallId;
      }
      return next();
    }

    req.user = profile;
    req.user.primary_hall_id = profile.hall_id;

    // Verify and switch dynamic hall context if header provided
    if (activeHallId) {
      let canSwitch = false;
      if (profile.role === "owner" && profile.multi_hall_enabled) {
        canSwitch = true;
      } else if (profile.role === "manager" || profile.role === "staff") {
        // Check if the owner of their primary hall has multi_hall_enabled = true AND different_staff_management = false
        const { data: owner } = await supabaseAdmin
          .from("users")
          .select("multi_hall_enabled, different_staff_management")
          .eq("hall_id", profile.hall_id)
          .eq("role", "owner")
          .maybeSingle();
        
        if (owner && owner.multi_hall_enabled && !owner.different_staff_management) {
          canSwitch = true;
        }
      }

      if (canSwitch) {
        if (activeHallId === "all") {
          if (profile.role === "owner") {
            req.user.hall_id = "all";
          }
        } else {
          const { data: link, error: linkErr } = await supabaseAdmin
            .from("user_halls")
            .select("hall_id")
            .eq("user_id", profile.id)
            .eq("hall_id", activeHallId)
            .maybeSingle();

          if (!linkErr && link) {
            req.user.hall_id = activeHallId;
          }
        }
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized: Token verification failed" });
  }
};