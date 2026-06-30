const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

// Helper to determine max halls supported by a package name
const getMaxHallsForPlan = (packageName = "") => {
  const name = packageName.toLowerCase();
  if (name.includes("premium") || name.includes("enterprise")) return 2;
  return 1; // Basic plans support only 1 hall
};

// Retrieve all halls owned by the logged-in owner
const getOwnerHalls = async (req, res) => {
  try {
    const userId = req.user.id;
    const primaryHallId = req.user.primary_hall_id || req.user.hall_id;

    // 1. Get all hall links for the owner
    const { data: userHalls, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", userId);

    if (linkErr) return res.status(500).json({ message: linkErr.message });

    const hallIds = [...new Set((userHalls || []).map((uh) => uh.hall_id))];
    if (hallIds.length === 0 && primaryHallId) {
      hallIds.push(primaryHallId);
    }

    if (hallIds.length === 0) {
      return res.json({ halls: [], subscription: null });
    }

    // 2. Fetch hall profiles
    const { data: hallsData, error: hallsErr } = await supabaseAdmin
      .from("marriage_halls")
      .select("*")
      .in("id", hallIds)
      .order("created_at", { ascending: true });

    if (hallsErr) return res.status(500).json({ message: hallsErr.message });

    // 3. Get active subscription details from primary hall
    const today = new Date().toISOString().split("T")[0];
    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("status, end_date, packages(name, price, features)")
      .eq("hall_id", primaryHallId)
      .in("status", ["active", "trial"])
      .gte("end_date", today)
      .maybeSingle();

    const planName = sub?.packages?.name || "Trial / Basic Plan";
    const maxHalls = getMaxHallsForPlan(planName);

    // 4. Construct rich hall objects with isolation metadata & staff/booking counters
    const enrichedHalls = [];
    for (const hall of (hallsData || [])) {
      // Get linked staff count (excluding owner role)
      const { data: linkedUsers } = await supabaseAdmin
        .from("user_halls")
        .select("user_id, users(role)")
        .eq("hall_id", hall.id);
      
      const staffCount = (linkedUsers || []).filter(
        (lu) => lu.users?.role !== "owner" && lu.users?.role !== "super_admin"
      ).length;

      // Get bookings count
      const { count: bookingsCount } = await supabaseAdmin
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("hall_id", hall.id);

      // Parse structured JSON address if exists
      let location = { address: hall.address || "", district: hall.city || "", state: "", pincode: "" };
      if (hall.address && hall.address.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(hall.address);
          location = {
            address: parsed.address || "",
            district: parsed.district || hall.city || "",
            state: parsed.state || "",
            pincode: parsed.pincode || "",
          };
        } catch (e) {
          // fallback to raw text
        }
      }

      enrichedHalls.push({
        id: hall.id,
        hall_name: hall.hall_name,
        role: hall.id === primaryHallId ? "Primary" : "Secondary",
        location,
        staffCount,
        bookingsCount: bookingsCount || 0,
        status: hall.status || "active",
        created_at: hall.created_at,
      });
    }

    // Count unique user IDs linked to these halls
    const { data: orgUserLinks } = await supabaseAdmin
      .from("user_halls")
      .select("user_id")
      .in("hall_id", hallIds);
    const uniqueUserIds = [...new Set((orgUserLinks || []).map((ul) => ul.user_id))];

    res.json({
      halls: enrichedHalls,
      subscription: {
        planName,
        status: sub?.status || "active",
        endDate: sub?.end_date || null,
        maxHalls,
        currentHalls: enrichedHalls.length,
        remainingHalls: Math.max(0, maxHalls - enrichedHalls.length),
        totalOrganizationUsers: uniqueUserIds.length,
      },
    });
  } catch (err) {
    console.error("getOwnerHalls error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Register a secondary hall
const createSecondaryHall = async (req, res) => {
  try {
    const { hall_name, address, district, state, pincode } = req.body;
    const userId = req.user.id;
    const primaryHallId = req.user.primary_hall_id || req.user.hall_id;

    if (!hall_name) return res.status(400).json({ message: "hall_name is required" });

    // 1. Enforce subscription limits
    const today = new Date().toISOString().split("T")[0];
    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, status, end_date, packages(name)")
      .eq("hall_id", primaryHallId)
      .in("status", ["active", "trial"])
      .gte("end_date", today)
      .maybeSingle();

    const planName = sub?.packages?.name || "Trial / Basic Plan";
    const maxHalls = getMaxHallsForPlan(planName);

    // Get current owned halls count
    const { data: ownerHalls } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", userId);

    const currentCount = [...new Set((ownerHalls || []).map((oh) => oh.hall_id))].length;

    if (currentCount >= maxHalls) {
      return res.status(400).json({
        message: `You have reached the maximum limit of ${maxHalls} halls supported by your ${planName}.`,
      });
    }

    // 2. Serialize location metadata & save hall profile
    const serializedAddress = JSON.stringify({
      address: address || "",
      district: district || "",
      state: state || "",
      pincode: pincode || "",
    });

    const { data: newHall, error: hallErr } = await supabaseAdmin
      .from("marriage_halls")
      .insert([{
        hall_name,
        phone: req.user.phone || "",
        email: req.user.email || "",
        address: serializedAddress,
        city: district || "",
        status: "active",
        owner_name: req.user.name,
      }])
      .select()
      .single();

    if (hallErr) return res.status(500).json({ message: hallErr.message });

    // 3. Setup basic settings row
    await supabaseAdmin.from("hall_settings").insert([{
      hall_id: newHall.id,
      timezone: "Asia/Kolkata",
    }]);

    // 4. Link owner in user_halls
    await supabaseAdmin.from("user_halls").insert([{
      user_id: userId,
      hall_id: newHall.id,
    }]);

    // 5. Inherit Primary Hall subscription
    if (sub) {
      await supabaseAdmin.from("hall_subscriptions").insert([{
        hall_id: newHall.id,
        package_id: sub.package_id,
        status: sub.status,
        payment_status: "paid",
        end_date: sub.end_date,
      }]);
    }

    // 6. Link staff to new hall if shared staff mode is active
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
      hall_id: primaryHallId,
      user_id: userId,
      user_name: req.user.name,
      action: "multihall.created",
      entity_type: "hall",
      entity_id: newHall.id,
      description: `Created secondary hall: ${hall_name}`,
    });

    res.status(201).json({
      message: "Secondary hall registered successfully",
      hall: {
        id: newHall.id,
        hall_name: newHall.hall_name,
        role: "Secondary",
        location: { address, district, state, pincode },
        staffCount: 0,
        bookingsCount: 0,
        status: "active",
        created_at: newHall.created_at,
      },
    });
  } catch (err) {
    console.error("createSecondaryHall error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Update secondary hall location & profile details
const updateSecondaryHall = async (req, res) => {
  try {
    const { id } = req.params;
    const { hall_name, address, district, state, pincode, status } = req.body;
    const userId = req.user.id;

    // Verify ownership
    const { data: link, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", userId)
      .eq("hall_id", id)
      .maybeSingle();

    if (linkErr || !link) {
      return res.status(403).json({ message: "You do not own this hall" });
    }

    const serializedAddress = JSON.stringify({
      address: address || "",
      district: district || "",
      state: state || "",
      pincode: pincode || "",
    });

    const updateFields = {};
    if (hall_name !== undefined) updateFields.hall_name = hall_name;
    if (address !== undefined || district !== undefined || state !== undefined || pincode !== undefined) {
      updateFields.address = serializedAddress;
    }
    if (district !== undefined) updateFields.city = district;
    if (status !== undefined) updateFields.status = status;

    const { data: updatedHall, error: updateErr } = await supabaseAdmin
      .from("marriage_halls")
      .update(updateFields)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ message: updateErr.message });

    res.json({
      message: "Hall updated successfully",
      hall: updatedHall,
    });
  } catch (err) {
    console.error("updateSecondaryHall error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Delete secondary hall
const deleteSecondaryHall = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const primaryHallId = req.user.primary_hall_id || req.user.hall_id;

    if (id === primaryHallId) {
      return res.status(400).json({ message: "You cannot delete your Primary Hall profile" });
    }

    // Verify ownership
    const { data: link, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", userId)
      .eq("hall_id", id)
      .maybeSingle();

    if (linkErr || !link) {
      return res.status(403).json({ message: "You do not own this hall" });
    }

    // Perform atomic cascade delete operations
    await Promise.all([
      supabaseAdmin.from("hall_settings").delete().eq("hall_id", id),
      supabaseAdmin.from("hall_subscriptions").delete().eq("hall_id", id),
      supabaseAdmin.from("user_halls").delete().eq("hall_id", id),
      supabaseAdmin.from("bookings").delete().eq("hall_id", id),
      supabaseAdmin.from("marriage_halls").delete().eq("id", id),
    ]);

    // Log Activity
    await logActivity({
      hall_id: primaryHallId,
      user_id: userId,
      user_name: req.user.name,
      action: "multihall.deleted",
      entity_type: "hall",
      entity_id: id,
      description: `Deleted secondary hall profile: ${id}`,
    });

    res.json({ message: "Secondary hall and all associated records deleted successfully" });
  } catch (err) {
    console.error("deleteSecondaryHall error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Switch active hall context
const switchHallContext = async (req, res) => {
  try {
    const { hall_id } = req.body;
    const userId = req.user.id;

    if (!hall_id) return res.status(400).json({ message: "hall_id is required" });

    if (hall_id === "all") {
      return res.json({ message: "Switched to global view successfully", activeHallId: "all" });
    }

    // Verify connection to the target hall
    const { data: link, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", userId)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (linkErr || !link) {
      return res.status(403).json({ message: "Access denied to this hall workspace" });
    }

    res.json({ message: "Context switched successfully", activeHallId: hall_id });
  } catch (err) {
    console.error("switchHallContext error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Move a staff member between owned halls
const transferStaffMember = async (req, res) => {
  try {
    const { id } = req.params; // staff member's user ID
    const { target_hall_id } = req.body;
    const userId = req.user.id;

    if (!target_hall_id) return res.status(400).json({ message: "target_hall_id is required" });

    // 1. Verify owner owns the target hall
    const { data: targetLink } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", userId)
      .eq("hall_id", target_hall_id)
      .maybeSingle();

    if (!targetLink) {
      return res.status(403).json({ message: "You do not own the target hall" });
    }

    // 2. Verify staff member belongs to one of owner's halls
    const { data: ownerHalls } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", userId);

    const hallIds = (ownerHalls || []).map((oh) => oh.hall_id);

    const { data: staffMember, error: staffErr } = await supabaseAdmin
      .from("users")
      .select("id, name, hall_id")
      .eq("id", id)
      .in("hall_id", hallIds)
      .maybeSingle();

    if (staffErr || !staffMember) {
      return res.status(404).json({ message: "Staff member not found in your organization" });
    }

    const oldHallId = staffMember.hall_id;

    // 3. Migrate the staff member's core record
    const { error: updateErr } = await supabaseAdmin
      .from("users")
      .update({ hall_id: target_hall_id })
      .eq("id", id);

    if (updateErr) return res.status(500).json({ message: updateErr.message });

    // 4. Update access links
    if (req.user.different_staff_management) {
      // Separate Staff Mode: Delete connection to the old hall, add to the new hall
      await supabaseAdmin
        .from("user_halls")
        .delete()
        .eq("user_id", id)
        .eq("hall_id", oldHallId);

      await supabaseAdmin
        .from("user_halls")
        .upsert([{ user_id: id, hall_id: target_hall_id }]);
    } else {
      // Shared Staff Mode: Staff member should be linked to all halls
      const links = hallIds.map((hId) => ({ user_id: id, hall_id: hId }));
      await supabaseAdmin.from("user_halls").upsert(links, { onConflict: "user_id,hall_id" });
    }

    // Log Activity
    await logActivity({
      hall_id: target_hall_id,
      user_id: userId,
      user_name: req.user.name,
      action: "staff.transferred",
      entity_type: "user",
      entity_id: id,
      description: `Transferred staff member ${staffMember.name} to target venue`,
    });

    res.json({ message: `Successfully transferred ${staffMember.name} to target venue.` });
  } catch (err) {
    console.error("transferStaffMember error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getOwnerHalls,
  createSecondaryHall,
  updateSecondaryHall,
  deleteSecondaryHall,
  switchHallContext,
  transferStaffMember,
};
