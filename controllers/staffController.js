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
    const hall_id = req.user.hall_id;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, and password are required" });
    }

    const allowedRoles = ["manager", "staff"];
    const staffRole = allowedRoles.includes(role) ? role : "staff";

    // ---- 1. Check active subscription + user limit ----
    const today = new Date().toISOString().split("T")[0];

    const { data: sub, error: subError } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(max_users, name)")
      .eq("hall_id", hall_id)
      .eq("status", "active")
      .gte("end_date", today)
      .maybeSingle();

    if (subError || !sub) {
      return res.status(403).json({ message: "No active subscription found" });
    }

    const maxUsers = sub.packages?.max_users;

    if (maxUsers !== null && maxUsers !== undefined) {
      const { count } = await supabaseAdmin
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("hall_id", hall_id);

      if (count >= maxUsers) {
        return res.status(403).json({
          message: `User limit reached. Your ${sub.packages.name} plan allows a maximum of ${maxUsers} users. Please upgrade your plan.`,
        });
      }
    }

    // ---- 2. Create Supabase Auth user via signUp (auto-sends confirmation email) ----
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, role: staffRole, hall_id },
      },
    });

    if (authError || !authData?.user) {
      return res.status(400).json({ message: authError?.message || "Auth user creation failed" });
    }

    // ---- 3. Insert into users table ----
    const columns = await getUsersColumns();
    
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
    addIfSupported("salary", salary !== undefined ? Number(salary) : 0.00);
    addIfSupported("address", address || null);
    addIfSupported("city", city || null);
    addIfSupported("state", state || null);
    addIfSupported("emergency_contact_name", emergency_contact_name || null);
    addIfSupported("emergency_contact_phone", emergency_contact_phone || null);
    addIfSupported("status", status || "active");
    addIfSupported("permissions", permissions || []);
    addIfSupported("notes", notes || null);

    const selectFields = columns
      ? ["id", "name", "email", "role", "hall_id", "created_at"].concat(
          ["phone", "department", "employee_id", "joining_date", "salary", "address", "city", "state", "emergency_contact_name", "emergency_contact_phone", "status", "permissions", "notes"].filter(f => columns.includes(f))
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
      message: `Staff created. A confirmation email has been sent to ${email}.`,
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
      "permissions", "notes", "created_at", "updated_at"
    ];
    const selectFields = columns
      ? requestedFields.filter(f => columns.includes(f)).join(", ")
      : requestedFields.filter(f => f !== "updated_at").join(", ");

    let query = supabaseAdmin
      .from("users")
      .select(selectFields)
      .eq("hall_id", hall_id);

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
    res.json(data);
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
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (existError || !existing) {
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
    if (salary !== undefined) setIfSupported("salary", salary !== null ? Number(salary) : 0.00);
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
      hall_id,
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

    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id, name, email, hall_id, auth_user_id, role")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Staff not found in your hall" });
    if (existing.role === "owner") return res.status(403).json({ message: "Cannot delete hall owner" });

    await supabaseAdmin.from("users").delete().eq("id", id);

    if (existing.auth_user_id) {
      await supabaseAdmin.auth.admin.deleteUser(existing.auth_user_id);
    }

    // Log delete activity
    await logActivity({
      hall_id,
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