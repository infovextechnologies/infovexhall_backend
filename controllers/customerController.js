const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   CREATE CUSTOMER
   ============================================================ */
const createCustomer = async (req, res) => {
  try {
    const { customer_name, phone, email, address, notes, city, state, gst_number, company_name, vip_status } = req.body;
    const hall_id = req.user.hall_id;

    if (!customer_name) {
      return res.status(400).json({ message: "customer_name is required" });
    }

    // Check for duplicate phone within same hall
    if (phone) {
      const { data: existing } = await supabaseAdmin
        .from("customers")
        .select("id")
        .eq("hall_id", hall_id)
        .eq("phone", phone)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({ message: "A customer with this phone number already exists in your hall" });
      }
    }

    const { data, error } = await supabaseAdmin
      .from("customers")
      .insert([{ 
        hall_id, 
        customer_name, 
        phone, 
        email, 
        address, 
        notes,
        city,
        state,
        gst_number,
        company_name,
        vip_status: vip_status ?? false
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: "Customer created successfully", data });
  } catch (err) {
    console.error("createCustomer error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL CUSTOMERS (with optional search)
   ============================================================ */
const getCustomers = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("customers")
      .select("*, bookings(id, event_name, start_date, status)", { count: "exact" })
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (search) {
      query = query.or(`customer_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%,company_name.ilike.%${search}%,gst_number.ilike.%${search}%,city.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ message: error.message });

    res.json({
      data,
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getCustomers error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET CUSTOMER BY ID
   ============================================================ */
const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("customers")
      .select(`
        *,
        bookings (
          id, event_name, event_type, start_date, end_date,
          total_amount, advance_amount, status,
          payments ( id, amount, payment_method, payment_date )
        )
      `)
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Customer not found" });

    res.json(data);
  } catch (err) {
    console.error("getCustomerById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE CUSTOMER
   ============================================================ */
const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { customer_name, phone, email, address, notes, city, state, gst_number, company_name, vip_status } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Customer not found in your hall" });

    const { error } = await supabaseAdmin
      .from("customers")
      .update({ 
        customer_name, 
        phone, 
        email, 
        address, 
        notes,
        city,
        state,
        gst_number,
        company_name,
        vip_status
      })
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Customer updated successfully" });
  } catch (err) {
    console.error("updateCustomer error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE CUSTOMER
   ============================================================ */
const deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Customer not found in your hall" });

    // Check for active bookings
    const { count } = await supabaseAdmin
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", id)
      .in("status", ["pending", "confirmed"]);

    if (count > 0) {
      return res.status(400).json({
        message: `Cannot delete: customer has ${count} active booking(s). Cancel them first.`,
      });
    }

    // Fetch all bookings for this customer
    const { data: bookings } = await supabaseAdmin
      .from("bookings")
      .select("id")
      .eq("customer_id", id);

    const bookingIds = (bookings || []).map((b) => b.id);

    if (bookingIds.length > 0) {
      // 1. Delete vendor allocations for all these bookings
      await supabaseAdmin
        .from("booking_vendors")
        .delete()
        .in("booking_id", bookingIds);

      // 2. Delete events for all these bookings
      await supabaseAdmin
        .from("events")
        .delete()
        .in("booking_id", bookingIds);

      // 3. Delete payments for all these bookings
      await supabaseAdmin
        .from("payments")
        .delete()
        .in("booking_id", bookingIds);

      // 4. Delete invoices for all these bookings
      await supabaseAdmin
        .from("invoices")
        .delete()
        .in("booking_id", bookingIds);

      // 5. Finally, delete the bookings themselves
      await supabaseAdmin
        .from("bookings")
        .delete()
        .in("id", bookingIds);
    }

    const { error } = await supabaseAdmin.from("customers").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Customer deleted successfully" });
  } catch (err) {
    console.error("deleteCustomer error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   LOG CUSTOMER CRM INTERACTION
   ============================================================ */
const logCustomerInteraction = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, notes } = req.body;
    const hall_id = req.user.hall_id;
    const user_id = req.user.id;
    const user_name = req.user.name || "Staff";

    if (!type || !notes) {
      return res.status(400).json({ message: "type and notes are required" });
    }

    const { data: customer } = await supabaseAdmin
      .from("customers")
      .select("customer_name")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!customer) {
      return res.status(404).json({ message: "Customer not found in your hall" });
    }

    // Log this action using the activity logger helper
    const { logActivity } = require("./activityLogController");
    await logActivity({
      hall_id,
      user_id,
      user_name,
      action: "customer.interaction",
      entity_type: "customer",
      entity_id: id,
      description: `Logged CRM interaction (${type}): ${notes}`,
      metadata: { type, notes, customer_name: customer.customer_name },
    });

    res.status(201).json({ message: "Interaction logged successfully" });
  } catch (err) {
    console.error("logCustomerInteraction error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { 
  createCustomer, 
  getCustomers, 
  getCustomerById, 
  updateCustomer, 
  deleteCustomer,
  logCustomerInteraction
};