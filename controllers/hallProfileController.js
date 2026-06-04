const { supabaseAdmin } = require("../config/supabase");

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
      return res.json({ ...hall, profile_complete: false });
    }

    res.json({ ...data, profile_complete: true });
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

    const {
      hall_name,
      tagline,
      description,
      phone,
      alternate_phone,
      email,
      website,
      address,
      city,
      state,
      pincode,
      google_maps_link,
      capacity_min,
      capacity_max,
      established_year,
      amenities,        // array e.g. ["AC", "Parking", "Catering"]
      event_types,      // array e.g. ["Wedding", "Reception", "Birthday"]
    } = req.body;

    const profileData = {
      hall_id,
      hall_name,
      tagline,
      description,
      phone,
      alternate_phone,
      email,
      website,
      address,
      city,
      state,
      pincode,
      google_maps_link,
      capacity_min,
      capacity_max,
      established_year,
      amenities: amenities || [],
      event_types: event_types || [],
      updated_at: new Date().toISOString(),
    };

    // Remove undefined keys so we don't overwrite with null
    Object.keys(profileData).forEach(
      (k) => profileData[k] === undefined && delete profileData[k]
    );

    const { data, error } = await supabaseAdmin
      .from("hall_profiles")
      .upsert(profileData, { onConflict: "hall_id" })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Also sync hall_name and phone back to marriage_halls for consistency
    const hallUpdates = {};
    if (hall_name) hallUpdates.hall_name = hall_name;
    if (phone) hallUpdates.phone = phone;
    if (email) hallUpdates.email = email;
    if (city) hallUpdates.city = city;
    if (address) hallUpdates.address = address;

    if (Object.keys(hallUpdates).length > 0) {
      await supabaseAdmin
        .from("marriage_halls")
        .update(hallUpdates)
        .eq("id", hall_id);
    }

    res.json({ message: "Hall profile saved successfully", data });
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