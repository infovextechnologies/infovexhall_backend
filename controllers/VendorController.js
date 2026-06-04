const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   CREATE VENDOR
   ============================================================ */
const createVendor = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { vendor_name, service_type, phone, email, address, notes, rate } = req.body;

    if (!vendor_name || !service_type) {
      return res.status(400).json({ message: "vendor_name and service_type are required" });
    }

    const validServiceTypes = ["catering", "decoration", "photography", "music", "lighting", "transport", "other"];

    const { data, error } = await supabaseAdmin
      .from("vendors")
      .insert([{ hall_id, vendor_name, service_type, phone, email, address, notes, rate }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: "Vendor created successfully", data });
  } catch (err) {
    console.error("createVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL VENDORS
   ============================================================ */
const getVendors = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { service_type, search } = req.query;

    let query = supabaseAdmin
      .from("vendors")
      .select("*")
      .eq("hall_id", hall_id)
      .order("vendor_name", { ascending: true });

    if (service_type) query = query.eq("service_type", service_type);
    if (search) query = query.ilike("vendor_name", `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    res.json(data);
  } catch (err) {
    console.error("getVendors error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET VENDOR BY ID
   ============================================================ */
const getVendorById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("vendors")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Vendor not found" });

    res.json(data);
  } catch (err) {
    console.error("getVendorById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE VENDOR
   ============================================================ */
const updateVendor = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { vendor_name, service_type, phone, email, address, notes, rate } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Vendor not found in your hall" });

    const updates = {};
    if (vendor_name !== undefined) updates.vendor_name = vendor_name;
    if (service_type !== undefined) updates.service_type = service_type;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (address !== undefined) updates.address = address;
    if (notes !== undefined) updates.notes = notes;
    if (rate !== undefined) updates.rate = rate;

    const { error } = await supabaseAdmin.from("vendors").update(updates).eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Vendor updated successfully" });
  } catch (err) {
    console.error("updateVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE VENDOR
   ============================================================ */
const deleteVendor = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Vendor not found in your hall" });

    const { error } = await supabaseAdmin.from("vendors").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Vendor deleted successfully" });
  } catch (err) {
    console.error("deleteVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createVendor, getVendors, getVendorById, updateVendor, deleteVendor };