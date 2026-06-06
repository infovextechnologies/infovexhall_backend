const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

const getVendorFields = (body) => {
  const fields = {};
  if (body.vendor_name !== undefined) fields.vendor_name = body.vendor_name;
  else if (body.name !== undefined) fields.vendor_name = body.name;

  if (body.service_type !== undefined) fields.service_type = body.service_type;
  else if (body.category !== undefined) fields.service_type = body.category;

  if (body.phone !== undefined) fields.phone = body.phone;

  if (body.alternate_phone !== undefined) fields.alternate_phone = body.alternate_phone;
  else if (body.alternatePhone !== undefined) fields.alternate_phone = body.alternatePhone;

  if (body.email !== undefined) fields.email = body.email;
  if (body.address !== undefined) fields.address = body.address;
  if (body.city !== undefined) fields.city = body.city;
  if (body.state !== undefined) fields.state = body.state;

  if (body.gst_number !== undefined) fields.gst_number = body.gst_number;
  else if (body.gstNumber !== undefined) fields.gst_number = body.gstNumber;

  if (body.bank_name !== undefined) fields.bank_name = body.bank_name;
  else if (body.bankName !== undefined) fields.bank_name = body.bankName;

  if (body.account_number !== undefined) fields.account_number = body.account_number;
  else if (body.accountNumber !== undefined) fields.account_number = body.accountNumber;

  if (body.ifsc_code !== undefined) fields.ifsc_code = body.ifsc_code;
  else if (body.ifscCode !== undefined) fields.ifsc_code = body.ifscCode;

  if (body.upi_id !== undefined) fields.upi_id = body.upi_id;
  else if (body.upiId !== undefined) fields.upi_id = body.upiId;

  if (body.contact_person_name !== undefined) fields.contact_person_name = body.contact_person_name;
  else if (body.contactPersonName !== undefined) fields.contact_person_name = body.contactPersonName;

  if (body.contact_person_phone !== undefined) fields.contact_person_phone = body.contact_person_phone;
  else if (body.contactPersonPhone !== undefined) fields.contact_person_phone = body.contactPersonPhone;

  if (body.rating !== undefined) fields.rating = body.rating;
  if (body.rate !== undefined) {
    fields.rate = body.rate;
    if (fields.rating === undefined) fields.rating = body.rate;
  }
  if (body.status !== undefined) fields.status = body.status;

  if (body.tags !== undefined) {
    fields.tags = Array.isArray(body.tags) ? body.tags : [];
  }

  if (body.notes !== undefined) fields.notes = body.notes;

  return fields;
};

/* ============================================================
   CREATE VENDOR
   ============================================================ */
const createVendor = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const fields = getVendorFields(req.body);
    const { vendor_name, service_type } = fields;

    if (!vendor_name || !service_type) {
      return res.status(400).json({ message: "vendor_name (or name) and service_type (or category) are required" });
    }

    const { data, error } = await supabaseAdmin
      .from("vendors")
      .insert([{ ...fields, hall_id }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.created",
      entity_type: "vendor",
      entity_id: data.id,
      description: `Added vendor profile for ${vendor_name} (${service_type})`,
      metadata: { service_type },
    });

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
    const fields = getVendorFields(req.body);

    const { data: existing } = await supabaseAdmin
      .from("vendors")
      .select("id, vendor_name")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Vendor not found in your hall" });

    const { error } = await supabaseAdmin.from("vendors").update(fields).eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.updated",
      entity_type: "vendor",
      entity_id: id,
      description: `Updated vendor details for ${existing.vendor_name}`,
      metadata: { updated_fields: Object.keys(fields) },
    });

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
      .select("id, vendor_name")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Vendor not found in your hall" });

    const { error } = await supabaseAdmin.from("vendors").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.deleted",
      entity_type: "vendor",
      entity_id: id,
      description: `Removed vendor profile for ${existing.vendor_name}`,
    });

    res.json({ message: "Vendor deleted successfully" });
  } catch (err) {
    console.error("deleteVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createVendor, getVendors, getVendorById, updateVendor, deleteVendor };