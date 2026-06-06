const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

const mapProfileBodyToDb = (body) => {
  const fields = {};
  if (body.hall_name !== undefined) fields.hall_name = body.hall_name;
  else if (body.hallName !== undefined) fields.hall_name = body.hallName;

  if (body.tagline !== undefined) fields.tagline = body.tagline;
  if (body.description !== undefined) fields.description = body.description;
  if (body.phone !== undefined) fields.phone = body.phone;

  if (body.alternate_phone !== undefined) fields.alternate_phone = body.alternate_phone;
  else if (body.alternatePhone !== undefined) fields.alternate_phone = body.alternatePhone;

  if (body.email !== undefined) fields.email = body.email;
  if (body.website !== undefined) fields.website = body.website;
  if (body.address !== undefined) fields.address = body.address;
  if (body.city !== undefined) fields.city = body.city;
  if (body.state !== undefined) fields.state = body.state;
  if (body.pincode !== undefined) fields.pincode = body.pincode;

  if (body.google_maps_link !== undefined) fields.google_maps_link = body.google_maps_link;
  else if (body.googleMapsLink !== undefined) fields.google_maps_link = body.googleMapsLink;

  if (body.capacity_min !== undefined) fields.capacity_min = body.capacity_min;
  if (body.capacity_max !== undefined) fields.capacity_max = body.capacity_max;

  if (body.established_year !== undefined) fields.established_year = body.established_year;
  else if (body.establishedYear !== undefined) fields.established_year = body.establishedYear;

  if (body.amenities !== undefined) fields.amenities = body.amenities;
  if (body.event_types !== undefined) fields.event_types = body.event_types;

  // New frontend fields
  if (body.owner_name !== undefined) fields.owner_name = body.owner_name;
  else if (body.ownerName !== undefined) fields.owner_name = body.ownerName;

  if (body.country !== undefined) fields.country = body.country;

  if (body.total_capacity !== undefined) fields.total_capacity = body.total_capacity;
  else if (body.totalCapacity !== undefined) fields.total_capacity = body.totalCapacity;

  if (body.gst_number !== undefined) fields.gst_number = body.gst_number;
  else if (body.gstNumber !== undefined) fields.gst_number = body.gstNumber;

  if (body.pan_number !== undefined) fields.pan_number = body.pan_number;
  else if (body.panNumber !== undefined) fields.pan_number = body.panNumber;

  if (body.bank_name !== undefined) fields.bank_name = body.bank_name;
  else if (body.bankName !== undefined) fields.bank_name = body.bankName;

  if (body.account_number !== undefined) fields.account_number = body.account_number;
  else if (body.accountNumber !== undefined) fields.account_number = body.accountNumber;

  if (body.ifsc_code !== undefined) fields.ifsc_code = body.ifsc_code;
  else if (body.ifscCode !== undefined) fields.ifsc_code = body.ifscCode;

  if (body.upi_id !== undefined) fields.upi_id = body.upi_id;
  else if (body.upiId !== undefined) fields.upi_id = body.upiId;

  if (body.hall_sections !== undefined) fields.hall_sections = body.hall_sections;
  else if (body.hallSections !== undefined) fields.hall_sections = body.hallSections;

  return fields;
};

const formatDbProfileToFrontend = (data) => {
  if (!data) return null;
  return {
    ...data,
    hallName: data.hall_name,
    ownerName: data.owner_name || "",
    phone: data.phone,
    alternatePhone: data.alternate_phone || "",
    email: data.email,
    website: data.website || "",
    address: data.address,
    city: data.city,
    state: data.state,
    pincode: data.pincode,
    country: data.country || "India",
    description: data.description || "",
    establishedYear: data.established_year,
    totalCapacity: data.total_capacity || data.capacity_max || 0,
    hallSections: data.hall_sections || [],
    logoUrl: data.logo_url,
    coverImageUrl: data.cover_image_url,
    gstNumber: data.gst_number || "",
    panNumber: data.pan_number || "",
    bankName: data.bank_name || "",
    accountNumber: data.account_number || "",
    ifscCode: data.ifsc_code || "",
    upiId: data.upi_id || "",
  };
};

/* ============================================================
   GET HALL PROFILE
   ============================================================ */
const getHallProfile = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("hall_profiles")
      .select("*")
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });

    // If no profile row exists yet, return the base hall record
    if (!data) {
      const { data: hall, error: hallErr } = await supabaseAdmin
        .from("marriage_halls")
        .select("*")
        .eq("id", hall_id)
        .single();

      if (hallErr) return res.status(404).json({ message: "Hall not found" });
      return res.json({
        ...hall,
        hallName: hall.hall_name,
        phone: hall.phone,
        email: hall.email,
        address: hall.address,
        city: hall.city,
        profile_complete: false
      });
    }

    res.json({ ...formatDbProfileToFrontend(data), profile_complete: true });
  } catch (err) {
    console.error("getHallProfile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CREATE OR UPDATE HALL PROFILE
   Upsert — so owners can call this whether profile exists or not
   ============================================================ */
const upsertHallProfile = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const profileFields = mapProfileBodyToDb(req.body);

    const profileData = {
      ...profileFields,
      hall_id,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("hall_profiles")
      .upsert(profileData, { onConflict: "hall_id" })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Also sync hall_name and phone back to marriage_halls for consistency
    const hallUpdates = {};
    if (profileFields.hall_name) hallUpdates.hall_name = profileFields.hall_name;
    if (profileFields.phone) hallUpdates.phone = profileFields.phone;
    if (profileFields.email) hallUpdates.email = profileFields.email;
    if (profileFields.city) hallUpdates.city = profileFields.city;
    if (profileFields.address) hallUpdates.address = profileFields.address;

    if (Object.keys(hallUpdates).length > 0) {
      await supabaseAdmin
        .from("marriage_halls")
        .update(hallUpdates)
        .eq("id", hall_id);
    }

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "profile.updated",
      entity_type: "profile",
      entity_id: hall_id,
      description: `Updated marriage hall profile details`,
      metadata: { updated_fields: Object.keys(profileFields) },
    });

    res.json({ message: "Hall profile saved successfully", data: formatDbProfileToFrontend(data) });
  } catch (err) {
    console.error("upsertHallProfile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPLOAD HALL LOGO
   Stores file in Supabase Storage bucket "hall-assets"
   ============================================================ */
const uploadLogo = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ message: "Only JPEG, PNG, or WebP images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const fileName = `${hall_id}/logo.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("hall-assets")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) return res.status(500).json({ message: uploadError.message });

    const { data: urlData } = supabaseAdmin.storage
      .from("hall-assets")
      .getPublicUrl(fileName);

    // Add cache-busting query param so browsers reload the new image
    const logo_url = `${urlData.publicUrl}?v=${Date.now()}`;

    await supabaseAdmin
      .from("hall_profiles")
      .upsert({ hall_id, logo_url, updated_at: new Date().toISOString() }, { onConflict: "hall_id" });

    res.json({ message: "Logo uploaded successfully", logo_url });
  } catch (err) {
    console.error("uploadLogo error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPLOAD COVER IMAGE
   ============================================================ */
const uploadCoverImage = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ message: "Only JPEG, PNG, or WebP images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const fileName = `${hall_id}/cover.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("hall-assets")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) return res.status(500).json({ message: uploadError.message });

    const { data: urlData } = supabaseAdmin.storage
      .from("hall-assets")
      .getPublicUrl(fileName);

    const cover_image_url = `${urlData.publicUrl}?v=${Date.now()}`;

    await supabaseAdmin
      .from("hall_profiles")
      .upsert({ hall_id, cover_image_url, updated_at: new Date().toISOString() }, { onConflict: "hall_id" });

    res.json({ message: "Cover image uploaded successfully", cover_image_url });
  } catch (err) {
    console.error("uploadCoverImage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   ADD GALLERY IMAGE
   ============================================================ */
const addGalleryImage = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ message: "Only JPEG, PNG, or WebP images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const fileName = `${hall_id}/gallery/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("hall-assets")
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) return res.status(500).json({ message: uploadError.message });

    const { data: urlData } = supabaseAdmin.storage
      .from("hall-assets")
      .getPublicUrl(fileName);

    // Fetch current gallery array
    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("gallery_images")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const existing = profile?.gallery_images || [];

    if (existing.length >= 20) {
      return res.status(400).json({ message: "Gallery limit reached (max 20 images). Remove an image first." });
    }

    const updated = [...existing, urlData.publicUrl];

    await supabaseAdmin
      .from("hall_profiles")
      .upsert({ hall_id, gallery_images: updated, updated_at: new Date().toISOString() }, { onConflict: "hall_id" });

    res.json({
      message: "Gallery image added",
      image_url: urlData.publicUrl,
      total_images: updated.length,
    });
  } catch (err) {
    console.error("addGalleryImage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   REMOVE GALLERY IMAGE
   ============================================================ */
const removeGalleryImage = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { image_url } = req.body;

    if (!image_url) return res.status(400).json({ message: "image_url is required" });

    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("gallery_images")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const updated = (profile?.gallery_images || []).filter((u) => u !== image_url);

    await supabaseAdmin
      .from("hall_profiles")
      .update({ gallery_images: updated, updated_at: new Date().toISOString() })
      .eq("hall_id", hall_id);

    // Delete from Supabase Storage
    try {
      const url = new URL(image_url);
      const filePath = decodeURIComponent(url.pathname).split("/hall-assets/")[1];
      if (filePath) {
        await supabaseAdmin.storage.from("hall-assets").remove([filePath]);
      }
    } catch (_) {
      // Non-critical — image removed from DB even if storage delete fails
    }

    res.json({ message: "Gallery image removed", remaining: updated.length });
  } catch (err) {
    console.error("removeGalleryImage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getHallProfile,
  upsertHallProfile,
  uploadLogo,
  uploadCoverImage,
  addGalleryImage,
  removeGalleryImage,
};