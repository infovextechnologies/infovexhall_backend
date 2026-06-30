const { supabaseAdmin } = require("../config/supabase");

const createPackage = async (req, res) => {
  const { name, price, setup_fee, billing_cycle, max_users, max_bookings, features } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: "name and price are required" });
  }

  const { data, error } = await supabaseAdmin
    .from("packages")
    .insert([{ name, price, setup_fee: setup_fee || 0, billing_cycle: billing_cycle || "monthly", max_users, max_bookings, features }])
    .select()
    .single();

  if (error) return res.status(500).json({ message: error.message });

  res.status(201).json({ message: "Package created", data });
};

const getPackages = async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("packages")
    .select("*")
    .order("price", { ascending: true });

  if (error) return res.status(500).json({ message: error.message });
  res.json(data);
};

const updatePackage = async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const { error } = await supabaseAdmin
    .from("packages")
    .update(updates)
    .eq("id", id);

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Package updated" });
};

const deletePackage = async (req, res) => {
  const { id } = req.params;

  // Check if any halls are using this package
  const { count } = await supabaseAdmin
    .from("hall_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("package_id", id)
    .in("status", ["active", "trial"]);

  if (count > 0) {
    return res.status(400).json({
      message: `Cannot delete: ${count} active subscription(s) using this package`,
    });
  }

  const { error } = await supabaseAdmin.from("packages").delete().eq("id", id);
  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Package deleted" });
};

module.exports = { createPackage, getPackages, updatePackage, deletePackage };