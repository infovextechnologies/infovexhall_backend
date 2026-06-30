const { supabase, supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

let usersTableColumns = null;

const getUsersColumns = async () => {
  if (usersTableColumns) return usersTableColumns;
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("*")
      .limit(1);
    if (!error && data && data.length > 0) {
      usersTableColumns = Object.keys(data[0]);
      return usersTableColumns;
    }
  } catch (err) {
    console.error("Error getting users columns:", err);
  }
  return null;
};

const createStaff = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      phone,
      department,
      employee_id,
      joining_date,
      salary,
      address,
      city,
      state,
      emergency_contact_name,
      emergency_contact_phone,
      status,
      permissions,
      notes,
    } = req.body;
    const hall_id = req.user.hall_id === "all" ? req.user.primary_hall_id : req.user.hall_id;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, and password are required" });
    }

    // Check if email already in use
    const { data: existingUser } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ message: "Email is already registered" });
    }

    const { data: existingAdmin } = await supabaseAdmin
      .from("super_admins")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingAdmin) {
      return res.status(400).json({ message: "Email is already registered as an administrator" });
    }

    const allowedRoles = ["manager", "staff"];
    const staffRole = allowedRoles.includes(role) ? role : "staff";

    // ---- 1. Check active subscription + user limit ----
    const today = new Date().toISOString().split("T")[0];
    const subscriptionHallId = req.user.primary_hall_id || req.user.hall_id;

    const { data: sub, error: subError } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(max_users, name)")
      .eq("hall_id", subscriptionHallId)
      .in("status", ["active", "trial"])
      .gte("end_date", today)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subError || !sub) {
      return res.status(403).json({ message: "No active subscription found" });
    }

    const maxUsers = sub.packages?.max_users;
    const hasPayroll = false; // Payroll feature disabled universally

    if (salary !== undefined && Number(salary) > 0 && !hasPayroll) {
      return res.status(403).json({ message: "Salary/Payroll feature is locked under your current SaaS plan." });
    }

    if (maxUsers !== null && maxUsers !== undefined) {
      // Find all accessible hall IDs for the owner
      const { data: ownerHalls } = await supabaseAdmin
        .from("user_halls")
        .select("hall_id")
        .eq("user_id", req.user.id);
      
      const hallIds = [...new Set((ownerHalls || []).map((oh) => oh.hall_id))];
      if (!hallIds.includes(hall_id)) {
        hallIds.push(hall_id);
      }

      // Count unique user IDs linked to these halls
      const { data: orgUserLinks } = await supabaseAdmin
        .from("user_halls")
        .select("user_id")
        .in("hall_id", hallIds);
      const uniqueUserIds = [...new Set((orgUserLinks || []).map((ul) => ul.user_id))];

      if (uniqueUserIds.length >= maxUsers) {
        return res.status(403).json({
          message: `User limit reached. Your ${sub.packages.name} plan allows a maximum of ${maxUsers} user accounts across your entire organization. Please upgrade your plan.`,
        });
      }
    }

    // ---- 2. Create Supabase Auth user directly via admin client (email confirmation is disabled) ----
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, role: staffRole, hall_id }
    });

    if (authError || !authData?.user) {
      return res.status(400).json({ message: authError?.message || "Auth user creation failed" });
    }

    // ---- 3. Insert into users table ----
    const columns = await getUsersColumns();
    const cryptoHelper = require("../utils/cryptoHelper");
    const backup_password_enc = cryptoHelper.encrypt(password);
    
    const insertPayload = {
      name,
      email,
      password: "supabase_auth",
      role: staffRole,
      hall_id,
      auth_user_id: authData.user.id,
    };
    
    const addIfSupported = (field, value) => {
      if (!columns || columns.includes(field)) {
        insertPayload[field] = value;
      }
    };

    addIfSupported("phone", phone || null);
    addIfSupported("department", department || "other");
    addIfSupported("employee_id", employee_id || `HOD-${String(authData.user.id).substring(0, 3).toUpperCase()}`);
    addIfSupported("joining_date", joining_date || new Date().toISOString());
    addIfSupported("salary", (salary !== undefined && hasPayroll) ? Number(salary) : 0.00);
    addIfSupported("address", address || null);
    addIfSupported("city", city || null);
    addIfSupported("state", state || null);
    addIfSupported("emergency_contact_name", emergency_contact_name || null);
    addIfSupported("emergency_contact_phone", emergency_contact_phone || null);
    addIfSupported("status", status || "active");
    addIfSupported("permissions", permissions || []);
    addIfSupported("notes", notes || null);
    addIfSupported("backup_password_enc", backup_password_enc);

    const selectFields = columns
      ? ["id", "name", "email", "role", "hall_id", "created_at"].concat(
          ["phone", "department", "employee_id", "joining_date", "salary", "address", "city", "state", "emergency_contact_name", "emergency_contact_phone", "status", "permissions", "notes", "backup_password_enc"].filter(f => columns.includes(f))
        ).join(", ")
      : "id, name, email, role, hall_id, created_at";

    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .insert([insertPayload])
      .select(selectFields)
      .single();

    if (userError) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ message: userError.message });
    }

    // ---- 4. Link staff member in user_halls ----
    try {
      const isDifferentStaff = req.user.different_staff_management || false;
      if (isDifferentStaff) {
        // Link to active hall only
        await supabaseAdmin.from("user_halls").insert([{
          user_id: user.id,
          hall_id: hall_id,
        }]);
      } else {
        // Link to all of the owner's accessible halls
        const { data: ownerHalls } = await supabaseAdmin
          .from("user_halls")
          .select("hall_id")
          .eq("user_id", req.user.id);

        const links = (ownerHalls || []).map((oh) => ({
          user_id: user.id,
          hall_id: oh.hall_id,
        }));

        if (links.length > 0) {
          await supabaseAdmin.from("user_halls").insert(links);
        }
      }
    } catch (linkErr) {
      console.error("Error linking staff in user_halls:", linkErr);
      // Non-critical
    }

    // ---- 5. Log activity ----
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "staff.added",
      entity_type: "staff",
      entity_id: user.id,
      description: `Added staff member ${name} (${staffRole})`,
      metadata: { employee_id: user.employee_id, role: staffRole, department }
    });

    res.status(201).json({
      message: "Staff created successfully.",
      user,
    });
  } catch (err) {
    console.error("createStaff error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getStaff = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { search, role, department, status, page, limit } = req.query;

    const columns = await getUsersColumns();
    const requestedFields = [
      "id", "hall_id", "name", "email", "phone", "role", "department",
      "employee_id", "joining_date", "salary", "address", "city", "state",
      "emergency_contact_name", "emergency_contact_phone", "status",
      "permissions", "notes", "created_at", "updated_at", "backup_password_enc"
    ];
    const selectFields = columns
      ? requestedFields.filter(f => columns.includes(f)).join(", ")
      : requestedFields.filter(f => f !== "updated_at").join(", ");

    const isDifferentStaff = req.user.different_staff_management || false;
    let query;

    // Get all accessible hall IDs for the current user to support scoping properly
    const { data: ownerHalls, error: ownerHallsError } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", req.user.id);

    if (ownerHallsError) return res.status(500).json({ message: ownerHallsError.message });
    const accessibleHallIds = (ownerHalls || []).map(h => h.hall_id);

    const targetHallIds = hall_id === "all" ? accessibleHallIds : [hall_id];

    if (targetHallIds.length === 0) {
      return res.json([]);
    }

    if (isDifferentStaff) {
      query = supabaseAdmin
        .from("users")
        .select(selectFields)
        .in("hall_id", targetHallIds)
        .neq("role", "owner");
    } else {
      const { data: linkedUsers, error: linkError } = await supabaseAdmin
        .from("user_halls")
        .select("user_id")
        .in("hall_id", targetHallIds);

      if (linkError) return res.status(500).json({ message: linkError.message });

      const userIds = [...new Set((linkedUsers || []).map((u) => u.user_id))];
      if (userIds.length === 0) {
        // Fallback: If no links in user_halls yet (e.g. legacy/new users without user_halls mappings),
        // fallback to query staff directly registered under these hall IDs in the users table
        query = supabaseAdmin
          .from("users")
          .select(selectFields)
          .in("hall_id", targetHallIds)
          .neq("role", "owner");
      } else {
        query = supabaseAdmin
          .from("users")
          .select(selectFields)
          .in("id", userIds)
          .neq("role", "owner");
      }
    }

    if (role && role !== "all") {
      query = query.eq("role", role);
    }
    if (department && department !== "all") {
      query = query.eq("department", department);
    }
    if (status && status !== "all") {
      query = query.eq("status", status);
    }
    if (search) {
      const q = `%${search}%`;
      query = query.or(`name.ilike.${q},email.ilike.${q},employee_id.ilike.${q},phone.ilike.${q}`);
    }

    query = query.order("created_at", { ascending: false });

    if (page && limit) {
      const from = (parseInt(page) - 1) * parseInt(limit);
      const to = from + parseInt(limit) - 1;
      query = query.range(from, to);
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ message: error.message });

    const cryptoHelper = require("../utils/cryptoHelper");
    const decryptedData = (data || []).map((u) => {
      const decrypted = u.backup_password_enc ? cryptoHelper.decrypt(u.backup_password_enc) : null;
      return {
        ...u,
        backupPassword: decrypted,
        backup_password_enc: undefined
      };
    });

    res.json(decryptedData);
  } catch (err) {
    console.error("getStaff error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    // Get existing staff details first
    const { data: existing, error: existError } = await supabaseAdmin
      .from("users")
      .select("id, name, email, auth_user_id, role, hall_id")
      .eq("id", id)
      .maybeSingle();

    if (existError || !existing) {
      return res.status(404).json({ message: "Staff not found" });
    }

    // Get all accessible hall IDs for the current user to verify ownership
    const { data: ownerHalls, error: ownerHallsError } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", req.user.id);

    if (ownerHallsError) return res.status(500).json({ message: ownerHallsError.message });
    const accessibleHallIds = (ownerHalls || []).map(h => h.hall_id);

    // Verify staff belongs to any of the owner's accessible halls
    const { data: link, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", id)
      .in("hall_id", accessibleHallIds)
      .limit(1)
      .maybeSingle();

    if (linkErr || !link) {
      return res.status(404).json({ message: "Staff not found in your hall" });
    }

    const {
      name,
      email,
      phone,
      role,
      department,
      employee_id,
      joining_date,
      salary,
      address,
      city,
      state,
      emergency_contact_name,
      emergency_contact_phone,
      status,
      permissions,
      notes,
    } = req.body;

    const allowedRoles = ["owner", "manager", "staff", "receptionist", "accountant", "security", "cleaner", "other"];
    const staffRole = role && allowedRoles.includes(role) ? role : undefined;

    // Update table columns
    const columns = await getUsersColumns();
    const updatePayload = {};

    if (columns && columns.includes("updated_at")) {
      updatePayload.updated_at = new Date().toISOString();
    }

    const setIfSupported = (field, value) => {
      if (!columns || columns.includes(field)) {
        updatePayload[field] = value;
      }
    };

    if (name !== undefined) setIfSupported("name", name);
    if (phone !== undefined) setIfSupported("phone", phone || null);
    if (staffRole !== undefined) setIfSupported("role", staffRole);
    if (department !== undefined) setIfSupported("department", department || "other");
    if (employee_id !== undefined) setIfSupported("employee_id", employee_id || null);
    if (joining_date !== undefined) setIfSupported("joining_date", joining_date || null);

    // Verify payroll SaaS feature is unlocked
    const todayVal = new Date().toISOString().split("T")[0];
    const subscriptionHallIdVal = req.user.primary_hall_id || req.user.hall_id;
    const { data: subVal } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(name)")
      .eq("hall_id", subscriptionHallIdVal)
      .in("status", ["active", "trial"])
      .gte("end_date", todayVal)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const hasPayrollVal = false; // Payroll feature disabled universally

    if (salary !== undefined) {
      if (!hasPayrollVal && Number(salary) > 0) {
        return res.status(403).json({ message: "Salary/Payroll feature is locked under your current SaaS plan." });
      }
      setIfSupported("salary", (salary !== null && hasPayrollVal) ? Number(salary) : 0.00);
    }
    if (address !== undefined) setIfSupported("address", address || null);
    if (city !== undefined) setIfSupported("city", city || null);
    if (state !== undefined) setIfSupported("state", state || null);
    if (emergency_contact_name !== undefined) setIfSupported("emergency_contact_name", emergency_contact_name || null);
    if (emergency_contact_phone !== undefined) setIfSupported("emergency_contact_phone", emergency_contact_phone || null);
    if (status !== undefined) setIfSupported("status", status || "active");
    if (permissions !== undefined) setIfSupported("permissions", permissions || []);
    if (notes !== undefined) setIfSupported("notes", notes || null);

    // Optional email/name sync to Supabase Auth if auth_user_id exists
    if (email && email !== existing.email) {
      updatePayload.email = email;
      if (existing.auth_user_id) {
        try {
          await supabaseAdmin.auth.admin.updateUserById(existing.auth_user_id, {
            email,
            user_metadata: { name: name || existing.name }
          });
        } catch (authErr) {
          console.error("Auth email sync failed:", authErr.message);
        }
      }
    } else if (name && existing.auth_user_id) {
      try {
        await supabaseAdmin.auth.admin.updateUserById(existing.auth_user_id, {
          user_metadata: { name }
        });
      } catch (authErr) {
        console.error("Auth metadata sync failed:", authErr.message);
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from("users")
      .update(updatePayload)
      .eq("id", id);

    if (updateError) return res.status(500).json({ message: updateError.message });

    // Log update activity
    await logActivity({
      hall_id: hall_id === "all" ? (existing.hall_id || req.user.primary_hall_id) : hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "staff.updated",
      entity_type: "staff",
      entity_id: id,
      description: `Updated staff member ${name || existing.name || ""}'s profile details`,
      metadata: { role: staffRole, department, employee_id, status }
    });

    res.json({ message: "Staff profile updated successfully" });
  } catch (err) {
    console.error("updateStaff error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing, error: existError } = await supabaseAdmin
      .from("users")
      .select("id, name, email, hall_id, auth_user_id, role")
      .eq("id", id)
      .maybeSingle();

    if (existError || !existing) return res.status(404).json({ message: "Staff not found" });
    if (existing.role === "owner") return res.status(403).json({ message: "Cannot delete hall owner" });

    // Get all accessible hall IDs for the current user to verify ownership
    const { data: ownerHalls, error: ownerHallsError } = await supabaseAdmin
      .from("user_halls")
      .select("hall_id")
      .eq("user_id", req.user.id);

    if (ownerHallsError) return res.status(500).json({ message: ownerHallsError.message });
    const accessibleHallIds = (ownerHalls || []).map(h => h.hall_id);

    // Verify staff belongs to any of the owner's accessible halls
    const { data: link, error: linkErr } = await supabaseAdmin
      .from("user_halls")
      .select("id")
      .eq("user_id", id)
      .in("hall_id", accessibleHallIds)
      .limit(1)
      .maybeSingle();

    if (linkErr || !link) return res.status(404).json({ message: "Staff not found in your hall" });

    // Delete user halls associations first
    await supabaseAdmin.from("user_halls").delete().eq("user_id", id);

    // Delete user record
    await supabaseAdmin.from("users").delete().eq("id", id);

    if (existing.auth_user_id) {
      await supabaseAdmin.auth.admin.deleteUser(existing.auth_user_id);
    }

    // Log delete activity
    await logActivity({
      hall_id: hall_id === "all" ? (existing.hall_id || req.user.primary_hall_id) : hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "staff.removed",
      entity_type: "staff",
      entity_id: id,
      description: `Removed staff member ${existing.name || ""}`,
      metadata: { email: existing.email, role: existing.role }
    });

    res.json({ message: "Staff deleted successfully" });
  } catch (err) {
    console.error("deleteStaff error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createStaff, getStaff, updateStaff, deleteStaff };