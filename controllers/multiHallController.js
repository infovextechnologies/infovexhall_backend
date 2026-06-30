const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

/* Get premium plan status */
const checkPremiumStatus = async (req, res) => {
  try {
    const hall_id = req.user.primary_hall_id || req.user.hall_id;
    const today = new Date().toISOString().split("T")[0];

    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(name, features)")
      .eq("hall_id", hall_id)
      .in("status", ["active", "trial"])
      .gte("end_date", today)
      .maybeSingle();

    const hasPremium = sub?.packages?.name?.toLowerCase().includes("premium") || 
                       sub?.packages?.features?.multi_hall || 
                       false;

    res.json({ premium: hasPremium, planName: sub?.packages?.name || "None" });
  } catch (err) {
    console.error("checkPremiumStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Enable or disable multi-hall management */
const toggleMultiHall = async (req, res) => {
  try {
    const { enabled } = req.body;
    const userId = req.user.id;

    if (enabled === undefined) {
      return res.status(400).json({ message: "enabled is required" });
    }

    if (enabled) {
      // Check premium tier
      const today = new Date().toISOString().split("T")[0];
      const subscriptionHallId = req.user.primary_hall_id || req.user.hall_id;
      const { data: sub } = await supabaseAdmin
        .from("hall_subscriptions")
        .select("package_id, packages(name, features)")
        .eq("hall_id", subscriptionHallId)
        .in("status", ["active", "trial"])
        .gte("end_date", today)
        .maybeSingle();

      const hasPremium = sub?.packages?.name?.toLowerCase().includes("premium") || 
                         sub?.packages?.features?.multi_hall || 
                         false;

      if (!hasPremium) {
        return res.status(403).json({ message: "Multi-hall management requires a Premium subscription plan." });
      }
    }

    const { error } = await supabaseAdmin
      .from("users")
      .update({ multi_hall_enabled: enabled })
      .eq("id", userId);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: `Multi-hall management ${enabled ? "enabled" : "disabled"}` });
  } catch (err) {
    console.error("toggleMultiHall error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Toggle Different vs Shared Staff management */
const toggleDifferentStaff = async (req, res) => {
  try {
    const { enabled } = req.body; // true = separate staff, false = shared staff
    const userId = req.user.id;

    if (enabled === undefined) {
      return res.status(400).json({ message: "enabled is required" });
    }

    // Update setting on user profile
    const { error: userErr } = await supabaseAdmin
      .from("users")
      .update({ different_staff_management: enabled })
      .eq("id", userId);

    if (userErr) return res.status(500).json({ message: userErr.message });

    // Get owner's halls
    const { data: ownerHalls } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", userId);

    const hallIds = (ownerHalls || []).map((oh) => oh.hall_id);

    // Get all staff users under these halls
    const { data: staffList } = await supabaseAdmin
      .from("users")
      .select("id, hall_id")
      .in("hall_id", hallIds)
      .neq("role", "owner")
      .neq("role", "super_admin");

    if (staffList && staffList.length > 0) {
      if (!enabled) {
        // Shared Staff: Link everyone to all owner halls
        const links = [];
        staffList.forEach((staff) => {
          hallIds.forEach((hId) => {
            links.push({ user_id: staff.id, hall_id: hId });
          });
        });
        if (links.length > 0) {
          await supabaseAdmin.from("user_halls").upsert(links, { onConflict: "user_id,hall_id" });
        }
      } else {
        // Separate Staff: Remove links to other halls, keeping only their primary hall
        for (const staff of staffList) {
          await supabaseAdmin
            .from("user_halls")
            .delete()
            .eq("user_id", staff.id)
            .neq("hall_id", staff.hall_id);
        }
      }
    }

    res.json({ message: `Staff management set to ${enabled ? "different" : "shared"}` });
  } catch (err) {
    console.error("toggleDifferentStaff error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Register a secondary hall under the login */
const registerSecondHall = async (req, res) => {
  try {
    const { hall_name, phone, email, address, city } = req.body;
    const userId = req.user.id;

    if (!hall_name) return res.status(400).json({ message: "hall_name is required" });

    // Validate premium status
    const today = new Date().toISOString().split("T")[0];
    const subscriptionHallId = req.user.primary_hall_id || req.user.hall_id;
    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(name, features)")
      .eq("hall_id", subscriptionHallId)
      .in("status", ["active", "trial"])
      .gte("end_date", today)
      .maybeSingle();

    const hasPremium = sub?.packages?.name?.toLowerCase().includes("premium") || 
                       sub?.packages?.features?.multi_hall || 
                       false;

    if (!hasPremium) {
      return res.status(403).json({ message: "Registering a second hall requires a Premium plan subscription." });
    }

    // Verify limit of 2 halls
    const { data: ownerHalls } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", userId);

    if (ownerHalls && ownerHalls.length >= 2) {
      return res.status(400).json({ message: "You have reached the maximum limit of 2 halls." });
    }

    // Insert new secondary hall record
    const { data: newHall, error: hallErr } = await supabaseAdmin
      .from("marriage_halls")
      .insert([{
        hall_name,
        phone: phone || req.user.phone || "",
        email: email || req.user.email || "",
        address: address || "",
        city: city || "",
        status: "active",
      }])
      .select()
      .single();

    if (hallErr) return res.status(500).json({ message: hallErr.message });

    // Setup basic settings row
    await supabaseAdmin.from("hall_settings").insert([{
      hall_id: newHall.id,
      timezone: "Asia/Kolkata",
    }]);

    // Create user mapping
    await supabaseAdmin.from("user_halls").insert([{
      user_id: userId,
      hall_id: newHall.id,
    }]);

    // Share subscription plan with the new hall
    if (sub) {
      await supabaseAdmin.from("hall_subscriptions").insert([{
        hall_id: newHall.id,
        package_id: sub.package_id,
        status: "active",
        payment_status: "paid",
        end_date: sub.end_date,
      }]);
    }

    // Link staff to the new hall if shared staff mode is currently active
    if (!req.user.different_staff_management) {
      const hallIds = (ownerHalls || []).map((oh) => oh.hall_id);
      const { data: staffList } = await supabaseAdmin
        .from("users")
        .select("id")
        .in("hall_id", hallIds)
        .neq("role", "owner")
        .neq("role", "super_admin");

      if (staffList && staffList.length > 0) {
        const links = staffList.map((staff) => ({
          user_id: staff.id,
          hall_id: newHall.id,
        }));
        await supabaseAdmin.from("user_halls").insert(links);
      }
    }

    // Log Activity
    await logActivity({
      hall_id: req.user.hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "multihall.registered",
      entity_type: "hall",
      entity_id: newHall.id,
      description: `Registered secondary hall: ${hall_name}`,
    });

    res.status(201).json({
      message: "Secondary hall registered successfully",
      hall: newHall,
    });
  } catch (err) {
    console.error("registerSecondHall error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  checkPremiumStatus,
  toggleMultiHall,
  toggleDifferentStaff,
  registerSecondHall,
};
